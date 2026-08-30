import Foundation
import RectoHistory
import RectoStore
import RectoSync

/// The database-backed cloud document library.
///
/// This is the only native product API that creates an offline document. It
/// keeps the document row, local root node, and create outbox mutation behind
/// one call so SwiftUI cannot accidentally split the transaction.
public actor DocumentLibrary {
  private let store: RectoStore
  private let sync: SyncEngine?
  private let origin: String
  private let makeLocalId: @Sendable () -> String
  private let makeNodeId: @Sendable () -> String
  private let makeMutationId: @Sendable () -> String
  private let now: @Sendable () -> Double

  public init(store: RectoStore, sync: SyncEngine?, origin: String) {
    self.init(
      store: store,
      sync: sync,
      origin: origin,
      localId: { UUID().uuidString },
      nodeId: { ulid() },
      mutationId: { ulid() },
      now: { Date().timeIntervalSince1970 * 1_000 })
  }

  init(
    store: RectoStore,
    sync: SyncEngine?,
    origin: String,
    localId: @escaping @Sendable () -> String,
    nodeId: @escaping @Sendable () -> String,
    mutationId: @escaping @Sendable () -> String,
    now: @escaping @Sendable () -> Double
  ) {
    self.store = store
    self.sync = sync
    self.origin = origin
    self.makeLocalId = localId
    self.makeNodeId = nodeId
    self.makeMutationId = mutationId
    self.now = now
  }

  public func documents() async throws -> [DocumentRecord] {
    try await store.documents()
  }

  @discardableResult
  public func createDocument(title: String) async throws -> DocumentRecord {
    let localId = makeLocalId()
    let rootNodeId = makeNodeId()
    let timestamp = now()
    let document = DocumentRecord(
      localId: localId,
      title: title,
      markdown: "",
      wordCount: 0,
      localHeadNodeId: rootNodeId,
      syncState: .pending,
      updatedAt: timestamp,
      createdAt: timestamp)
    let rootNode = DocNodeRecord(
      documentLocalId: localId,
      nodeId: rootNodeId,
      parentNodeId: nil,
      patch: TextPatch(from: 0, to: 0, insert: "").encoded,
      snapshot: "",
      origin: origin,
      createdAt: timestamp,
      materialized: "",
      materializedAt: timestamp,
      synced: false)
    let createJob = OutboxJob(
      documentLocalId: localId,
      kind: .createDocument,
      clientMutationId: makeMutationId(),
      payload: OutboxPayload(title: title).encoded,
      createdAt: timestamp)

    let created = try await store.createLocalDocument(
      document,
      rootNode: rootNode,
      createJob: createJob)
    await sync?.requestDrain()
    return created
  }
}
