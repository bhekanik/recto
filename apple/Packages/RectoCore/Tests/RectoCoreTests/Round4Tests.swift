import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("round-4 repros")
struct Round4Tests {
  // MARK: - new 1. A remote title must not revert a local edit

  @Test("a remote title change does not erase a concurrent draft or head")
  func titleUpdateDoesNotClobberLocalWork() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "before")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    try await mac.sync.mirrorLibrary(await server.summaries())
    let localId = try #require(try await mac.store.documents().first?.localId)

    // `mirrorLibrary` reads its copy of the row; the session then writes.
    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "committed", selection: nil, structural: true)
    await session.writeDraft(markdown: "committed and typing", selection: nil)
    let head = try #require(try await mac.store.document(localId: localId)).localHeadNodeId

    try await server.rename(documentId: seeded.documentId, title: "after")
    try await mac.sync.mirrorLibrary(await server.summaries())

    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.title == "after")
    #expect(document.draftMarkdown == "committed and typing", "the draft survives a title change")
    #expect(document.localHeadNodeId == head)
    #expect(document.markdown == "committed")
  }

  // MARK: - new 3. The divergence barrier survives a restart

  @Test("a divergence barrier holds across stop and restart")
  func barrierSurvivesRestart() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-barrier")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let theirs = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "their version")

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "ours one", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "ours two", selection: nil, structural: true)
    #expect(try await session.undo())
    await mac.sync.drainNow()

    #expect(try await mac.store.document(localId: localId)?.syncState == .diverged)
    #expect(try await mac.store.document(localId: localId)?.queueBlockedReason != nil)
    #expect(try await !mac.store.pendingJobs(documentLocalId: localId).isEmpty)

    // Background, then relaunch. A barrier that lived only in a `Set` is gone by
    // now, and the queued pointer move walks the server off the disputed branch.
    await mac.sync.stop()
    let relaunched = try Harness(directory: directory, transport: server, origin: "mac")
    await relaunched.sync.drainNow()

    let remote = try #require(try await server.getDocument(documentId: seeded.documentId))
    #expect(remote.currentNodeId == theirs, "nothing drained past the unresolved conflict")
    #expect(try await !relaunched.store.pendingJobs(documentLocalId: localId).isEmpty)
  }

  @Test("resolving clears the persisted barrier")
  func resolvingClearsBarrier() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-barrier-clear")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    _ = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "their version")
    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "ours", selection: nil, structural: true)
    await mac.sync.drainNow()
    #expect(try await mac.store.document(localId: localId)?.queueBlockedReason != nil)

    try await session.resolveDivergenceKeepingRemote()
    #expect(try await mac.store.document(localId: localId)?.queueBlockedReason == nil)
  }

  // MARK: - new 5. A pointer-only remote move must reconcile

  @Test("a remote undo moves the local head even though no node was written")
  func remotePointerOnlyMoveReconciles() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-remote-undo")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    // Another client commits, then undoes back to the root. The undo is a
    // pointer write only — `docNodes` does not change, so the node subscription
    // never fires and only the document observation can notice.
    let child = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "their text")
    try await mac.sync.mirrorLibrary(await server.summaries())
    #expect(try await mac.store.document(localId: localId)?.localHeadNodeId == child)

    _ = try await server.updateCurrentNodeId(
      documentId: seeded.documentId, currentNodeId: seeded.rootNodeId, markdown: "",
      wordCount: 0, updatedAt: Date().timeIntervalSince1970 * 1000,
      expectedPointerRevision: nil)

    try await mac.sync.mirrorLibrary(await server.summaries())

    let document = try #require(try await mac.store.document(localId: localId))
    #expect(
      document.localHeadNodeId == seeded.rootNodeId, "the local head followed the remote undo")
    #expect(document.markdown == "")
  }

  // MARK: - new 6. Open/close reentrancy

  @Test("concurrent first opens share one session")
  func concurrentFirstOpens() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    async let a = harness.registry.session(for: localId)
    async let b = harness.registry.session(for: localId)
    async let c = harness.registry.session(for: localId)
    let sessions = try await [a, b, c]
    #expect(sessions[0] === sessions[1])
    #expect(sessions[1] === sessions[2])
    #expect(await harness.registry.openDocumentIds == [localId])

    await harness.registry.release(localId)
    await harness.registry.release(localId)
    #expect(await harness.registry.openDocumentIds == [localId], "still held by the third window")
    await harness.registry.release(localId)
    #expect(await harness.registry.openDocumentIds.isEmpty)
  }

  @Test("a window opening during the last close still gets a live session")
  func openDuringLastClose() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let first = try await harness.registry.session(for: localId)
    try await first.applyLocalChange(markdown: "typed", selection: nil, structural: true)

    // The close flushes (an await); a new window arrives in that window.
    async let closing: Void = harness.registry.release(localId)
    async let reopened = harness.registry.session(for: localId)
    _ = await closing
    let session = try await reopened

    // Usable, not torn down under the new holder.
    try await session.applyLocalChange(markdown: "typed more", selection: nil, structural: true)
    #expect(await session.currentState?.markdown == "typed more")
    await harness.registry.release(localId)
  }
}
