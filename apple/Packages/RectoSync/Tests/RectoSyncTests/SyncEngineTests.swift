import Foundation
import RectoHistory
import RectoStore
import RectoSyncTesting
import Testing

@testable import RectoSync

private func makeEngine(_ transport: InMemoryTransport) throws -> (RectoStore, SyncEngine) {
  let store = try RectoStore.inMemory()
  return (store, SyncEngine(store: store, transport: transport, origin: "test-device"))
}

@Suite("SyncEngine")
struct SyncEngineTests {
  @Test("lost delete answer followed by not_found acknowledges the delete")
  func deleteReplayTreatsNotFoundAsAcknowledged() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "delete replay")
    let (store, engine) = try makeEngine(transport)
    try await engine.mirrorLibrary(await transport.summaries())
    let local = try #require(try await store.documents().first)
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: local.localId,
        kind: .remove,
        clientMutationId: ulid(),
        payload: OutboxPayload().encoded,
        createdAt: 1))

    await transport.inject([.dropAcknowledgement])
    await engine.drainNow()

    #expect(try await transport.getDocument(documentId: seeded.documentId) == nil)
    #expect(try await store.document(localId: local.localId) != nil)
    let failed = try #require(try await store.pendingJobs(documentLocalId: local.localId).first)
    #expect(failed.attempts == 1)
    try await store.failJob(
      id: try #require(failed.id), error: "", retryAfter: 0, now: 0)

    await engine.drainNow()

    #expect(try await store.document(localId: local.localId) == nil)
    #expect(try await store.pendingJobs(documentLocalId: local.localId).isEmpty)
  }

  @Test("a document seen for the first time is hydrated with its whole DAG")
  func hydratesNewDocument() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-hydrate")
    _ = try await transport.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "remote text")
    let (store, engine) = try makeEngine(transport)

    try await engine.mirrorLibrary(await transport.summaries())

    let documents = try await store.documents()
    #expect(documents.count == 1)
    let local = try #require(documents.first)
    #expect(local.convexId == seeded.documentId)
    #expect(local.markdown == "remote text")
    #expect(local.syncState == .synced)
    #expect(try await store.nodes(documentLocalId: local.localId).count == 2)
  }

  @Test("a title change from another device lands without re-hydrating")
  func mirrorsTitleChange() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-before")
    let (store, engine) = try makeEngine(transport)
    try await engine.mirrorLibrary(await transport.summaries())

    try await transport.rename(documentId: seeded.documentId, title: "native-spike-after")
    try await engine.mirrorLibrary(await transport.summaries())

    let documents = try await store.documents()
    #expect(documents.count == 1)
    #expect(documents.first?.title == "native-spike-after")
  }

  @Test("a document deleted elsewhere is dropped locally")
  func removesDeletedDocument() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-delete")
    let (store, engine) = try makeEngine(transport)
    try await engine.mirrorLibrary(await transport.summaries())
    #expect(try await store.documents().count == 1)

    try await transport.remove(documentId: seeded.documentId)
    try await engine.mirrorLibrary(await transport.summaries())
    #expect(try await store.documents().isEmpty)
  }

  @Test("a document with unsent work is not dropped when the server forgets it")
  func keepsDocumentWithPendingWork() async throws {
    // Losing a device's only copy of unsent text because a list query raced a
    // create would be unrecoverable, so the outbox wins.
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument(title: "native-spike-pending")
    let (store, engine) = try makeEngine(transport)
    try await engine.mirrorLibrary(await transport.summaries())
    let local = try #require(try await store.documents().first)
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: local.localId, kind: .commitEdit, clientMutationId: ulid(),
        payload: "{}", createdAt: 0))

    try await transport.remove(documentId: seeded.documentId)
    try await engine.mirrorLibrary(await transport.summaries())
    #expect(try await store.documents().count == 1)
  }

  @Test("an unstarted engine never reaches the network")
  func requestDrainIsInertUntilStarted() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument()
    let (store, engine) = try makeEngine(transport)
    try await engine.mirrorLibrary(await transport.summaries())
    let local = try #require(try await store.documents().first)

    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: local.localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "native-spike-renamed").encoded, createdAt: 0))
    await engine.requestDrain()
    try await Task.sleep(for: .milliseconds(50))
    #expect(try await store.pendingJobCount() == 1)

    await engine.drainNow()
    #expect(try await store.pendingJobCount() == 0)
    #expect(try await transport.getDocument(documentId: seeded.documentId)?.title == "native-spike-renamed")
  }

  @Test("a document created offline adopts the server's root node id")
  func adoptsServerRoot() async throws {
    let transport = InMemoryTransport()
    let (store, engine) = try makeEngine(transport)
    let localId = UUID().uuidString
    let localRoot = ulid()
    try await store.save(
      DocumentRecord(
        localId: localId, title: "native-spike-offline-create", markdown: "", wordCount: 0,
        localHeadNodeId: localRoot, syncState: .pending, updatedAt: 0, createdAt: 0))
    try await store.mergeRemoteNodes(
      documentLocalId: localId,
      nodes: [
        DocNodeRecord(
          documentLocalId: localId, nodeId: localRoot, parentNodeId: nil,
          patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "", origin: "local",
          createdAt: 0)
      ])
    // A child of the local root, the way an offline edit produces one.
    let child = ulid()
    try await store.mergeRemoteNodes(
      documentLocalId: localId,
      nodes: [
        DocNodeRecord(
          documentLocalId: localId, nodeId: child, parentNodeId: localRoot,
          patch: computePatch("", "offline text").encoded, origin: "local", createdAt: 1)
      ])
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .createDocument, clientMutationId: ulid(),
        payload: OutboxPayload(title: "native-spike-offline-create").encoded, createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .commitEdit, clientMutationId: ulid(),
        baseHeadNodeId: localRoot,
        payload: OutboxPayload(
          nodeId: child, parentNodeId: localRoot,
          patch: computePatch("", "offline text").encoded, origin: "local", createdAt: 1,
          markdown: "offline text", wordCount: 2
        ).encoded,
        createdAt: 1))

    await engine.drainNow()

    let convexId = try #require(try await store.document(localId: localId)?.convexId)
    // The device's root is gone; the child now hangs off the server's root, so
    // its patch still applies to the same (empty) base.
    let serverRootId = try #require(
      try await transport.listNodes(documentId: convexId, sinceCreatedAt: nil)
        .first { $0.parentNodeId == nil }?.nodeId)
    #expect(serverRootId != localRoot)
    #expect(try await store.node(documentLocalId: localId, nodeId: localRoot) == nil)
    #expect(
      try await store.node(documentLocalId: localId, nodeId: child)?.parentNodeId == serverRootId)
    #expect(try await transport.getDocument(documentId: convexId)?.markdown == "offline text")
    #expect(
      try await store.materializedMarkdown(documentLocalId: localId, nodeId: child)
        == "offline text")
  }
}
