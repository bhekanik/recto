import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

/// The acceptance list from plan 023 §9, N4:
/// "Create/edit/undo offline, kill app, relaunch, reconnect: zero loss;
///  two-client fast-forward and divergence flows pass."
@Suite("N4 acceptance")
struct AcceptanceTests {
  @Test("offline create + edits + undo survive a process kill and reach the server on reconnect")
  func offlineWorkSurvivesRelaunch() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let localId: String
    let expectedMarkdown = "Chapter one. 😀\n\nA second paragraph."

    // --- Session 1: entirely offline. The transport is never called. ---
    do {
      let harness = try Harness(directory: directory, transport: server)
      localId = try await harness.createLocalDocument(title: "native-spike-offline")
      let session = DocumentSession(
        documentLocalId: localId, store: harness.store, sync: nil, origin: "mac",
        schedulesTimers: false)
      try await session.open()
      try await session.applyLocalChange(
        markdown: "Chapter one. 😀", selection: nil, structural: true)
      try await session.applyLocalChange(
        markdown: "Chapter one. 😀\n\nA second paragraph.", selection: nil, structural: true)
      try await session.applyLocalChange(
        markdown: "Chapter one. 😀\n\nA second paragraph. Oops.", selection: nil, structural: true)
      // Undo the last edit; the branch stays in the DAG.
      #expect(try await session.undo())
      try await session.flush()
      #expect(await session.currentState?.markdown == expectedMarkdown)
      // Nothing has reached the server.
      #expect(await server.documents.isEmpty)
    }

    // --- The process dies. Session 2 opens the same database. ---
    let relaunched = try Harness(directory: directory, transport: server)
    let restored = try #require(try await relaunched.store.document(localId: localId))
    #expect(restored.markdown == expectedMarkdown, "zero loss across a relaunch")
    // root + three edits. The undo moved the pointer; it grew nothing.
    #expect(try await relaunched.store.nodes(documentLocalId: localId).count == 4)
    let queued = try await relaunched.store.pendingJobs(documentLocalId: localId)
    #expect(queued.count >= 4, "create + three commits + a pointer move stay queued")

    // --- Reconnect and drain. ---
    await relaunched.sync.drainNow()

