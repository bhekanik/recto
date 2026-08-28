import Combine
@preconcurrency import ConvexMobile
import Foundation
import RectoAuth
import RectoHistory
import RectoStore

/// Everything the app is allowed to say to Convex.
///
/// A protocol so the sync engine can be driven by a fake in tests; the live
/// implementation is `ConvexTransport`.
public protocol RectoTransport: Actor {
  func createDocument(title: String) async throws -> CreateDocumentResponse
  func commitEdit(_ request: CommitEditRequest) async throws -> CommitEditResponse
  func updateCurrentNodeId(
    documentId: String, currentNodeId: String, markdown: String, wordCount: Int, updatedAt: Double
  ) async throws -> UpdateCurrentNodeResponse
  func updateMarkdown(
    documentId: String, markdown: String, wordCount: Int, expectedUpdatedAt: Double, title: String?
  ) async throws -> UpdateMarkdownResponse
  func rename(documentId: String, title: String) async throws
  func remove(documentId: String) async throws
  func recordWritingStat(date: String, words: Int) async throws
  func listNodes(documentId: String, sinceCreatedAt: Double?) async throws -> [RemoteNode]
  func getDocument(documentId: String) async throws -> RemoteDocument?

  /// `documents.list`. Terminates permanently on a server error — the caller
  /// re-subscribes on auth transitions rather than assuming it self-heals.
  func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error>
  func nodesStream(documentId: String, sinceCreatedAt: Double?)
    -> AsyncThrowingStream<[RemoteNode], any Error>
  /// Re-authenticate from the keychain session. Idempotent.
  @discardableResult
  func loginFromCache() async -> Bool
}

/// The argument bundle for `documents.commitEdit`.
public struct CommitEditRequest: Sendable, Equatable {
  public var documentId: String
  public var nodeId: String
  public var parentNodeId: String?
  public var patch: String
  public var snapshot: String?
  public var selection: NodeSelection?
  public var origin: String
  public var createdAt: Double
  public var markdown: String
  public var wordCount: Int
  public var expectedHeadNodeId: String
  public var clientMutationId: String

  public init(
    documentId: String, nodeId: String, parentNodeId: String?, patch: String, snapshot: String?,
    selection: NodeSelection?, origin: String, createdAt: Double, markdown: String,
    wordCount: Int, expectedHeadNodeId: String, clientMutationId: String
  ) {
    self.documentId = documentId
    self.nodeId = nodeId
    self.parentNodeId = parentNodeId
    self.patch = patch
    self.snapshot = snapshot
    self.selection = selection
    self.origin = origin
    self.createdAt = createdAt
    self.markdown = markdown
    self.wordCount = wordCount
    self.expectedHeadNodeId = expectedHeadNodeId
    self.clientMutationId = clientMutationId
  }

  /// Convex arguments.
  ///
  /// Every numeric field is a `Double`. `Int` encodes as Convex `$integer`
  /// (a BigInt) and `v.number()` rejects it outright — the N0a spike's sharpest
  /// trap, because the error surfaces as an opaque mutation failure.
  var convexArgs: [String: ConvexEncodable?] {
    var node: [String: ConvexEncodable?] = [
      "nodeId": nodeId,
      "parentNodeId": parentNodeId,
      "patch": patch,
      "selection": selection.map {
        ["anchor": Double($0.anchor), "head": Double($0.head)] as [String: ConvexEncodable?]
      },
      "origin": origin,
      "createdAt": createdAt,
    ]
    // `v.optional()` means "absent", not "null": sending null fails validation.
    if let snapshot { node["snapshot"] = snapshot }

    return [
      "documentId": documentId,
      "node": node,
      "markdown": markdown,
      "wordCount": Double(wordCount),
      "expectedHeadNodeId": expectedHeadNodeId,
      "clientMutationId": clientMutationId,
    ]
  }
}

