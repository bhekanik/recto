import Foundation
import RectoHistory
import RectoStore
import RectoSyncTesting
import Testing

@testable import RectoSync

/// Flows a one-shot fake could not reach: a remote update arriving mid-session,
/// a subscription dying the way Convex kills one on a server error, and the
/// re-subscribe that has to follow an auth transition.
@Suite("live subscription flows")
struct LiveFlowTests {
  private func waitFor(
    _ description: String, timeout: Duration = .seconds(2), _ condition: () async -> Bool
  ) async throws {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(5))
    }
    Issue.record("timed out waiting for \(description)")
  }

  @Test("a document created elsewhere arrives over the live subscription")
  func remoteDocumentArrivesLive() async throws {
    let transport = InMemoryTransport()
    let store = try RectoStore.inMemory()
    let engine = SyncEngine(store: store, transport: transport, origin: "mac")

    await engine.start()
    _ = await transport.seedDocument(title: "native-spike-live")

    try await waitFor("the document to be mirrored") {
      ((try? await store.documents().count) ?? 0) == 1
    }
    let document = try #require(try await store.documents().first)
    #expect(document.title == "native-spike-live")
    #expect(document.syncState == .synced)
    await engine.stop()
  }

  @Test("an edit from another client arrives while the document is open")
  func remoteEditArrivesLive() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-live-edit")
    let store = try RectoStore.inMemory()
    let engine = SyncEngine(store: store, transport: transport, origin: "mac")

    await engine.start()
    try await waitFor("hydration") { ((try? await store.documents().count) ?? 0) == 1 }
    let localId = try #require(try await store.documents().first?.localId)
    await engine.openDocument(localId: localId)

    _ = try await transport.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "typed elsewhere")

    // No local work, so §4.4 says adopt when idle — and it has to happen without
    // anyone calling reconcile by hand.
    try await waitFor("the remote head to be adopted") {
      ((try? await store.document(localId: localId))?.markdown) == "typed elsewhere"
    }
    await engine.stop()
  }

  @Test("a subscription killed by a server error is rebuilt by resume()")
  func subscriptionsAreRebuiltOnResume() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-resub")
    let store = try RectoStore.inMemory()
    let engine = SyncEngine(store: store, transport: transport, origin: "mac")

    await engine.start()
    try await waitFor("hydration") { ((try? await store.documents().count) ?? 0) == 1 }
    let localId = try #require(try await store.documents().first?.localId)
    await engine.openDocument(localId: localId)
    try await waitFor("subscriptions") { await transport.liveSubscriptionCount >= 2 }

    // Convex terminates a subscription permanently on a server error; nothing
    // recovers on its own.
    await transport.failAllSubscriptions()
    try await waitFor("the streams to end") { await transport.liveSubscriptionCount == 0 }

    // An edit made while the client is deaf.
    _ = try await transport.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "missed this")

    await engine.resume()
    try await waitFor("the resubscribed client to catch up") {
      ((try? await store.document(localId: localId))?.markdown) == "missed this"
    }
    #expect(await transport.loginCount >= 1, "resume re-authenticates too")
    await engine.stop()
  }

  @Test("a persisted backoff wakes itself after a restart")
  func backoffWakesAfterRestart() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-backoff")
    let store = try RectoStore.inMemory()

    // A job left backed off by a previous process.
    let engine = SyncEngine(store: store, transport: transport, origin: "mac")
    try await engine.mirrorLibrary(await transport.summaries())
    let localId = try #require(try await store.documents().first?.localId)
    let job = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "native-spike-renamed").encoded, createdAt: 0))
    try await store.failJob(
      id: try #require(job.id), error: "offline", retryAfter: 0.05,
      now: Date().timeIntervalSince1970 * 1000)
    #expect(try await store.pendingJobCount() == 1)

    // start() alone drains once and finds the job ineligible; the wake is what
    // makes retry-until-acknowledged survive a relaunch.
    await engine.start()
    try await waitFor("the backed-off job to be retried") {
      ((try? await store.pendingJobCount()) ?? 1) == 0
    }
    #expect(try await transport.getDocument(documentId: seeded.documentId)?.title
      == "native-spike-renamed")
    await engine.stop()
  }

  @Test("one busy document does not starve the others")
  func roundRobinDrain() async throws {
    let transport = InMemoryTransport()
    let busy = await transport.seedDocument(title: "native-spike-busy")
    let quiet = await transport.seedDocument(title: "native-spike-quiet")
    let store = try RectoStore.inMemory()
    let engine = SyncEngine(store: store, transport: transport, origin: "mac")
    try await engine.mirrorLibrary(await transport.summaries())

    let busyId = try #require(
      try await store.documents().first { $0.convexId == busy.documentId }?.localId)
    let quietId = try #require(
      try await store.documents().first { $0.convexId == quiet.documentId }?.localId)

    for index in 0..<20 {
      _ = try await store.enqueue(
        OutboxJob(
          documentLocalId: busyId, kind: .rename, clientMutationId: ulid(),
          payload: OutboxPayload(title: "busy-\(index)").encoded, createdAt: Double(index)))
    }
    // Queued last, and behind twenty jobs on another document.
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: quietId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "native-spike-quiet-renamed").encoded, createdAt: 99))

    await engine.drainNow()

    #expect(try await store.pendingJobCount() == 0)
    #expect(
      try await transport.getDocument(documentId: quiet.documentId)?.title
        == "native-spike-quiet-renamed")

    // The point is the ORDER: the quiet document's single job must be served
    // during the first sweep, not after all twenty of the busy one's.
    let order = await transport.renameOrder
    let quietPosition = try #require(order.firstIndex(of: "native-spike-quiet-renamed"))
    #expect(
      quietPosition <= 1,
      "the quiet document waited behind \(quietPosition) busy jobs")
  }

  @Test("concurrent drain requests share one in-flight job")
  func concurrentDrainsDoNotDuplicate() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-concurrent")
    let store = try RectoStore.inMemory()
    let engine = SyncEngine(store: store, transport: transport, origin: "mac")
    try await engine.mirrorLibrary(await transport.summaries())
    let localId = try #require(try await store.documents().first?.localId)

    let nodeId = ulid()
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .commitEdit, clientMutationId: "MUT-ONCE",
        baseHeadNodeId: seeded.rootNodeId,
        payload: OutboxPayload(
          nodeId: nodeId, parentNodeId: seeded.rootNodeId,
          patch: computePatch("", "once").encoded, origin: "mac", createdAt: 1,
          markdown: "once", wordCount: 1
        ).encoded,
        createdAt: 1))

    // Two callers, one queue. A second loop would re-read the same head job and
    // the server would answer the slower replay with a false divergence.
    async let first: Void = engine.drainNow()
    async let second: Void = engine.drainNow()
    _ = await (first, second)

    #expect(await transport.commitAttempts == ["MUT-ONCE"])
    #expect(try await store.pendingJobCount() == 0)
  }
}