    let convexId = try #require(try await relaunched.store.document(localId: localId)?.convexId)
    let remote = try #require(try await server.getDocument(documentId: convexId))
    #expect(remote.markdown == expectedMarkdown)
    #expect(try await relaunched.store.pendingJobs(documentLocalId: localId).isEmpty)
    // Every local node reached the server, including the undone branch.
    let localNodes = try await relaunched.store.nodes(documentLocalId: localId)
    let remoteNodes = try await server.listNodes(documentId: convexId, sinceCreatedAt: nil)
    #expect(Set(remoteNodes.map(\.nodeId)) == Set(localNodes.map(\.nodeId)))
    let finalDoc = try #require(try await relaunched.store.document(localId: localId))
    #expect(finalDoc.syncState == .synced)
    // Only claimed once the heads actually agree.
    #expect(finalDoc.remoteHeadNodeId == finalDoc.localHeadNodeId)
  }

  @Test("a second client fast-forwards onto the first client's head")
  func twoClientFastForward() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-ff")

    let directoryA = Harness.makeDirectory()
    let directoryB = Harness.makeDirectory()
    defer {
      try? FileManager.default.removeItem(at: directoryA)
      try? FileManager.default.removeItem(at: directoryB)
    }
    let macA = try Harness(directory: directoryA, transport: server, origin: "mac")
    let macB = try Harness(directory: directoryB, transport: server, origin: "ipad")
    let idA = try await macA.adoptRemoteDocument(seeded)
    let idB = try await macB.adoptRemoteDocument(seeded)

    // A writes and syncs.
    let sessionA = DocumentSession(
      documentLocalId: idA, store: macA.store, sync: macA.sync, origin: "mac",
      schedulesTimers: false)
    try await sessionA.open()
    try await sessionA.applyLocalChange(
      markdown: "written on the mac", selection: nil, structural: true)
    await macA.sync.drainNow()
    #expect(try await server.getDocument(documentId: seeded.documentId)?.markdown == "written on the mac")

    // B has no local work, so it adopts A's head and keeps its caret.
    let sessionB = DocumentSession(
      documentLocalId: idB, store: macB.store, sync: macB.sync, origin: "ipad",
      schedulesTimers: false)
    try await sessionB.open()
    try await macB.sync.reconcileHead(localId: idB)

    let adopted = try #require(try await macB.store.document(localId: idB))
    #expect(adopted.markdown == "written on the mac")
    #expect(adopted.syncState == .synced)
    #expect(adopted.divergedRemoteHeadNodeId == nil)
  }

  @Test("two clients editing the same base diverge, and both branches are kept")
  func twoClientDivergence() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-diverge")

    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    // The other client commits onto the shared root while this one is offline.
    let theirNode = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId,
      markdown: "their version")

    // This client commits its own child of the same root.
    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "our version", selection: nil, structural: true)
    let ourHead = try #require(try await mac.store.document(localId: localId)?.localHeadNodeId)

    await mac.sync.drainNow()

    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.syncState == .diverged)
    #expect(document.divergedRemoteHeadNodeId == theirNode)
    // Both branches survive on the server: commitEdit inserts the node whatever
    // the head check says, so no text was dropped.
    let remoteNodes = try await server.listNodes(
      documentId: seeded.documentId, sinceCreatedAt: nil)
    #expect(remoteNodes.contains { $0.nodeId == ourHead })
    #expect(remoteNodes.contains { $0.nodeId == theirNode })

    // The UI gets everything the compare sheet needs.
    try await session.open()
    let divergence = try #require(await session.currentState?.divergence)
    #expect(divergence.localHeadNodeId == ourHead)
    #expect(divergence.remoteHeadNodeId == theirNode)
    #expect(divergence.baseNodeId == seeded.rootNodeId)
  }

  @Test("keeping the local branch re-parents it onto the server's head")
  func resolveKeepingLocal() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-keep-local")
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
    try await session.applyLocalChange(markdown: "our version", selection: nil, structural: true)
    await mac.sync.drainNow()
    #expect(try await mac.store.document(localId: localId)?.syncState == .diverged)

    try await session.resolveDivergenceKeepingLocal()
    await mac.sync.drainNow()

    #expect(try await server.getDocument(documentId: seeded.documentId)?.markdown == "our version")
    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.divergedRemoteHeadNodeId == nil)
    #expect(document.markdown == "our version")
  }

  @Test("keeping the remote branch leaves the local one reachable")
  func resolveKeepingRemote() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-keep-remote")
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
    try await session.applyLocalChange(markdown: "our version", selection: nil, structural: true)
    let ourHead = try #require(try await mac.store.document(localId: localId)?.localHeadNodeId)
    await mac.sync.drainNow()

    try await session.resolveDivergenceKeepingRemote()
    #expect(try await mac.store.document(localId: localId)?.markdown == "their version")
    // Nothing is deleted: the local branch is still in the history panel.
    #expect(try await mac.store.node(documentLocalId: localId, nodeId: ourHead) != nil)
    #expect(
      try await mac.store.materializedMarkdown(documentLocalId: localId, nodeId: ourHead)
        == "our version")
  }

  @Test("a lost acknowledgement is replayed with the same key and answered identically")
  func lostAcknowledgementIsReplayed() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-lost-ack")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "committed once", selection: nil, structural: true)

    // The mutation lands, then the socket drops before the answer arrives.
    await server.inject([.dropAcknowledgement])
    await mac.sync.drainNow()

    let queued = try await mac.store.pendingJobs(documentLocalId: localId)
    #expect(queued.count == 1, "the job stays queued until it is acknowledged")
    let key = try #require(queued.first?.clientMutationId)
    #expect(queued.first?.attempts == 1)
    #expect(try await mac.store.document(localId: localId)?.syncState == .failed)

    // Retry. The same key comes back, and the server replays its original answer
    // instead of reporting a spurious divergence.
    try await mac.store.failJob(id: try #require(queued.first?.id), error: "", retryAfter: 0, now: 0)
    await mac.sync.drainNow()

    let attempts = await server.commitAttempts
    #expect(attempts == [key, key], "the idempotency key is reused, not regenerated")
    #expect(try await mac.store.pendingJobs(documentLocalId: localId).isEmpty)
    #expect(try await server.getDocument(documentId: seeded.documentId)?.markdown == "committed once")
    #expect(try await mac.store.document(localId: localId)?.syncState == .synced)
  }

  @Test("a token expiring mid-drain re-authenticates and finishes the queue")
  func tokenExpiryMidDrain() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-token")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "first", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "first second", selection: nil, structural: true)
    try await session.applyLocalChange(
      markdown: "first second third", selection: nil, structural: true)

    // Clerk's convex-template token lives 60 seconds; a long drain outlives it.
    await server.inject([.tokenExpired])
    await mac.sync.drainNow()
    #expect(await server.loginCount == 1, "the engine re-authenticates rather than just backing off")
    #expect(try await !mac.store.pendingJobs(documentLocalId: localId).isEmpty)

    // Clear the backoff the way the retry timer would, then finish.
    for job in try await mac.store.pendingJobs(documentLocalId: localId) {
      try await mac.store.failJob(id: try #require(job.id), error: "", retryAfter: 0, now: 0)
    }
    await mac.sync.drainNow()

    #expect(try await mac.store.pendingJobs(documentLocalId: localId).isEmpty)
    #expect(
      try await server.getDocument(documentId: seeded.documentId)?.markdown
        == "first second third")
  }

  @Test("an offline drain leaves the queue intact and backs off")
  func offlineDrainIsHarmless() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-offline-drain")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "typed offline", selection: nil, structural: true)

    await server.inject([.offline])
    await mac.sync.drainNow()

    let queued = try await mac.store.pendingJobs(documentLocalId: localId)
    #expect(queued.count == 1)
    #expect(queued.first?.attempts == 1)
    #expect((queued.first?.nextAttemptAt ?? 0) > 0, "backoff is scheduled")
    #expect(try await mac.store.document(localId: localId)?.markdown == "typed offline")
  }
}
