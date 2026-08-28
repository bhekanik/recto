import ClerkKit
import Foundation
import RectoAuth
import RectoHistory
import RectoStore
import RectoSync
import Testing

@testable import RectoCore

/// Live tests against the dev Convex deployment.
///
/// The suite is *skipped*, not failed, unless the environment supplies a
/// deployment and a Clerk publishable key — a plain `swift test` on this package
/// has to stay green. Sign-in uses Clerk's `+clerk_test` address and the fixed
/// `424242` code, which needs no mailbox and no `CLERK_SECRET_KEY`.
///
///   RECTO_CONVEX_URL=https://<deployment>.convex.cloud \
///   RECTO_CLERK_PUBLISHABLE_KEY=pk_test_… \
///   swift test --filter LiveConvex
///
/// Every document it creates is titled `native-spike-…` and deleted in the same
/// test, so a failure leaves at most one row behind on a shared deployment.
struct LiveConfig {
  let convexURL: String
  let publishableKey: String
  let email: String
  let code: String

  static func fromEnvironment() -> LiveConfig? {
    let environment = ProcessInfo.processInfo.environment
    guard let convexURL = environment["RECTO_CONVEX_URL"],
      let publishableKey = environment["RECTO_CLERK_PUBLISHABLE_KEY"]
    else { return nil }
    return LiveConfig(
      convexURL: convexURL,
      publishableKey: publishableKey,
      email: environment["RECTO_TEST_EMAIL"] ?? "recto-e2e+clerk_test@example.com",
      code: environment["RECTO_TEST_CODE"] ?? "424242")
  }
}

/// Gate for the suite's `.enabled(if:)` trait.
enum LiveConvexEnvironment {
  static var isConfigured: Bool { LiveConfig.fromEnvironment() != nil }
}

/// One signed-in client, shared by every test in the suite: Clerk refuses to be
/// configured twice in a process.
actor LiveClient {
  static let shared = LiveClient()

  private var prepared: (store: RectoStore, sync: SyncEngine, transport: ConvexTransport)?

  func connect(_ config: LiveConfig, directory: URL) async throws -> (
    store: RectoStore, sync: SyncEngine, transport: ConvexTransport
  ) {
    if let prepared { return prepared }

    await MainActor.run { RectoAuth.configureClerk(publishableKey: config.publishableKey) }
    let store = try RectoStore(url: directory.appending(path: "recto.sqlite"))
    let auth = await RectoAuth(store: store, features: .current)
    await auth.start()

    if await auth.status.userId == nil {
      var challenge = try await auth.signInWithEmailCode(emailAddress: config.email)
      try await challenge.verify(code: config.code)
      // The session takes a moment to become active after verification.
      for _ in 0..<50 where await auth.status.userId == nil {
        try await Task.sleep(for: .milliseconds(100))
      }
    }

    let transport = await ConvexTransport(
      deploymentURL: config.convexURL, authProvider: await auth.convexAuthProvider)
    guard await transport.loginFromCache() else {
      throw LiveError.convexLoginFailed
    }
    let sync = SyncEngine(store: store, transport: transport, origin: "integration-test")
    let result = (store, sync, transport)
    prepared = result
    return result
  }

  enum LiveError: Error { case convexLoginFailed }
}

@Suite(
  "LiveConvex", .serialized,
  .enabled(
    if: LiveConvexEnvironment.isConfigured,
    "set RECTO_CONVEX_URL and RECTO_CLERK_PUBLISHABLE_KEY to run the live Convex tests"))
struct LiveConvexTests {
  @Test("create, commit, undo and delete a document against the dev deployment")
  func roundTrip() async throws {
    let config = try #require(LiveConfig.fromEnvironment())

    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "recto-live-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let (store, sync, transport) = try await LiveClient.shared.connect(
      config, directory: directory)

    let title = "native-spike-\(UUID().uuidString.prefix(8))"
    let created = try await transport.createDocument(title: title)
    defer {
      Task { try? await transport.remove(documentId: created.documentId) }
    }

