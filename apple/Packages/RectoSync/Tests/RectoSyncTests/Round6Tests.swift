import Foundation
import RectoHistory
import RectoStore
import RectoSyncTesting
import Testing

@testable import RectoSync

/// Round 6, findings 5 and 6: the wake schedule and the draft acknowledgement.
@Suite("round-6 sync")
struct Round6SyncTests {
  private func makeEngine(_ transport: InMemoryTransport) throws -> (RectoStore, SyncEngine) {
    let store = try RectoStore.inMemory()
    return (store, SyncEngine(store: store, transport: transport, origin: "test-device"))
  }

  private func adopt(_ store: RectoStore, _ transport: InMemoryTransport, _ seeded: CreateDocumentResponse)
    async throws -> String
  {
    let remote = try #require(try await transport.getDocument(documentId: seeded.documentId))
    let localId = UUID().uuidString
    try await store.save(
      DocumentRecord(
        localId: localId, convexId: remote.id, title: remote.title, markdown: remote.markdown,
        wordCount: Int(remote.wordCount), localHeadNodeId: remote.currentNodeId,
        remoteHeadNodeId: remote.currentNodeId, remoteUpdatedAt: remote.updatedAt,
        syncState: .synced, updatedAt: remote.updatedAt, createdAt: remote.createdAt))
    let nodes = try await transport.listNodes(documentId: remote.id, sinceCreatedAt: nil)
    try await store.mergeRemoteNodes(
      documentLocalId: localId, nodes: nodes.map { $0.record(documentLocalId: localId) })
    return localId
  }

  // MARK: - 5. The backoff wake must not spin

  @Test("a ready tail behind a backed-off head arms one wake, not a loop")
  func backedOffHeadDoesNotSpin() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-wake")
    let (store, engine) = try makeEngine(transport)
    let localId = try await adopt(store, transport, seeded)

    // A head that will fail, and a tail that is immediately eligible. `MIN` over
    // every row answered with the tail's default zero timestamp, so the wake
    // fired at once, requested a drain that could not send the head, and armed
    // another zero-delay wake.
    let head = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "first").encoded, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "second").encoded, createdAt: 1))
    try await store.failJob(id: try #require(head.id), error: "boom", retryAfter: 120)

    await engine.start()
    await engine.drainNow()
    // Long enough for a zero-delay spin to arm hundreds of wakes.
    try await Task.sleep(for: .milliseconds(200))
    let armed = await engine.armedBackoffWakes
    await engine.stop()

    #expect(armed <= 2, "armed \(armed) wakes for a queue that cannot move")
    #expect(await transport.renameOrder.isEmpty, "the head is still backed off")
  }

  @Test("a blocked document arms no wake at all")
  func blockedDocumentDoesNotSpin() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-wake-blocked")
    let (store, engine) = try makeEngine(transport)
    let localId = try await adopt(store, transport, seeded)

    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "held").encoded, createdAt: 0))
    try await store.setQueueBlocked(
      documentLocalId: localId, reason: QueueBlockReason.diverged.rawValue)

    await engine.start()
    await engine.drainNow()
    try await Task.sleep(for: .milliseconds(200))
    let armed = await engine.armedBackoffWakes
    await engine.stop()

    #expect(armed == 0, "a barrier is not a wake time; armed \(armed)")
    #expect(await transport.renameOrder.isEmpty)
  }

  // MARK: - 6. A stale draft response is not an acknowledgement

  @Test("a draft whose CAS lost is retried, not acknowledged")
  func staleDraftIsRetried() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-stale-draft")
    let (store, engine) = try makeEngine(transport)
    let localId = try await adopt(store, transport, seeded)
    let head = try #require(try await store.document(localId: localId)).localHeadNodeId

    let job = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .draftSave, clientMutationId: ulid(),
        baseHeadNodeId: head,
        payload: OutboxPayload(markdown: "the final sentence", wordCount: 3).encoded,
        createdAt: 0))

    // Another write bumps `updatedAt` without moving the head, which is exactly
    // what the server answers `stale: true, headMoved: false` to. It writes
    // nothing — treating that as an acknowledgement deleted the only retry and
    // left the final draft in SQLite alone.
    try await transport.writeServerDraft(
      documentId: seeded.documentId, markdown: "someone else's text",
      stampedHeadNodeId: head)

    await engine.drainNow()

    #expect(
      try await store.pendingJobs(documentLocalId: localId).count == 1,
      "the job survived the rejection")
    #expect(try await transport.getDocument(documentId: seeded.documentId)?.markdown
      == "someone else's text", "nothing of ours reached the server yet")
    // A rejection is not a failure: the badge must not claim a stuck queue.
    #expect(try await store.hasFailedJobs(documentLocalId: localId) == false)
    #expect(try await store.document(localId: localId)?.syncState != .failed)

    // The retry carries the baseline the rejection handed back.
    try await store.deferJob(id: try #require(job.id), retryAfter: 0, now: 0)
    await engine.drainNow()

    #expect(try await transport.getDocument(documentId: seeded.documentId)?.markdown
      == "the final sentence", "the draft reached the server before the job disappeared")
    #expect(try await store.pendingJobs(documentLocalId: localId).isEmpty)
  }
}
