import Foundation
import RectoHistory
import RectoStore
import RectoSyncTesting
import Testing

@testable import RectoSync

/// Round 7, findings 3 and 6: the pointer compare-and-set, and refusals the
/// server decides deterministically.
@Suite("round-7 sync")
struct Round7SyncTests {
  private func makeEngine(_ transport: InMemoryTransport) throws -> (RectoStore, SyncEngine) {
    let store = try RectoStore.inMemory()
    return (store, SyncEngine(store: store, transport: transport, origin: "test-device"))
  }

  private func adopt(
    _ store: RectoStore, _ transport: InMemoryTransport, _ seeded: CreateDocumentResponse
  ) async throws -> String {
    let remote = try #require(try await transport.getDocument(documentId: seeded.documentId))
    let localId = UUID().uuidString
    try await store.save(
      DocumentRecord(
        localId: localId, convexId: remote.id, title: remote.title, markdown: remote.markdown,
        wordCount: Int(remote.wordCount), localHeadNodeId: remote.currentNodeId,
        remoteHeadNodeId: remote.currentNodeId, remoteUpdatedAt: remote.updatedAt,
        remotePointerRevision: remote.pointerRevision,
        syncState: .synced, updatedAt: remote.updatedAt, createdAt: remote.createdAt))
    let nodes = try await transport.listNodes(documentId: remote.id, sinceCreatedAt: nil)
    try await store.mergeRemoteNodes(
      documentLocalId: localId, nodes: nodes.map { $0.record(documentLocalId: localId) })
    return localId
  }

  // MARK: - 3. The pointer move is a compare-and-set, not a clock comparison

  /// A server whose clock runs ten minutes ahead of ours — the ordinary case for
  /// two machines, and fatal to a rule that compares our timestamp with theirs.
  private func skewedServer() -> InMemoryTransport {
    InMemoryTransport(now: Date().timeIntervalSince1970 * 1000 + 600_000)
  }

