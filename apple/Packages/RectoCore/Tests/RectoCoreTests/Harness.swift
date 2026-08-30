import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting

@testable import RectoCore

/// A whole client: mirror, transport, sync engine, session registry.
///
/// File-backed by default so a test can drop it and reopen the same database —
/// which is the only honest way to test "kill the process and relaunch".
struct Harness {
  let directory: URL
  let store: RectoStore
  let transport: InMemoryTransport
  let sync: SyncEngine
  let registry: DocumentSessionRegistry

  init(directory: URL, transport: InMemoryTransport, origin: String = "test-device") throws {
    self.directory = directory
    self.transport = transport
    self.store = try RectoStore(url: directory.appending(path: "recto.sqlite"))
    self.sync = SyncEngine(store: store, transport: transport, origin: origin)
    self.registry = DocumentSessionRegistry(store: store, sync: sync, origin: origin)
  }

  static func makeDirectory() -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "recto-core-test-\(UUID().uuidString)")
  }

  /// A local document that has never been sent, the way "New Document" offline
  /// creates one: a root node minted on the device and a `createDocument` job.
  @discardableResult
  func createLocalDocument(title: String = "native-spike-doc", localId: String = UUID().uuidString)
    async throws -> String
  {
    let library = DocumentLibrary(
      store: store,
      sync: nil,
      origin: "local",
      localId: { localId },
      nodeId: { ulid() },
      mutationId: { ulid() },
      now: { Date().timeIntervalSince1970 * 1_000 })
    return try await library.createDocument(title: title).localId
  }

  /// Adopt a document that already exists on the server.
  @discardableResult
  func adoptRemoteDocument(_ response: CreateDocumentResponse, localId: String = UUID().uuidString)
    async throws -> String
  {
    let remote = try await transport.getDocument(documentId: response.documentId)!
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
}
