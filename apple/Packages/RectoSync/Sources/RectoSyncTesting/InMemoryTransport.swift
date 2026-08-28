import Foundation
import RectoHistory
import RectoSync

/// A faithful in-memory stand-in for the deployed Convex functions.
///
/// It reimplements `convex/documents.ts` and `convex/docNodes.ts` closely enough
/// that the interesting paths — `commitEdit`'s single-slot replay window, the
/// node insert that happens regardless of the head check, `updateMarkdown`'s
/// stale CAS — behave the way the server does. Tests that only exercise a
/// hand-wavy fake prove nothing about the outbox.
///
/// It also injects the faults a real deployment produces: a dropped
/// acknowledgement, an expired token, an offline socket.
public actor InMemoryTransport: RectoTransport {
  public struct Document: Sendable {
    public var id: String
    public var title: String
    public var markdown: String
    public var wordCount: Double
    public var currentNodeId: String
    public var createdAt: Double
    public var updatedAt: Double
    public var lastCommit: (clientMutationId: String, headNodeId: String, updatedAt: Double)?
  }

  public enum Fault: Sendable, Equatable {
    /// Throw before doing anything — the network is down.
    case offline
    /// Reject with an auth error; the engine should re-authenticate and retry.
    case tokenExpired
    /// Apply the mutation, then throw. The client never learns it succeeded and
    /// must replay the same `clientMutationId`.
    case dropAcknowledgement
  }

  public private(set) var documents: [String: Document] = [:]
  public private(set) var nodes: [String: [RemoteNode]] = [:]
  public private(set) var writingStats: [String: Double] = [:]
  /// Every `clientMutationId` the transport has been asked to commit, in order —
  /// including replays, so a test can assert a retry reused the key.
  public private(set) var commitAttempts: [String] = []
  public private(set) var loginCount = 0

  private var faults: [Fault] = []
  private var clock: Double

  public init(now: Double = 1_000_000) {
    self.clock = now
  }

  private func tick() -> Double {
    clock += 1
    return clock
  }

  // MARK: - Fault injection

  /// Queue faults; each applies to one MUTATION, in order.
  ///
  /// Reads (`listNodes`, `getDocument`, the streams) are deliberately exempt: a
  /// background node subscription would otherwise race the drain for the next
  /// queued fault and the test would pass or fail on timing.
  public func inject(_ faults: [Fault]) { self.faults = faults }

  private func takeFault() -> Fault? {
    faults.isEmpty ? nil : faults.removeFirst()
  }

  private func applyPreFault() throws {
    switch faults.first {
    case .offline:
      _ = takeFault()
      throw TransportFault.offline
    case .tokenExpired:
      _ = takeFault()
      throw TransportFault.unauthenticated
    default:
      return
    }
  }

  public enum TransportFault: Error, Equatable {
    case offline
    /// Spelled the way the Convex client reports it, because the engine matches
    /// on the message to decide whether to re-authenticate.
    case unauthenticated
    case documentNotFound
  }

  // MARK: - Seeding

  @discardableResult
  public func seedDocument(id: String = UUID().uuidString, title: String = "native-spike-seed")
    -> CreateDocumentResponse
  {
    let rootNodeId = UUID().uuidString
    let now = tick()
    documents[id] = Document(
      id: id, title: title, markdown: "", wordCount: 0, currentNodeId: rootNodeId,
      createdAt: now, updatedAt: now, lastCommit: nil)
    nodes[id] = [
      RemoteNode(
        nodeId: rootNodeId, parentNodeId: nil,
        patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "", selection: nil,
        origin: "server", createdAt: now)
    ]
    return CreateDocumentResponse(documentId: id, rootNodeId: rootNodeId)
  }

  /// Another client committing. Uses the same code path as `commitEdit`.
  @discardableResult
  public func commitFromOtherClient(
    documentId: String, parentNodeId: String, markdown: String, nodeId: String = ulid()
  ) throws -> String {
    guard let document = documents[documentId] else { throw TransportFault.documentNotFound }
    let parentMarkdown = try materializeRemote(documentId: documentId, nodeId: parentNodeId)
    let patch = computePatch(parentMarkdown, markdown).encoded
    let now = tick()
    nodes[documentId, default: []].append(
      RemoteNode(
        nodeId: nodeId, parentNodeId: parentNodeId, patch: patch, snapshot: nil, selection: nil,
        origin: "other-device", createdAt: now))
    if document.currentNodeId == parentNodeId {
      documents[documentId]?.currentNodeId = nodeId
      documents[documentId]?.markdown = markdown
      documents[documentId]?.updatedAt = now
    }
    return nodeId
  }

  public func materializeRemote(documentId: String, nodeId: String) throws -> String {
    let index = indexNodes((nodes[documentId] ?? []).map { $0.record(documentLocalId: "").docNode })
    return try materialize(nodeId, index)
  }

  // MARK: - RectoTransport

  public func createDocument(title: String) async throws -> CreateDocumentResponse {
    try applyPreFault()
    return seedDocument(title: title)
  }

  public func commitEdit(_ request: CommitEditRequest) async throws -> CommitEditResponse {
    try applyPreFault()
    commitAttempts.append(request.clientMutationId)
    guard var document = documents[request.documentId] else { throw TransportFault.documentNotFound }

    // Replay of an attempt already answered — same answer.
    if let last = document.lastCommit, last.clientMutationId == request.clientMutationId {
      return CommitEditResponse(
        committed: true, headNodeId: last.headNodeId, updatedAt: last.updatedAt, diverged: nil,
        remoteHeadNodeId: nil)
    }

    // The node row is inserted regardless of the head check: the DAG is
    // append-only, so a node is never wrong — only the pointer is contended.
    if !(nodes[request.documentId] ?? []).contains(where: { $0.nodeId == request.nodeId }) {
      nodes[request.documentId, default: []].append(
        RemoteNode(
          nodeId: request.nodeId, parentNodeId: request.parentNodeId, patch: request.patch,
          snapshot: request.snapshot,
          selection: request.selection.map {
            RemoteNode.Selection(anchor: Double($0.anchor), head: Double($0.head))
          },
          origin: request.origin, createdAt: request.createdAt))
    }

    if document.currentNodeId == request.nodeId {
      return CommitEditResponse(
        committed: true, headNodeId: document.currentNodeId, updatedAt: document.updatedAt,
        diverged: nil, remoteHeadNodeId: nil)
    }

    guard document.currentNodeId == request.expectedHeadNodeId else {
      return CommitEditResponse(
        committed: false, headNodeId: nil, updatedAt: nil, diverged: true,
        remoteHeadNodeId: document.currentNodeId)
    }

    let updatedAt = tick()
    document.currentNodeId = request.nodeId
    document.markdown = request.markdown
    document.wordCount = Double(request.wordCount)
    document.updatedAt = updatedAt
    document.lastCommit = (request.clientMutationId, request.nodeId, updatedAt)
    documents[request.documentId] = document

    if faults.first == .dropAcknowledgement {
      _ = takeFault()
      throw TransportFault.offline
    }

    return CommitEditResponse(
      committed: true, headNodeId: request.nodeId, updatedAt: updatedAt, diverged: nil,
      remoteHeadNodeId: nil)
  }

  public func updateCurrentNodeId(
    documentId: String, currentNodeId: String, markdown: String, wordCount: Int, updatedAt: Double
  ) async throws -> UpdateCurrentNodeResponse {
    try applyPreFault()
    guard var document = documents[documentId] else { throw TransportFault.documentNotFound }
    if updatedAt < document.updatedAt {
      return UpdateCurrentNodeResponse(
        applied: false, currentNodeId: document.currentNodeId, updatedAt: nil)
    }
    let now = tick()
    document.currentNodeId = currentNodeId
    document.markdown = markdown
    document.wordCount = Double(wordCount)
    document.updatedAt = now
    documents[documentId] = document
    return UpdateCurrentNodeResponse(applied: true, currentNodeId: currentNodeId, updatedAt: now)
  }

  public func updateMarkdown(
    documentId: String, markdown: String, wordCount: Int, expectedUpdatedAt: Double, title: String?
  ) async throws -> UpdateMarkdownResponse {
    try applyPreFault()
    guard var document = documents[documentId] else { throw TransportFault.documentNotFound }
    guard document.updatedAt == expectedUpdatedAt else {
      return UpdateMarkdownResponse(updatedAt: document.updatedAt, stale: true)
    }
    let now = tick()
    document.markdown = markdown
    document.wordCount = Double(wordCount)
    document.updatedAt = now
    if let title { document.title = title }
    documents[documentId] = document
    return UpdateMarkdownResponse(updatedAt: now, stale: false)
  }

  public func rename(documentId: String, title: String) async throws {
    try applyPreFault()
    documents[documentId]?.title = title
    documents[documentId]?.updatedAt = tick()
  }

  public func remove(documentId: String) async throws {
    try applyPreFault()
    documents[documentId] = nil
    nodes[documentId] = nil
  }

  public func recordWritingStat(date: String, words: Int) async throws {
    try applyPreFault()
    writingStats[date] = max(writingStats[date] ?? 0, Double(words))
  }

  public func listNodes(documentId: String, sinceCreatedAt: Double?) async throws -> [RemoteNode] {
    let all = nodes[documentId] ?? []
    guard let sinceCreatedAt else { return all }
    return all.filter { $0.createdAt > sinceCreatedAt }
  }

  public func getDocument(documentId: String) async throws -> RemoteDocument? {
    guard let document = documents[documentId] else { return nil }
    return RemoteDocument(
      id: document.id, title: document.title, markdown: document.markdown,
      wordCount: document.wordCount, currentNodeId: document.currentNodeId,
      createdAt: document.createdAt, updatedAt: document.updatedAt)
  }

  public nonisolated func documentsStream()
    -> AsyncThrowingStream<[RemoteDocumentSummary], any Error>
  {
    AsyncThrowingStream { continuation in
      Task { [weak self] in
        guard let self else { return continuation.finish() }
        continuation.yield(await self.summaries())
        continuation.finish()
      }
    }
  }

  public nonisolated func nodesStream(documentId: String, sinceCreatedAt: Double?)
    -> AsyncThrowingStream<[RemoteNode], any Error>
  {
    AsyncThrowingStream { continuation in
      Task { [weak self] in
        guard let self else { return continuation.finish() }
        continuation.yield((try? await self.listNodes(documentId: documentId, sinceCreatedAt: sinceCreatedAt)) ?? [])
        continuation.finish()
      }
    }
  }

  public func loginFromCache() async -> Bool {
    loginCount += 1
    return true
  }

  /// What `documents.list` would return right now.
  public func summaries() -> [RemoteDocumentSummary] {
    documents.values
      .map {
        RemoteDocumentSummary(id: $0.id, title: $0.title, wordCount: $0.wordCount, updatedAt: $0.updatedAt)
      }
      .sorted { $0.updatedAt > $1.updatedAt }
  }
}
