import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("alternatives ride the history")
struct WritingStateSessionTests {
  private let draft = "Much of the tension in design."

  private func ids() -> () -> String {
    var count = 0
    return { count += 1; return "w\(count)" }
  }

  private func openLocal(_ markdown: String) async throws -> (URL, Harness, String, DocumentSession) {
    let directory = Harness.makeDirectory()
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()
    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test", schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: markdown, selection: nil, structural: true)
    return (directory, harness, localId, session)
  }

  private func addPressure(_ session: DocumentSession, to markdown: String) async throws -> WritingState {
    let range = (markdown as NSString).range(of: "tension")
    let state = try #require(WritingState().adding(
      "pressure", author: .human, scope: .word, at: range, in: markdown, newId: ids()))
    #expect(try await session.applyWriting(expectedMarkdown: markdown, writing: state))
    return state
  }

  @Test("adding a wording and choosing it are undoable steps that keep text and alternatives together")
  func addChooseUndo() async throws {
    let (directory, harness, localId, session) = try await openLocal(draft)
    defer { try? FileManager.default.removeItem(at: directory) }
    let nodes = try await harness.store.nodes(documentLocalId: localId).count

    let added = try await addPressure(session, to: draft)
    #expect(try await harness.store.nodes(documentLocalId: localId).count == nodes + 1)
    #expect(await session.currentState?.markdown == draft)
    #expect(await session.currentState?.writing == added)

    let group = added.alternatives[0]
    let choice = try #require(added.choosing(group.candidates[1].id, in: group.id, markdown: draft))
    #expect(try await session.applyWriting(
      expectedMarkdown: draft, replacing: choice.range, with: choice.text, writing: choice.state))
    #expect(await session.currentState?.markdown == "Much of the pressure in design.")
    #expect(await session.currentState?.writing.alternatives.first?.isOnOriginal == false)

    #expect(try await session.undo())
    #expect(await session.currentState?.markdown == draft)
    #expect(await session.currentState?.writing == added)
    #expect(try await session.undo())
    #expect(await session.currentState?.writing.isEmpty == true)
    #expect(try await session.redo())
    #expect(await session.currentState?.writing == added)
  }

  @Test("typing beside and inside a passage keeps it, even inside one grouped node")
  func typing() async throws {
    let (directory, harness, localId, session) = try await openLocal(draft)
    defer { try? FileManager.default.removeItem(at: directory) }
    _ = try await addPressure(session, to: draft)
    let nodes = try await harness.store.nodes(documentLocalId: localId).count

    // The word's last letter, then a letter just after the word: adjacent, so
    // one node. Its single patch would fold the "s" into the word; the writer
    // typed it outside.
    try await session.applyLocalChange(markdown: "Much of the tensiom in design.", selection: nil)
    try await session.applyLocalChange(markdown: "Much of the tensioms in design.", selection: nil)
    try await session.flush()
    #expect(try await harness.store.nodes(documentLocalId: localId).count == nodes + 1)
    let group = try #require(await session.currentState?.writing.alternatives.first)
    #expect(!group.detached)
    #expect(group.active?.text == "tensiom")
    #expect(group.candidates[1].text == "pressure")

    #expect(try await session.undo())
    #expect(await session.currentState?.markdown == draft)
    #expect(await session.currentState?.writing.alternatives.first?.active?.text == "tension")
    #expect(try await session.redo())
    #expect(await session.currentState?.writing.alternatives.first?.active?.text == "tensiom")

    // Typing before the word on its own derives through the patch, storing nothing.
    try await session.applyLocalChange(markdown: "So much of the tensioms in design.", selection: nil, structural: true)
    let last = try #require(try await harness.store.nodes(documentLocalId: localId).max { $0.createdAt < $1.createdAt })
    #expect(last.writing == nil)
    #expect(await session.currentState?.writing.alternatives.first?.location == group.location + 3)
  }

  @Test("a stale view refuses, and a relaunch reads the alternatives back")
  func staleAndRelaunch() async throws {
    let (directory, _, localId, session) = try await openLocal(draft)
    defer { try? FileManager.default.removeItem(at: directory) }
    #expect(try await session.applyWriting(expectedMarkdown: "Other text.", writing: WritingState()) == false)
    let added = try await addPressure(session, to: draft)

    let reopened = try Harness(directory: directory, transport: InMemoryTransport())
    let again = DocumentSession(
      documentLocalId: localId, store: reopened.store, sync: nil, origin: "test", schedulesTimers: false)
    try await again.open()
    #expect(await again.currentState?.writing == added)
  }

  @Test("alternatives sync to another Mac, and an older client's edit shifts them instead of erasing them")
  func syncAndOlderClients() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "Draft")
    _ = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: draft)
    let first = Harness.makeDirectory(), second = Harness.makeDirectory()
    defer {
      try? FileManager.default.removeItem(at: first)
      try? FileManager.default.removeItem(at: second)
    }
    let mac = try Harness(directory: first, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)
    let session = try await mac.registry.session(for: localId)
    let added = try await addPressure(session, to: draft)
    await mac.sync.drainNow()

    // A client that knows nothing about alternatives types before the word.
    let head = try #require(await server.getDocument(documentId: seeded.documentId)?.currentNodeId)
    _ = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: head, markdown: "So much of the tension in design.")

    let other = try Harness(directory: second, transport: server, origin: "other-mac")
    let otherId = try await other.adoptRemoteDocument(seeded)
    let otherSession = try await other.registry.session(for: otherId)
    let state = try #require(await otherSession.currentState)
    #expect(state.markdown == "So much of the tension in design.")
    let group = try #require(state.writing.alternatives.first)
    #expect(!group.detached)
    #expect((state.markdown as NSString).substring(with: group.range) == "tension")
    #expect(group.candidates.map(\.text) == added.alternatives[0].candidates.map(\.text))
  }
}
