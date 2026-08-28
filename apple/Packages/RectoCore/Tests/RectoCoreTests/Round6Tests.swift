import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("round-6 repros")
struct Round6Tests {
  // MARK: - 3. A frozen session refuses every mutating transition

  @Test("nothing a frozen session is asked to do reaches the store")
  func frozenSessionRefusesEveryMutator() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-frozen")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    // Two nodes, so undo and redo both have somewhere to go.
    try await session.applyLocalChange(markdown: "one", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "two", selection: nil, structural: true)
    #expect(try await session.undo())
    let root = try #require(try await mac.store.document(localId: localId)).localHeadNodeId
    let redoTarget = try #require(
      try await mac.store.nodes(documentLocalId: localId).last?.nodeId)

    // Everything sign-out takes its final count against.
    let before = try #require(try await mac.store.document(localId: localId))
    let nodesBefore = try await mac.store.nodes(documentLocalId: localId).count
    let jobsBefore = try await mac.store.pendingJobs(documentLocalId: localId).count

    await session.freeze()

    await #expect(throws: SessionError.frozen) {
      try await session.applyLocalChange(markdown: "typed", selection: nil)
    }
    await #expect(throws: SessionError.frozen) { _ = try await session.undo() }
    await #expect(throws: SessionError.frozen) { _ = try await session.redo() }
    await #expect(throws: SessionError.frozen) { try await session.navigate(to: redoTarget) }
    await #expect(throws: SessionError.frozen) { try await session.tickIdle() }
    await #expect(throws: SessionError.frozen) {
      try await session.resolveDivergenceKeepingLocal()
    }
    await #expect(throws: SessionError.frozen) {
      try await session.resolveDivergenceKeepingRemote()
    }
    // The debounced writer is not a public throwing call; it has to drop the
    // write rather than report it.
    await session.writeDraft(markdown: "debounced after the freeze", selection: nil)

    let after = try #require(try await mac.store.document(localId: localId))
    #expect(after.localHeadNodeId == root)
    #expect(after.localHeadNodeId == before.localHeadNodeId)
    #expect(after.draftMarkdown == before.draftMarkdown)
    #expect(after.draftRevision == before.draftRevision)
    #expect(after.markdown == before.markdown)
    #expect(try await mac.store.nodes(documentLocalId: localId).count == nodesBefore)
    #expect(try await mac.store.pendingJobs(documentLocalId: localId).count == jobsBefore)

    // A refused sign-out has to leave the session usable again.
    await session.resume()
    try await session.applyLocalChange(markdown: "typed after", selection: nil)
    #expect(try await mac.store.document(localId: localId)?.draftMarkdown == "typed after")
  }

  // MARK: - 4. A provisional barrier cannot outlive its reconciliation

  /// The round-5 shape, with a tail: a rejected pointer move, a rename queued
  /// behind it, and a remote undo the reconciliation has to act on.
  private func rejectedPointerMoveWithTail(_ mac: Harness, _ server: InMemoryTransport)
    async throws -> (localId: String, rootNodeId: String, childNodeId: String, documentId: String)
  {
    let seeded = await server.seedDocument(title: "native-spike-barrier-tail")
    let localId = try await mac.adoptRemoteDocument(seeded)
    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "child", selection: nil, structural: true)
    await mac.sync.drainNow()
    let child = try #require(try await mac.store.document(localId: localId)).localHeadNodeId

    // Another client undoes to the root. Pointer only — no node is written.
    _ = try await server.updateCurrentNodeId(
      documentId: seeded.documentId, currentNodeId: seeded.rootNodeId, markdown: "",
      wordCount: 0, updatedAt: Date().timeIntervalSince1970 * 1000)

    // Our own stale redo loses the last-write-wins check, and a rename sits
    // behind it.
    let stale = Date().timeIntervalSince1970 * 1000 - 600_000
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .pointerMove, clientMutationId: ulid(),
        baseHeadNodeId: child,
        payload: OutboxPayload(nodeId: child, createdAt: stale, markdown: "child", wordCount: 1)
          .encoded,
        createdAt: stale))
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "queued-behind").encoded, createdAt: stale + 1))
    return (localId, seeded.rootNodeId, child, seeded.documentId)
  }

  @Test("a rejected pointer move with a tail settles instead of deadlocking")
  func rejectedPointerMoveWithTailDrains() async throws {
    let server = InMemoryTransport()
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let context = try await rejectedPointerMoveWithTail(mac, server)

    await mac.sync.drainNow()

    // The old shape stopped here: the barrier held the tail, the tail kept the
    // document non-idle, the deferred adoption never ran, and the consumed
    // pointer revision made every later pass read the remote head as lag.
    let document = try #require(try await mac.store.document(localId: context.localId))
    #expect(document.queueBlockedReason == nil, "no barrier survived its reconciliation")
    #expect(try await mac.store.pendingJobs(documentLocalId: context.localId).isEmpty)
    #expect(
      document.localHeadNodeId == context.rootNodeId,
      "the local head followed the remote undo it lost to")
    #expect(try await server.getDocument(documentId: context.documentId)?.currentNodeId
      == context.rootNodeId)
    #expect(await server.renameOrder == ["queued-behind"], "the tail drained")
  }

  @Test("a barrier a crash abandoned is reconciled on the next launch")
  func abandonedBarrierIsReconciledAfterRestart() async throws {
    let server = InMemoryTransport()
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let context = try await rejectedPointerMoveWithTail(mac, server)

    // Exactly what `completeJobAndBlockQueue` commits, with the process dying
    // before the reconciliation that owns the barrier could run: the pointer job
    // is gone, the barrier is on the row, the tail is still queued.
    let pointerJob = try #require(
      try await mac.store.pendingJobs(documentLocalId: context.localId).first)
    try await mac.store.completeJobAndBlockQueue(
      id: try #require(pointerJob.id), documentLocalId: context.localId,
      reason: QueueBlockReason.pointerMoveRejected.rawValue)
    // Record the server's current `updatedAt`, which is what the `draftSave`
    // rejection path does before it blocks. `documents.list` then reports
    // nothing new, so no subscription tick will stumble over this row: the
    // startup sweep is the only thing that can find it.
    let remoteUpdatedAt = try #require(
      try await server.getDocument(documentId: context.documentId)).updatedAt
    try await mac.store.setSyncState(
      documentLocalId: context.localId, .pending, remoteUpdatedAt: remoteUpdatedAt)
    await mac.sync.stop()

    // The relaunch itself has to find it: `drainPass` skips blocked documents,
    // so nothing else ever looks at this row again.
    let relaunched = try Harness(directory: directory, transport: server, origin: "mac")
    await relaunched.sync.start()
    var document = try #require(try await relaunched.store.document(localId: context.localId))
    for _ in 0..<200 where document.queueBlockedReason != nil {
      try await Task.sleep(for: .milliseconds(10))
      await relaunched.sync.drainNow()
      document = try #require(try await relaunched.store.document(localId: context.localId))
    }
    await relaunched.sync.stop()

    #expect(document.queueBlockedReason == nil)
    #expect(try await relaunched.store.pendingJobs(documentLocalId: context.localId).isEmpty)
    #expect(document.localHeadNodeId == context.rootNodeId)
    #expect(await server.renameOrder == ["queued-behind"])
  }

  @Test("a real divergence with a tail keeps its barrier and stays resolvable")
  func divergenceWithTailStaysBlocked() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-diverge-tail")
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
    // A rename queued behind the disputed commit.
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "must-not-be-sent").encoded,
        createdAt: Date().timeIntervalSince1970 * 1000))

    await mac.sync.drainNow()

    // Releasing every barrier would be the opposite mistake: a divergence is a
    // decision the user has not made yet.
    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.syncState == .diverged)
    #expect(document.queueBlockedReason == QueueBlockReason.diverged.rawValue)
    #expect(document.divergedRemoteHeadNodeId != nil)
    #expect(await server.renameOrder.isEmpty, "the tail stayed behind the conflict")

    // And it really is resolvable, which is the whole point of exposing it.
    try await session.resolveDivergenceKeepingRemote()
    await mac.sync.drainNow()
    #expect(try await mac.store.document(localId: localId)?.queueBlockedReason == nil)
    #expect(try await mac.store.pendingJobs(documentLocalId: localId).isEmpty)
  }
}