/// Owns the `ConvexClient`.
///
/// `ConvexClient` is a non-`Sendable` class whose async methods are nonisolated,
/// and `@preconcurrency import` is the only reason Swift 6 accepts passing it
/// into them. Convex issues #21/#26 (auth-bridge thread safety) are unresolved,
/// so every touch of the client happens on this one actor and the instance is
/// never handed to another isolation domain.
public actor ConvexTransport: RectoTransport {
  private let client: ConvexClientWithAuth<String>

  public init(deploymentURL: String, authProvider: ConvexTemplateAuthProvider) async {
    let client = ConvexClientWithAuth<String>(
      deploymentUrl: deploymentURL, authProvider: authProvider)
    self.client = client
    await authProvider.bind(client: client)
  }

  /// Re-authenticate from the keychain session. Safe to call repeatedly.
  @discardableResult
  public func loginFromCache() async -> Bool {
    if case .success = await client.loginFromCache() { return true }
    return false
  }

  public func logout() async {
    await client.logout()
  }

  // MARK: - Subscriptions

  /// `documents.list`, as an async sequence.
  ///
  /// A Convex subscription is a Combine publisher that **terminates permanently
  /// on a server error** — a sign-out race that produces `Unauthenticated`
  /// completes the stream and it never comes back. Callers must re-subscribe on
  /// every auth transition rather than assume it self-heals.
  public func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error> {
    stream(client.subscribe(to: ConvexFunction.documentsList, yielding: [RemoteDocumentSummary].self))
  }

  public func nodesStream(documentId: String, sinceCreatedAt: Double?)
    -> AsyncThrowingStream<[RemoteNode], any Error>
  {
    var args: [String: ConvexEncodable?] = ["documentId": documentId]
    if let sinceCreatedAt { args["sinceCreatedAt"] = sinceCreatedAt }
    return stream(
      client.subscribe(
        to: ConvexFunction.docNodesListSince, with: args, yielding: [RemoteNode].self))
  }

  public func writingStatsStream() -> AsyncThrowingStream<[RemoteWritingStat], any Error> {
    stream(
      client.subscribe(to: ConvexFunction.writingStatsList, yielding: [RemoteWritingStat].self))
  }

  /// `connecting` / `connected`, for the status bar and to trigger a drain.
  public func webSocketStateStream() -> AsyncStream<WebSocketState> {
    let publisher = client.watchWebSocketState()
    return AsyncStream { continuation in
      let subscription = CancellationBox(publisher.sink { continuation.yield($0) })
      continuation.onTermination = { _ in subscription.cancel() }
    }
  }

  private func stream<T: Sendable>(_ publisher: AnyPublisher<T, ClientError>)
    -> AsyncThrowingStream<T, any Error>
  {
    AsyncThrowingStream { continuation in
      let subscription = CancellationBox(
        publisher.sink(
          receiveCompletion: { completion in
            switch completion {
            case .finished: continuation.finish()
            case .failure(let error): continuation.finish(throwing: error)
            }
          },
          receiveValue: { continuation.yield($0) }))
      continuation.onTermination = { _ in subscription.cancel() }
    }
  }

  // MARK: - Queries and mutations

  /// convex-swift has no one-shot query call — a query is always a subscription
  /// (issue #20, no cache either). A single read takes the first value and
  /// cancels, which the publisher's `receiveCancel` turns into an unsubscribe.
  private func firstValue<T: Sendable>(_ stream: AsyncThrowingStream<T, any Error>) async throws
    -> T?
  {
    for try await value in stream { return value }
    return nil
  }

  public func getDocument(documentId: String) async throws -> RemoteDocument? {
    try await firstValue(
      stream(
        client.subscribe(
          to: ConvexFunction.documentsGet, with: ["documentId": documentId],
          yielding: RemoteDocument?.self)))
      ?? nil
  }

  public func listNodes(documentId: String, sinceCreatedAt: Double?) async throws -> [RemoteNode] {
    try await firstValue(nodesStream(documentId: documentId, sinceCreatedAt: sinceCreatedAt)) ?? []
  }

  public func createDocument(title: String) async throws -> CreateDocumentResponse {
    try await client.mutation(ConvexFunction.documentsCreate, with: ["title": title])
  }

  public func commitEdit(_ request: CommitEditRequest) async throws -> CommitEditResponse {
    try await client.mutation(ConvexFunction.documentsCommitEdit, with: request.convexArgs)
  }

  public func updateCurrentNodeId(
    documentId: String, currentNodeId: String, markdown: String, wordCount: Int, updatedAt: Double
  ) async throws -> UpdateCurrentNodeResponse {
    try await client.mutation(
      ConvexFunction.documentsUpdateCurrentNodeId,
      with: [
        "documentId": documentId,
        "currentNodeId": currentNodeId,
        "markdown": markdown,
        "wordCount": Double(wordCount),
        "updatedAt": updatedAt,
      ])
  }

  public func updateMarkdown(
    documentId: String, markdown: String, wordCount: Int, expectedUpdatedAt: Double, title: String?
  ) async throws -> UpdateMarkdownResponse {
    var args: [String: ConvexEncodable?] = [
      "documentId": documentId,
      "markdown": markdown,
      "wordCount": Double(wordCount),
      "expectedUpdatedAt": expectedUpdatedAt,
    ]
    if let title { args["title"] = title }
    return try await client.mutation(ConvexFunction.documentsUpdateMarkdown, with: args)
  }

  public func rename(documentId: String, title: String) async throws {
    try await client.mutation(
      ConvexFunction.documentsRename, with: ["documentId": documentId, "title": title])
  }

  public func remove(documentId: String) async throws {
    try await client.mutation(ConvexFunction.documentsRemove, with: ["documentId": documentId])
  }

  public func recordWritingStat(date: String, words: Int) async throws {
    try await client.mutation(
      ConvexFunction.writingStatsRecord, with: ["date": date, "words": Double(words)])
  }
}

/// `AnyCancellable` is not `Sendable`, but `cancel()` is documented as
/// thread-safe and the box is only ever touched by the stream's termination
/// handler — which is exactly where the subscription has to be torn down.
private final class CancellationBox: @unchecked Sendable {
  private let cancellable: AnyCancellable

  init(_ cancellable: AnyCancellable) { self.cancellable = cancellable }

  func cancel() { cancellable.cancel() }
}
