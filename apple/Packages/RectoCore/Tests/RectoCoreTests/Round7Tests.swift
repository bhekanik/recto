import Foundation
import RectoAuth
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("round-7 repros")
struct Round7Tests {
  // MARK: - 2. A purge must empty the open windows too

  /// Enough of `RectoAuth`'s collaborators to drive a real account switch.
  private actor RecordingSync: SyncControlling {
    private(set) var events: [String] = []
    func stop() async { events.append("stop") }
    func start() async { events.append("start") }
  }

  /// The A-to-B ORDERING (purge, then invalidate, then publish B) is asserted in
  /// `RectoAuthTests`, which can reach that package's test seams. This asserts
  /// the effect on the real registry and session, through public API: a purge is
  /// a purge whether it comes from a switch or a sign-out.
  @Test("a purge empties the windows that were already open")
  func purgeClearsOpenSessions() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "A's document")
    _ = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId,
      markdown: "user A secret text")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)
    try await mac.store.setMirrorOwner("user_A")

    // A window, open, showing A's text — and nothing queued, so the switch is
    // allowed to purge.
    let session = try await mac.registry.session(for: localId)
    #expect(await session.currentState?.markdown == "user A secret text")
    #expect(try await mac.store.unsyncedWorkCount() == 0)

    let auth = await RectoAuth(store: mac.store)
    let sync = RecordingSync()
    await auth.attach(sync: sync)
    await auth.attach(sessions: mac.registry)

    try await auth.signOut()

    #expect(await auth.status == .signedOut)
    #expect(try await mac.store.documents().isEmpty, "SQLite was purged")
    // Freezing stopped new writes; it did not empty what this window had already
    // loaded. B could read A's title and markdown out of the live session.
    #expect(await session.currentState == nil)
    #expect(await mac.registry.openDocumentIds.isEmpty)
    await #expect(throws: SessionError.invalidated) {
      try await session.applyLocalChange(
        markdown: "the next account typing into A's window", selection: nil)
    }
    await #expect(throws: SessionError.invalidated) { try await session.open() }
  }

  @Test("the state stream ends so the window knows its document is gone")
  func invalidationFinishesTheStateStream() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "A's document")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)
    let session = try await mac.registry.session(for: localId)

    // Creating the stream registers its continuation immediately, before the
    // invalidation. It also buffers the current state, so the consumer can
    // start afterwards without racing the finish.
    let states = await session.states
    await mac.registry.invalidateAll()

    // A window renders from this stream; if it never finishes it keeps the last
    // state it saw on screen. Bounded, so a regression fails the test instead of
    // hanging the suite.
    let finished = await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for await _ in states {}
        return true
      }
      group.addTask {
        try? await Task.sleep(for: .seconds(2))
        return false
      }
      let first = await group.next() ?? false
      group.cancelAll()
      return first
    }
    #expect(finished, "the state stream never finished, so the window keeps A's last render")
  }

  // MARK: - 4. A rejected pointer followed by a rejected commit is a divergence

  /// The exact sequence: a pointer move the server refuses, a commit behind it
  /// whose parent is no longer the head, and a rename behind that.
  private func rejectedPointerThenCommit(_ mac: Harness, _ server: InMemoryTransport)
    async throws -> (localId: String, rootNodeId: String, documentId: String, localHead: String)
  {
    let seeded = await server.seedDocument(title: "native-spike-pointer-then-commit")
    let localId = try await mac.adoptRemoteDocument(seeded)
    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "child", selection: nil, structural: true)
    await mac.sync.drainNow()
    let child = try #require(try await mac.store.document(localId: localId)).localHeadNodeId

    // Another client undoes to the root: the pointer moves and the revision
    // advances, so our queued move loses the compare-and-set.
    _ = try await server.updateCurrentNodeId(
      documentId: seeded.documentId, currentNodeId: seeded.rootNodeId, markdown: "",
      wordCount: 0, updatedAt: Date().timeIntervalSince1970 * 1000,
      expectedPointerRevision: nil)

    let now = Date().timeIntervalSince1970 * 1000
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .pointerMove, clientMutationId: ulid(),
        baseHeadNodeId: child,
        payload: OutboxPayload(nodeId: child, createdAt: now, markdown: "child", wordCount: 1)
          .encoded,
        createdAt: now))
    // The tail: a commit onto `child`, which the server's head is no longer at.
    try await session.applyLocalChange(
      markdown: "child grandchild", selection: nil, structural: true)
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "must-not-be-sent").encoded, createdAt: now + 1))

    let head = try #require(try await mac.store.document(localId: localId)).localHeadNodeId
    return (localId, seeded.rootNodeId, seeded.documentId, head)
  }

  @Test("a commit the server refuses behind a rejected pointer becomes a divergence")
  func rejectedPointerThenCommitDiverges() async throws {
    let server = InMemoryTransport()
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let context = try await rejectedPointerThenCommit(mac, server)

    await mac.sync.drainNow()

    // Handing this to the ancestry rules read the remote root as "the server has
    // not seen our nodes yet", released the barrier, and left the committed node
    // stranded off the server's branch with a `pending` badge and no resolver.
    let document = try #require(try await mac.store.document(localId: context.localId))
    #expect(document.syncState == .diverged)
    #expect(document.queueBlockedReason == QueueBlockReason.diverged.rawValue)
    #expect(document.divergedRemoteHeadNodeId == context.rootNodeId)
    #expect(document.remoteHeadNodeId == context.rootNodeId)
    #expect(document.localHeadNodeId == context.localHead)
    #expect(await server.renameOrder.isEmpty, "the tail stayed behind the conflict")

    // The node itself landed and is recorded as landed: a divergence costs the
    // pointer, never the text.
    let remoteNodes = try await server.listNodes(
      documentId: context.documentId, sinceCreatedAt: nil)
    #expect(remoteNodes.contains { $0.nodeId == context.localHead })
    let local = try await mac.store.nodes(documentLocalId: context.localId)
    #expect(local.first { $0.nodeId == context.localHead }?.synced == true)

    // And it is resolvable, which is the whole point of surfacing it.
    let session = DocumentSession(
      documentLocalId: context.localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    #expect(await session.currentState?.divergence != nil)
    try await session.resolveDivergenceKeepingRemote()
    await mac.sync.drainNow()
    #expect(try await mac.store.document(localId: context.localId)?.queueBlockedReason == nil)
    #expect(try await mac.store.pendingJobs(documentLocalId: context.localId).isEmpty)
  }

  @Test("that divergence survives a relaunch instead of draining past itself")
  func rejectedPointerThenCommitSurvivesRestart() async throws {
    let server = InMemoryTransport()
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let context = try await rejectedPointerThenCommit(mac, server)
    await mac.sync.drainNow()
    await mac.sync.stop()

    let relaunched = try Harness(directory: directory, transport: server, origin: "mac")
    await relaunched.sync.reconcileAbandonedBarriers()
    await relaunched.sync.drainNow()

    // The sweep only matches provisional reasons, so a durable divergence is not
    // something it can release.
    let document = try #require(try await relaunched.store.document(localId: context.localId))
    #expect(document.syncState == .diverged)
    #expect(document.queueBlockedReason == QueueBlockReason.diverged.rawValue)
    #expect(document.divergedRemoteHeadNodeId == context.rootNodeId)
    #expect(await server.renameOrder.isEmpty)
    #expect(try await server.getDocument(documentId: context.documentId)?.currentNodeId
      == context.rootNodeId)
  }
}
