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
    /// Which node `markdown` belongs to. `nil` means unknown provenance — what a
    /// legacy `updateMarkdown` without the head CAS leaves behind.
    public var markdownHeadNodeId: String?
    public var pointerRevision: Double
    public var createdAt: Double
    public var updatedAt: Double
    public var lastCommit:
      (clientMutationId: String, headNodeId: String, updatedAt: Double, pointerRevision: Double)?
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
  /// Held open until `releaseDelayedCalls()`. Lets a test park a mutation
  /// mid-flight and then run a sign-out or account switch underneath it.
  ///
  /// Deliberately NOT cancellation-aware: a real Convex call does not abort when
  /// its Task is cancelled, and a gate that did would make `stop()` look correct
  /// when it is not.
  private var gateWaiters: [CheckedContinuation<Void, Never>] = []
  private var gateIsOpen = false
  public private(set) var delayedCallsStarted = 0
  private var clock: Double

  /// Epoch milliseconds by default. `updateCurrentNodeId` is last-write-wins on
  /// `updatedAt`, so a fake clock starting near zero would accept every pointer
  /// move a client ever sent and the rejection path would be untestable.
  public init(now: Double = Date().timeIntervalSince1970 * 1000) {
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

  /// Every mutation waits here first once `delayCalls()` is on.
  public func delayCalls() { gateIsOpen = true }

  public func releaseDelayedCalls() {
    gateIsOpen = false
    let waiters = gateWaiters
    gateWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func awaitGate() async {
    guard gateIsOpen else { return }
    delayedCallsStarted += 1
    await withCheckedContinuation { continuation in
      gateWaiters.append(continuation)
    }
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
    /// `documents.updateCurrentNodeId` refuses a head that is not in the DAG.
    case unknownPointerTarget
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
      // `documents.create` writes no `markdownHeadNodeId`: the body is empty and
      // its provenance is genuinely unknown until something stamps it.
      markdownHeadNodeId: nil, pointerRevision: 0, createdAt: now, updatedAt: now,
      lastCommit: nil)
    nodes[id] = [
      RemoteNode(
        nodeId: rootNodeId, parentNodeId: nil,
        patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "", selection: nil,
        origin: "server", createdAt: now)
    ]
    // Convex invalidates `documents.list` and this document's node query.
    notifyDocumentSubscribers()
    notifyNodeSubscribers(documentId: id)
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
      documents[documentId]?.pointerRevision = document.pointerRevision + 1
      // A commit writes body and head together, so the body's provenance is the
      // node it just committed.
      documents[documentId]?.markdownHeadNodeId = nodeId
    }
    notifyNodeSubscribers(documentId: documentId)
    notifyDocumentSubscribers()
    return nodeId
  }

  /// Append a node whose patch cannot be decoded, and point the head at it.
  /// Models a DAG that arrived corrupt or was written by a newer client.
  @discardableResult
  public func appendBrokenNode(documentId: String, parentNodeId: String, markdown: String) throws
    -> String
  {
    guard var document = documents[documentId] else { throw TransportFault.documentNotFound }
    let nodeId = ulid()
    let now = tick()
    nodes[documentId, default: []].append(
      RemoteNode(
        nodeId: nodeId, parentNodeId: parentNodeId, patch: "{ not a patch",
        snapshot: nil, selection: nil, origin: "other", createdAt: now))
    document.currentNodeId = nodeId
    document.markdown = markdown
    document.markdownHeadNodeId = nodeId
    document.updatedAt = now
    document.pointerRevision += 1
    documents[documentId] = document
    notifyDocumentSubscribers()
    notifyNodeSubscribers(documentId: documentId)
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
        committed: true, headNodeId: last.headNodeId, updatedAt: last.updatedAt,
        pointerRevision: last.pointerRevision)
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
        pointerRevision: document.pointerRevision)
    }

    guard document.currentNodeId == request.expectedHeadNodeId else {
      return CommitEditResponse(
        committed: false, headNodeId: nil, updatedAt: nil, diverged: true,
        remoteHeadNodeId: document.currentNodeId,
        remotePointerRevision: document.pointerRevision)
    }

    let updatedAt = tick()
    let pointerRevision = document.pointerRevision + 1
    document.currentNodeId = request.nodeId
    document.markdown = request.markdown
    document.wordCount = Double(request.wordCount)
    document.updatedAt = updatedAt
    document.pointerRevision = pointerRevision
    // `commitEdit` writes the body and the head together, so the body's
    // provenance is exactly the node it just committed.
    document.markdownHeadNodeId = request.nodeId
    document.lastCommit = (request.clientMutationId, request.nodeId, updatedAt, pointerRevision)
    documents[request.documentId] = document

    if faults.first == .dropAcknowledgement {
      _ = takeFault()
      throw TransportFault.offline
    }

    notifyDocumentSubscribers()
    notifyNodeSubscribers(documentId: request.documentId)
    return CommitEditResponse(
      committed: true, headNodeId: request.nodeId, updatedAt: updatedAt,
      pointerRevision: pointerRevision)
  }

  /// `docNodes.append`: idempotent on (documentId, nodeId), and it never writes
  /// `currentNodeId`.
  public func appendNode(documentId: String, node: CommitEditRequest) async throws {
    try applyPreFault()
    guard documents[documentId] != nil else { throw TransportFault.documentNotFound }
    guard !(nodes[documentId] ?? []).contains(where: { $0.nodeId == node.nodeId }) else { return }
    nodes[documentId, default: []].append(
      RemoteNode(
        nodeId: node.nodeId, parentNodeId: node.parentNodeId, patch: node.patch,
        snapshot: node.snapshot,
        selection: node.selection.map {
          RemoteNode.Selection(anchor: Double($0.anchor), head: Double($0.head))
        },
        origin: node.origin, createdAt: node.createdAt))
    notifyNodeSubscribers(documentId: documentId)
  }

  public func updateCurrentNodeId(
    documentId: String, currentNodeId: String, markdown: String, wordCount: Int, updatedAt: Double
  ) async throws -> UpdateCurrentNodeResponse {
    try applyPreFault()
    guard var document = documents[documentId] else { throw TransportFault.documentNotFound }
    // The server validates the pointer target (`Unknown currentNodeId`). A fake
    // that accepts anything lets a test pass against a state the deployment
    // cannot produce.
    guard (nodes[documentId] ?? []).contains(where: { $0.nodeId == currentNodeId }) else {
      throw TransportFault.unknownPointerTarget
    }
    if updatedAt < document.updatedAt {
      // Lost the last-write-wins check: hand back the head that won so the
      // caller reconciles instead of guessing.
      return UpdateCurrentNodeResponse(
        applied: false, currentNodeId: document.currentNodeId, updatedAt: nil,
        pointerRevision: document.pointerRevision)
    }
    let now = tick()
    let pointerRevision = document.pointerRevision + 1
    document.currentNodeId = currentNodeId
    document.markdown = markdown
    document.wordCount = Double(wordCount)
    document.updatedAt = now
    document.pointerRevision = pointerRevision
    document.markdownHeadNodeId = currentNodeId
    documents[documentId] = document
    notifyDocumentSubscribers()
    return UpdateCurrentNodeResponse(
      applied: true, currentNodeId: currentNodeId, updatedAt: now,
      pointerRevision: pointerRevision)
  }

  public func updateMarkdown(
    documentId: String, markdown: String, wordCount: Int, expectedUpdatedAt: Double,
    expectedHeadNodeId: String?, title: String?
  ) async throws -> UpdateMarkdownResponse {
    try applyPreFault()
    guard var document = documents[documentId] else { throw TransportFault.documentNotFound }
    // A diverged head is NOT retryable: accepting the draft would leave
    // `markdown` describing a branch that `currentNodeId` no longer points at.
    if let expectedHeadNodeId, document.currentNodeId != expectedHeadNodeId {
      return UpdateMarkdownResponse(
        updatedAt: document.updatedAt, stale: true, headMoved: true)
    }
    guard document.updatedAt == expectedUpdatedAt else {
      return UpdateMarkdownResponse(
        updatedAt: document.updatedAt, stale: true, headMoved: false)
    }
    let now = tick()
    document.markdown = markdown
    document.wordCount = Double(wordCount)
    document.updatedAt = now
    // A caller that passed the CAS proved which head this text belongs to; a
    // legacy caller has not, so its write CLEARS the stamp rather than leaving a
    // stale one another device could promote into the wrong branch.
    document.markdownHeadNodeId = expectedHeadNodeId
    if let title { document.title = title }
    documents[documentId] = document
    notifyDocumentSubscribers()
    return UpdateMarkdownResponse(updatedAt: now, stale: false, headMoved: false)
  }

  /// Titles in the order `rename` received them, for drain-ordering tests.
  public private(set) var renameOrder: [String] = []

  public func rename(documentId: String, title: String) async throws {
    await awaitGate()
    try applyPreFault()
    documents[documentId]?.title = title
    documents[documentId]?.updatedAt = tick()
    renameOrder.append(title)
    notifyDocumentSubscribers()
  }

  public func remove(documentId: String) async throws {
    try applyPreFault()
    documents[documentId] = nil
    nodes[documentId] = nil
    notifyDocumentSubscribers()
    notifyNodeSubscribers(documentId: documentId)
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
      markdownHeadNodeId: document.markdownHeadNodeId,
      pointerRevision: document.pointerRevision, createdAt: document.createdAt,
      updatedAt: document.updatedAt)
  }

  // MARK: - Live subscriptions

  /// Long-lived streams, like the real client's. A one-shot stream cannot
  /// exercise a remote update arriving mid-session, a reconnect, or an auth
  /// transition — the flows this transport exists to test.
  private var documentSubscribers: [UUID: AsyncThrowingStream<[RemoteDocumentSummary], any Error>.Continuation] = [:]
  private var nodeSubscribers: [UUID: (documentId: String, continuation: AsyncThrowingStream<[RemoteNode], any Error>.Continuation)] = [:]

  public func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error> {
    let (stream, continuation) = AsyncThrowingStream<[RemoteDocumentSummary], any Error>
      .makeStream()
    let id = UUID()
    documentSubscribers[id] = continuation
    continuation.yield(summaries())
    continuation.onTermination = { [weak self] _ in
      Task { await self?.dropDocumentSubscriber(id) }
    }
    return stream
  }

  public func nodesStream(documentId: String, sinceCreatedAt: Double?)
    -> AsyncThrowingStream<[RemoteNode], any Error>
  {
    let (stream, continuation) = AsyncThrowingStream<[RemoteNode], any Error>.makeStream()
    let id = UUID()
    nodeSubscribers[id] = (documentId, continuation)
    continuation.yield(nodes[documentId] ?? [])
    continuation.onTermination = { [weak self] _ in
      Task { await self?.dropNodeSubscriber(id) }
    }
    return stream
  }

  private func dropDocumentSubscriber(_ id: UUID) { documentSubscribers[id] = nil }
  private func dropNodeSubscriber(_ id: UUID) { nodeSubscribers[id] = nil }

  private func notifyDocumentSubscribers() {
    let current = summaries()
    for continuation in documentSubscribers.values { continuation.yield(current) }
  }

  private func notifyNodeSubscribers(documentId: String) {
    let current = nodes[documentId] ?? []
    for subscriber in nodeSubscribers.values where subscriber.documentId == documentId {
      subscriber.continuation.yield(current)
    }
  }

  /// Terminate every live subscription with an error, the way Convex does when a
  /// query throws — the failure mode that never recovers on its own.
  public func failAllSubscriptions(_ error: any Error = TransportFault.unauthenticated) {
    for continuation in documentSubscribers.values { continuation.finish(throwing: error) }
    for subscriber in nodeSubscribers.values { subscriber.continuation.finish(throwing: error) }
    documentSubscribers.removeAll()
    nodeSubscribers.removeAll()
  }

  public var liveSubscriptionCount: Int { documentSubscribers.count + nodeSubscribers.count }

  /// Write a body the way another device's draft save would, stamped with the
  /// node it belongs to (or deliberately unstamped, for the untrusted case).
  public func writeServerDraft(
    documentId: String, markdown: String, stampedHeadNodeId: String?
  ) throws {
    guard var document = documents[documentId] else { throw TransportFault.documentNotFound }
    document.markdown = markdown
    document.markdownHeadNodeId = stampedHeadNodeId
    document.updatedAt = tick()
    documents[documentId] = document
    notifyDocumentSubscribers()
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
