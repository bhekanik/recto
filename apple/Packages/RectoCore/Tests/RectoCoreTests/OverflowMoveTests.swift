import Foundation
import RectoStore
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("moving text between a draft and Overflow")
struct OverflowMoveTests {
  private struct Fixture {
    let directory: URL
    let harness: Harness
    let localId: String
    let session: DocumentSession

    func draft() async throws -> String? { try await harness.store.document(localId: localId)?.markdown }
    func notes() throws -> String { try harness.store.overflow(localId: localId).markdown }
    func head() async throws -> String? { try await harness.store.document(localId: localId)?.localHeadNodeId }
    func nodeCount() async throws -> Int { try await harness.store.nodes(documentLocalId: localId).count }
    func writeNotes(_ markdown: String) throws {
      let generation = try harness.store.overflow(localId: localId).generation
      _ = try harness.store.saveOverflow(localId: localId, markdown: markdown, expectedGeneration: generation)
    }
  }

  private func open(draft: String, notes: String) async throws -> Fixture {
    let directory = Harness.makeDirectory()
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()
    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: draft, selection: nil, structural: true)
    let fixture = Fixture(directory: directory, harness: harness, localId: localId, session: session)
    if !notes.isEmpty { try fixture.writeNotes(notes) }
    return fixture
  }

  private func range(of text: String, in markdown: String) -> NSRange {
    (markdown as NSString).range(of: text)
  }

  @Test("stash and restore are one history step each, and undo reverses both buffers")
  func stashRestoreUndo() async throws {
    let draft = "Keep.\n\nCut.\n\nEnd."
    let f = try await open(draft: draft, notes: "note")
    defer { try? FileManager.default.removeItem(at: f.directory) }
    let beforeStash = try #require(try await f.head())
    let nodes = try await f.nodeCount()

    #expect(try await f.session.moveToOverflow(expectedMarkdown: draft, range: range(of: "Cut.\n\n", in: draft)))
    #expect(try await f.draft() == "Keep.\n\nEnd.")
    #expect(try f.notes() == "note\n\nCut.\n\n")
    #expect(try await f.nodeCount() == nodes + 1)

    let stashed = try f.harness.store.overflow(localId: f.localId)
    let notesRange = range(of: "Cut.\n\n", in: stashed.markdown)
    #expect(try await f.session.moveFromOverflow(
      expectedMarkdown: "Keep.\n\nEnd.", replacing: NSRange(location: 7, length: 0),
      notesText: "Cut.\n\n", notesLocation: notesRange.location, notesGeneration: stashed.generation))
    #expect(try await f.draft() == draft)
    #expect(try f.notes() == "note\n\n")
    let afterRestore = try #require(try await f.head())

    #expect(try await f.session.undo())
    #expect(try await f.draft() == "Keep.\n\nEnd.")
    #expect(try f.notes() == "note\n\nCut.\n\n")
    #expect(try await f.session.undo())
    #expect(try await f.draft() == draft)
    #expect(try f.notes() == "note")
    #expect(try await f.session.redo())
    #expect(try await f.draft() == "Keep.\n\nEnd.")
    #expect(try f.notes() == "note\n\nCut.\n\n")

    // A history jump crosses both moves in one transaction.
    try await f.session.navigate(to: afterRestore)
    #expect(try await f.draft() == draft)
    #expect(try f.notes() == "note\n\n")
    try await f.session.navigate(to: beforeStash)
    #expect(try await f.draft() == draft)
    #expect(try f.notes() == "note")
  }

  @Test("notes typed after a stash survive its undo, and edited stashed text is never duplicated")
  func independentNotes() async throws {
    let draft = "Keep. Cut."
    let f = try await open(draft: draft, notes: "note")
    defer { try? FileManager.default.removeItem(at: f.directory) }

    #expect(try await f.session.moveToOverflow(expectedMarkdown: draft, range: range(of: " Cut.", in: draft)))
    #expect(try f.notes() == "note\n\n Cut.")
    try f.writeNotes("idea\nnote\n\n Cut.")

    #expect(try await f.session.undo())
    #expect(try await f.draft() == draft)
    #expect(try f.notes() == "idea\nnote")
    #expect(try await f.session.redo())
    #expect(try await f.draft() == "Keep.")
    #expect(try f.notes() == "idea\nnote\n\n Cut.")

    try f.writeNotes("idea\nnote\n\n Cut!")
    #expect(try await f.session.undo())
    #expect(try await f.draft() == draft)
    #expect(try f.notes() == "idea\nnote\n\n Cut!")
    #expect(try await f.session.redo())
    #expect(try f.notes() == "idea\nnote\n\n Cut!")
  }

  @Test("a stale selection, a changed note or a full Overflow refuses without writing")
  func refusals() async throws {
    let draft = "Keep. Cut."
    let f = try await open(draft: draft, notes: "note")
    defer { try? FileManager.default.removeItem(at: f.directory) }
    let nodes = try await f.nodeCount()

    #expect(try await f.session.moveToOverflow(expectedMarkdown: "Keep. Cut!", range: NSRange(location: 5, length: 5)) == false)
    let generation = try f.harness.store.overflow(localId: f.localId).generation
    await #expect(throws: OverflowError.self) {
      try await f.session.moveFromOverflow(
        expectedMarkdown: draft, replacing: NSRange(location: 0, length: 0),
        notesText: "note", notesLocation: 0, notesGeneration: generation - 1)
    }
    try f.writeNotes(String(repeating: "x", count: 65_530))
    await #expect(throws: OverflowError.self) {
      try await f.session.moveToOverflow(expectedMarkdown: draft, range: range(of: " Cut.", in: draft))
    }
    #expect(try await f.draft() == draft)
    #expect(try await f.nodeCount() == nodes)
    #expect(try f.notes() == String(repeating: "x", count: 65_530))
  }

  @Test("a relaunch after a stash finds both halves and both queued for sync")
  func relaunch() async throws {
    let draft = "Keep. Cut."
    let f = try await open(draft: draft, notes: "")
    defer { try? FileManager.default.removeItem(at: f.directory) }
    #expect(try await f.session.moveToOverflow(expectedMarkdown: draft, range: range(of: " Cut.", in: draft)))

    let reopened = try Harness(directory: f.directory, transport: InMemoryTransport())
    #expect(try await reopened.store.document(localId: f.localId)?.markdown == "Keep.")
    #expect(try reopened.store.overflow(localId: f.localId).markdown == " Cut.")
    #expect(try await reopened.store.documentsWithUnsyncedOverflow().map(\.localId) == [f.localId])
    #expect(try await reopened.store.pendingJobs().contains { $0.kind == .commitEdit })
  }
}