    // Mirror it, then edit through the real session/outbox path.
    try await sync.mirrorLibrary([
      RemoteDocumentSummary(id: created.documentId, title: title, wordCount: 0, updatedAt: 0)
    ])
    let local = try #require(
      try await store.documents().first { $0.convexId == created.documentId })

    let session = DocumentSession(
      documentLocalId: local.localId, store: store, sync: sync, origin: "integration-test",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(
      markdown: "Live round trip 😀", selection: NodeSelection(anchor: 3, head: 3),
      structural: true)
    try await session.applyLocalChange(
      markdown: "Live round trip 😀 with more", selection: nil, structural: true)
    await sync.drainNow()

    let remote = try #require(try await transport.getDocument(documentId: created.documentId))
    #expect(remote.markdown == "Live round trip 😀 with more")
    #expect(try await store.pendingJobs(documentLocalId: local.localId).isEmpty)

    // Undo is a pointer move; the server head follows.
    #expect(try await session.undo())
    await sync.drainNow()
    let afterUndo = try #require(try await transport.getDocument(documentId: created.documentId))
    #expect(afterUndo.markdown == "Live round trip 😀")

    // The whole DAG is on the server, including the branch we undid past.
    let nodes = try await transport.listNodes(
      documentId: created.documentId, sinceCreatedAt: nil)
    #expect(nodes.count == 3)

    try await transport.remove(documentId: created.documentId)
    #expect(try await transport.getDocument(documentId: created.documentId) == nil)
  }

  @Test("a stale expectedHeadNodeId is answered with a divergence, not a lost node")
  func divergenceAgainstTheRealServer() async throws {
    let config = try #require(LiveConfig.fromEnvironment())

    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "recto-live-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let (_, _, transport) = try await LiveClient.shared.connect(config, directory: directory)

    let title = "native-spike-\(UUID().uuidString.prefix(8))"
    let created = try await transport.createDocument(title: title)
    defer { Task { try? await transport.remove(documentId: created.documentId) } }

    let first = CommitEditRequest(
      documentId: created.documentId, nodeId: ulid(), parentNodeId: created.rootNodeId,
      patch: computePatch("", "first").encoded, snapshot: nil, selection: nil,
      origin: "integration-test", createdAt: Date().timeIntervalSince1970 * 1000,
      markdown: "first", wordCount: 1, expectedHeadNodeId: created.rootNodeId,
      clientMutationId: ulid())
    let firstResponse = try await transport.commitEdit(first)
    #expect(
      firstResponse.outcome
        == .committed(
          headNodeId: first.nodeId, updatedAt: firstResponse.updatedAt ?? 0,
          pointerRevision: firstResponse.pointerRevision))
    // The deployed backend carries a monotonic pointer revision (PR #1).
    #expect((firstResponse.pointerRevision ?? 0) > 0)

    // A second client that still thinks the root is the head.
    let stale = CommitEditRequest(
      documentId: created.documentId, nodeId: ulid(), parentNodeId: created.rootNodeId,
      patch: computePatch("", "second").encoded, snapshot: nil, selection: nil,
      origin: "integration-test", createdAt: Date().timeIntervalSince1970 * 1000,
      markdown: "second", wordCount: 1, expectedHeadNodeId: created.rootNodeId,
      clientMutationId: ulid())
    let staleResponse = try await transport.commitEdit(stale)
    #expect(
      staleResponse.outcome
        == .diverged(
          remoteHeadNodeId: first.nodeId,
          remotePointerRevision: staleResponse.remotePointerRevision))

    // The rejected commit's NODE still landed — that is what makes losing text
    // impossible; only the pointer was contended.
    let nodes = try await transport.listNodes(
      documentId: created.documentId, sinceCreatedAt: nil)
    #expect(nodes.contains { $0.nodeId == stale.nodeId })

    // Replaying the first commit's key returns its original answer.
    let replay = try await transport.commitEdit(first)
    #expect(replay.committed)
    #expect(replay.headNodeId == first.nodeId)

    try await transport.remove(documentId: created.documentId)
  }
}
