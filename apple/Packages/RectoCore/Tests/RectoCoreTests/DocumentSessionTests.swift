import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("DocumentSession")
struct DocumentSessionTests {
  @Test("a commit writes node, head and outbox job in one transaction")
  func commitIsOneTransaction() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(
      markdown: "hello", selection: NodeSelection(anchor: 5, head: 5), structural: true)

    let document = try #require(try await harness.store.document(localId: localId))
    #expect(document.markdown == "hello")
    #expect(document.localHeadNodeId != "")
    let nodes = try await harness.store.nodes(documentLocalId: localId)
    #expect(nodes.count == 2)
    #expect(nodes.last?.nodeId == document.localHeadNodeId)
    // createDocument + commitEdit
    #expect(try await harness.store.pendingJobs(documentLocalId: localId).count == 2)
  }

  @Test("fast typing coalesces into one node; a pause opens the next")
  func groupingDrivesNodes() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let clock = TestClock(start: 1_000)
    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
      now: clock.read, schedulesTimers: false)
    try await session.open()

    for (index, text) in ["h", "he", "hel", "hell", "hello"].enumerated() {
      clock.advance(by: Double(index) == 0 ? 0 : 40)
      try await session.applyLocalChange(markdown: text, selection: nil)
    }
    #expect(try await harness.store.nodes(documentLocalId: localId).count == 1)

    clock.advance(by: 900)
    try await session.applyLocalChange(markdown: "hello ", selection: nil)
    // The pause closed "hello" as its own node.
    #expect(try await harness.store.nodes(documentLocalId: localId).count == 2)
    #expect(try await harness.store.document(localId: localId)?.markdown == "hello")

    try await session.flush()
    #expect(try await harness.store.nodes(documentLocalId: localId).count == 3)
    #expect(try await harness.store.document(localId: localId)?.markdown == "hello ")
  }

  @Test("undo and redo are pointer moves that never grow the tree")
  func undoRedo() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "one", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "one two", selection: nil, structural: true)
    let afterEdits = try await harness.store.nodes(documentLocalId: localId).count
    #expect(afterEdits == 3)

    #expect(try await session.undo())
    #expect(try await harness.store.document(localId: localId)?.markdown == "one")
    #expect(try await session.undo())
    #expect(try await harness.store.document(localId: localId)?.markdown == "")
    // At the root there is nowhere further back.
    #expect(try await session.undo() == false)

    #expect(try await session.redo())
    #expect(try await harness.store.document(localId: localId)?.markdown == "one")
    #expect(try await session.redo())
    #expect(try await harness.store.document(localId: localId)?.markdown == "one two")
    #expect(try await session.redo() == false)

    #expect(try await harness.store.nodes(documentLocalId: localId).count == afterEdits)
  }

  @Test("editing after an undo branches instead of overwriting")
  func branchesAfterUndo() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "original", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "original edited", selection: nil, structural: true)
    #expect(try await session.undo())
    try await session.applyLocalChange(markdown: "original rewritten", selection: nil, structural: true)

    let nodes = try await harness.store.nodes(documentLocalId: localId)
    // root + original + edited + rewritten: the abandoned branch is still there.
    #expect(nodes.count == 4)
    let markdowns = try await withThrowingTaskGroup(of: String.self) { group -> [String] in
      for node in nodes {
        group.addTask {
          try await harness.store.materializedMarkdown(
            documentLocalId: localId, nodeId: node.nodeId)
        }
      }
      return try await group.reduce(into: []) { $0.append($1) }
    }
    #expect(Set(markdowns).contains("original edited"))
    #expect(Set(markdowns).contains("original rewritten"))
  }

  @Test("the debounced draft row survives a crash between keystroke and boundary")
  func draftRowSurvives() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let localId: String

    do {
      let harness = try Harness(directory: directory, transport: InMemoryTransport())
      localId = try await harness.createLocalDocument()
      let session = DocumentSession(
        documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
        schedulesTimers: false)
      try await session.open()
      try await session.applyLocalChange(markdown: "half a sen", selection: nil)
      // The debounce fires; no node boundary has been reached.
      await session.writeDraft(markdown: "half a sen", selection: NodeSelection(anchor: 10, head: 10))
      // The process dies here — no flush, no commit.
    }

    let reopened = try Harness(directory: directory, transport: InMemoryTransport())
    let document = try #require(try await reopened.store.document(localId: localId))
    #expect(document.draftMarkdown == "half a sen")
    #expect(document.displayMarkdown == "half a sen")
    #expect(document.markdown == "")
  }

  @Test("two windows on one document share a single session")
  func twoWindowsShareState() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    // Two DocumentSessions here would each hold a GroupingController seeded at
    // the same head and fork the tree on every keystroke; the registry is what
    // makes the orchestrator's "same doc in two windows" decision safe.
    let windowA = try await harness.registry.session(for: localId)
    let windowB = try await harness.registry.session(for: localId)
    #expect(windowA === windowB)

    try await windowA.applyLocalChange(markdown: "typed in A", selection: nil, structural: true)
    #expect(await windowB.currentState?.markdown == "typed in A")

    await harness.registry.release(localId)
    // Still open in the other window.
    #expect(await harness.registry.openDocumentIds == [localId])
    await harness.registry.release(localId)
    #expect(await harness.registry.openDocumentIds.isEmpty)
  }

  @Test("state carries what the UI needs, including divergence")
  func statePayload() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
      schedulesTimers: false)
    try await session.open()
    var state = try #require(await session.currentState)
    #expect(state.canUndo == false)
    #expect(state.canRedo == false)
    #expect(state.divergence == nil)

    try await session.applyLocalChange(markdown: "words here", selection: nil, structural: true)
    state = try #require(await session.currentState)
    #expect(state.canUndo)
    #expect(state.wordCount == 2)
    #expect(state.syncState == .pending)
  }
}

/// A clock the test moves by hand, so grouping boundaries are exact rather than
/// a race against a sleep.
final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Double

  init(start: Double) { value = start }

  var read: @Sendable () -> Double {
    { [self] in
      lock.lock()
      defer { lock.unlock() }
      return value
    }
  }

  func advance(by milliseconds: Double) {
    lock.lock()
    value += milliseconds
    lock.unlock()
  }
}