  @Test("an undo queued behind our own commit survives a server clock ten minutes ahead")
  func pointerMoveBehindCommitSurvivesClockSkew() async throws {
    let server = skewedServer()
    let seeded = await server.seedDocument(title: "native-spike-cas-commit")
    let (store, engine) = try makeEngine(server)
    let localId = try await adopt(store, server, seeded)
    let root = seeded.rootNodeId

    // A commit and, behind it in the same FIFO queue, the undo back to the root.
    let child = ulid()
    let now = Date().timeIntervalSince1970 * 1000
    try await store.mergeRemoteNodes(
      documentLocalId: localId,
      nodes: [
        DocNodeRecord(
          documentLocalId: localId, nodeId: child, parentNodeId: root,
          patch: computePatch("", "child").encoded, snapshot: nil, origin: "mac",
          createdAt: now, synced: false)
      ])
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .commitEdit, clientMutationId: ulid(),
        baseHeadNodeId: root,
        payload: OutboxPayload(
          nodeId: child, parentNodeId: root, patch: computePatch("", "child").encoded,
          origin: "mac", createdAt: now, markdown: "child", wordCount: 1
        ).encoded,
        createdAt: now))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .pointerMove, clientMutationId: ulid(),
        baseHeadNodeId: root,
        payload: OutboxPayload(nodeId: root, createdAt: now, markdown: "", wordCount: 0).encoded,
        createdAt: now))

    await engine.drainNow()

    // The commit set `documents.updatedAt` from the SERVER's clock, ten minutes
    // ahead of the undo's event time. Under the wall-clock rule the undo was
    // refused as stale and reconciliation then adopted the child — the user's
    // undo simply disappeared. The revision the commit handed back is what the
    // undo now compares against.
    let remote = try #require(try await server.getDocument(documentId: seeded.documentId))
    #expect(remote.currentNodeId == root, "the undo reached the server")
    #expect(try await store.document(localId: localId)?.localHeadNodeId == root)
    #expect(try await store.pendingJobs(documentLocalId: localId).isEmpty)
  }

  @Test("a pointer move queued behind a draft survives the same skew")
  func pointerMoveBehindDraftSurvivesClockSkew() async throws {
    let server = skewedServer()
    let seeded = await server.seedDocument(title: "native-spike-cas-draft")
    let (store, engine) = try makeEngine(server)
    let localId = try await adopt(store, server, seeded)
    let now = Date().timeIntervalSince1970 * 1000

    // A draft bumps `updatedAt` without touching `pointerRevision`, so the
    // wall-clock rule refused everything queued behind it while the CAS does not.
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .draftSave, clientMutationId: ulid(),
        baseHeadNodeId: seeded.rootNodeId,
        payload: OutboxPayload(markdown: "typing", wordCount: 1).encoded, createdAt: now))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .pointerMove, clientMutationId: ulid(),
        baseHeadNodeId: seeded.rootNodeId,
        payload: OutboxPayload(
          nodeId: seeded.rootNodeId, createdAt: now, markdown: "typing", wordCount: 1
        ).encoded,
        createdAt: now))

    await engine.drainNow()

    #expect(try await store.pendingJobs(documentLocalId: localId).isEmpty, "both jobs landed")
    #expect(try await server.getDocument(documentId: seeded.documentId)?.currentNodeId
      == seeded.rootNodeId)
  }

  @Test("a revision the server has moved past is still refused")
  func staleRevisionIsRefused() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-cas-stale")
    let before = try #require(try await server.getDocument(documentId: seeded.documentId))

    let child = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "theirs")

    // The CAS is on the revision, so a timestamp far in the future cannot buy
    // its way past a pointer that has already moved.
    let response = try await server.updateCurrentNodeId(
      documentId: seeded.documentId, currentNodeId: seeded.rootNodeId, markdown: "",
      wordCount: 0, updatedAt: Date().timeIntervalSince1970 * 1000 + 3_600_000,
      expectedPointerRevision: before.pointerRevision)
    #expect(response.applied == false)
    #expect(response.currentNodeId == child)
  }

  // MARK: - 6. Refusal codes decide whether a job is retried or parked

  private func queueRename(_ store: RectoStore, _ localId: String) async throws -> OutboxJob {
    try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "renamed").encoded, createdAt: 0))
  }

  @Test(
    "a terminal refusal parks the job instead of retrying it forever",
    arguments: [
      ServerRefusal.Code.invalidArgument, .notFound, .unknownNode, .tooLarge, .parentMismatch,
    ])
  func terminalRefusalParksTheJob(code: ServerRefusal.Code) async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-refusal")
    let (store, engine) = try makeEngine(server)
    let localId = try await adopt(store, server, seeded)
    _ = try await queueRename(store, localId)

    await server.inject([.refused(ServerRefusal(code: code, message: "no"))])
    await engine.drainNow()

    // Deleting it would destroy the work; retrying it blocks everything behind
    // it in this document's queue forever. It is parked, with the reason.
    let parked = try await store.parkedJobs()
    #expect(parked.count == 1)
    #expect(parked.first?.lastError?.contains(code.rawValue) == true)
    #expect(try await store.document(localId: localId)?.syncState == .failed)
    #expect(await server.renameOrder.isEmpty)
  }

  @Test("an unauthenticated refusal re-authenticates and keeps the job")
  func unauthenticatedRefusalReauthenticatesAndRetries() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-reauth")
    let (store, engine) = try makeEngine(server)
    let localId = try await adopt(store, server, seeded)
    let job = try await queueRename(store, localId)

    // A Clerk `convex` token lives 60 seconds and can expire between two jobs of
    // a long drain. That is not a defect in the job.
    await server.inject([
      .refused(ServerRefusal(code: .unauthenticated, message: "Unauthenticated"))
    ])
    await engine.drainNow()

    #expect(await server.loginCount == 1, "the bridge was replaced with the sockets down")
    #expect(try await store.parkedJobs().isEmpty, "an expired token is not a defect in the job")
    #expect(try await store.pendingJobs(documentLocalId: localId).count == 1)

    // Once the backoff elapses the same job goes out and succeeds.
    try await store.deferJob(id: try #require(job.id), retryAfter: 0, now: 0)
    await engine.drainNow()

    #expect(await server.renameOrder == ["renamed"])
    #expect(try await store.pendingJobs(documentLocalId: localId).isEmpty)
  }

  @Test("a plain error is still retried, not parked")
  func plainErrorsKeepTheirRetry() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-plain")
    let (store, engine) = try makeEngine(server)
    let localId = try await adopt(store, server, seeded)
    let job = try await queueRename(store, localId)

    // An exhausted OCC retry reaches the client as a plain error and IS safe to
    // retry. Parking on anything that merely failed once would strand work.
    await server.inject([.offline])
    await engine.drainNow()

    #expect(try await store.parkedJobs().isEmpty)
    try await store.deferJob(id: try #require(job.id), retryAfter: 0, now: 0)
    await engine.drainNow()
    #expect(await server.renameOrder == ["renamed"])
  }

  @Test("only our own refusal shape is recognised")
  func refusalParsingIsStrict() {
    #expect(ServerRefusal(convexErrorData: #"{"code":"too_large","message":"nope"}"#)
      == ServerRefusal(code: .tooLarge, message: "nope"))
    // A code the client does not know, a bare string, and a non-object all keep
    // their retry rather than being guessed at.
    #expect(ServerRefusal(convexErrorData: #"{"code":"something_new"}"#) == nil)
    #expect(ServerRefusal(convexErrorData: #""just a string""#) == nil)
    #expect(ServerRefusal(convexErrorData: "not json") == nil)
    // The message is optional; the code is what decides.
    #expect(ServerRefusal(convexErrorData: #"{"code":"not_found"}"#)?.isTerminal == true)
    #expect(ServerRefusal(convexErrorData: #"{"code":"unauthenticated"}"#)?.isTerminal == false)
  }
}
