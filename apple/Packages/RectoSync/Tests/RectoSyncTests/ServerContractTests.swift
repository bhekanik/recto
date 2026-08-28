import Foundation
import RectoAuth
import RectoSyncTesting
import Testing

@testable import RectoSync

/// Decoding tests against the response shapes `convex/documents.ts` actually
/// returns (branch `023/history-commit`, PR #1), copied verbatim from the
/// handlers' `return` statements.
///
/// A fake can agree with the client forever while both disagree with the server.
/// These pin the wire format so a backend change breaks here, loudly, instead of
/// as a mis-decoded field at runtime.
@Suite("server response contract")
struct ServerContractTests {
  private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
  }

  @Test("documents.get")
  func documentsGet() throws {
    let document: RemoteDocument = try decode(
      """
      {"_id":"j57abc","title":"native-spike","markdown":"body 😀","wordCount":2,
       "currentNodeId":"01ARZ","pointerRevision":4,"createdAt":1756000000000,
       "updatedAt":1756000009000}
      """)
    #expect(document.id == "j57abc")
    #expect(document.currentNodeId == "01ARZ")
    #expect(document.pointerRevision == 4)
    #expect(document.markdown == "body 😀")
  }

  @Test("documents.get from a deployment that predates pointerRevision")
  func documentsGetLegacy() throws {
    // `pointerRevision` is `v.optional`; rows written before PR #1 read as 0.
    let document: RemoteDocument = try decode(
      """
      {"_id":"j57abc","title":"t","markdown":"","wordCount":0,"currentNodeId":"root",
       "createdAt":1,"updatedAt":2}
      """)
    #expect(document.pointerRevision == 0)
  }

  @Test("documents.commitEdit — committed")
  func commitCommitted() throws {
    let response: CommitEditResponse = try decode(
      """
      {"committed":true,"headNodeId":"01ARZ","updatedAt":1756000009000,"pointerRevision":5}
      """)
    #expect(response.outcome == .committed(
      headNodeId: "01ARZ", updatedAt: 1_756_000_009_000, pointerRevision: 5))
  }

  @Test("documents.commitEdit — diverged")
  func commitDiverged() throws {
    let response: CommitEditResponse = try decode(
      """
      {"committed":false,"diverged":true,"remoteHeadNodeId":"01OTHER","remotePointerRevision":9}
      """)
    #expect(response.outcome == .diverged(
      remoteHeadNodeId: "01OTHER", remotePointerRevision: 9))
  }

  @Test("documents.updateMarkdown — accepted, stale, and head-moved")
  func updateMarkdownShapes() throws {
    let ok: UpdateMarkdownResponse = try decode(
      #"{"updatedAt":1756000009000,"stale":false,"headMoved":false}"#)
    #expect(!ok.stale)
    #expect(!ok.headMoved)

    let stale: UpdateMarkdownResponse = try decode(
      #"{"updatedAt":1756000008000,"stale":true,"headMoved":false}"#)
    #expect(stale.stale)
    #expect(!stale.headMoved)

    // The one that must NOT be retried: the draft belongs to a branch that is no
    // longer the head.
    let moved: UpdateMarkdownResponse = try decode(
      #"{"updatedAt":1756000008000,"stale":true,"headMoved":true}"#)
    #expect(moved.headMoved)

    // A deployment without the head CAS omits the field entirely.
    let legacy: UpdateMarkdownResponse = try decode(
      #"{"updatedAt":1756000008000,"stale":true}"#)
    #expect(legacy.stale)
    #expect(!legacy.headMoved)
  }

  @Test("documents.updateCurrentNodeId — applied and rejected")
  func pointerShapes() throws {
    let applied: UpdateCurrentNodeResponse = try decode(
      """
      {"applied":true,"currentNodeId":"01NEW","updatedAt":1756000009000,"pointerRevision":6}
      """)
    #expect(applied.applied)
    #expect(applied.pointerRevision == 6)

    // Rejected by the LWW check: `currentNodeId` is the head that WON, and there
    // is no `updatedAt`.
    let rejected: UpdateCurrentNodeResponse = try decode(
      #"{"applied":false,"currentNodeId":"01WINNER","pointerRevision":6}"#)
    #expect(!rejected.applied)
    #expect(rejected.currentNodeId == "01WINNER")
    #expect(rejected.updatedAt == nil)
  }

  @Test("documents.create and docNodes.listSince")
  func createAndNodes() throws {
    let created: CreateDocumentResponse = try decode(
      #"{"documentId":"j57abc","rootNodeId":"3f2b0c9e-..."}"#)
    #expect(created.rootNodeId == "3f2b0c9e-...")

    let nodes: [RemoteNode] = try decode(
      """
      [{"nodeId":"01ARZ","parentNodeId":null,"patch":"{\\"from\\":0,\\"to\\":0,\\"insert\\":\\"\\"}",
        "snapshot":"","selection":null,"origin":"server","createdAt":1756000000000},
       {"nodeId":"01ARZ2","parentNodeId":"01ARZ","patch":"{\\"from\\":0,\\"to\\":0,\\"insert\\":\\"hi\\"}",
        "selection":{"anchor":2,"head":2},"origin":"mac","createdAt":1756000001000}]
      """)
    #expect(nodes.count == 2)
    #expect(nodes[0].parentNodeId == nil)
    #expect(nodes[0].snapshot == "")
    #expect(nodes[1].selection?.anchor == 2)
    // `snapshot` is `v.optional`, i.e. absent rather than null.
    #expect(nodes[1].snapshot == nil)
    #expect(nodes[1].record(documentLocalId: "d").selection?.head == 2)
  }

  @Test("documents.list")
  func documentsList() throws {
    let summaries: [RemoteDocumentSummary] = try decode(
      """
      [{"_id":"j1","title":"a","wordCount":12,"updatedAt":1756000000000},
       {"_id":"j2","title":"b","wordCount":0,"updatedAt":1755000000000}]
      """)
    #expect(summaries.map(\.id) == ["j1", "j2"])
    #expect(summaries[0].wordCount == 12)
  }

  @Test("writingStats.list")
  func writingStats() throws {
    let stats: [RemoteWritingStat] = try decode(
      #"[{"date":"2026-08-28","words":812}]"#)
    #expect(stats[0].date == "2026-08-28")
    #expect(stats[0].words == 812)
  }
}

@Suite("transport construction")
struct TransportConstructionTests {
  @Test("building the transport without a configured Clerk does not trap")
  func constructionIsSafeWithoutClerk() async {
    // `ConvexClientWithAuth`'s init calls `authProvider.bind`, which reads
    // `Clerk.shared` — and that is a `fatalError` when the SDK was never
    // configured. A widget, a share extension or a test that builds the stack
    // before `configureClerk` must not die here.
    #expect(await RectoAuth.isClerkConfigured == false)
    let provider = await ConvexTemplateAuthProvider()
    let transport = await ConvexTransport(
      deploymentURL: "https://example.convex.cloud", authProvider: provider)
    #expect(await transport.liveSubscriptionCountForTesting == 0)

    // `bind` starts a listener task; give it a turn. Unguarded it reaches
    // `Clerk.shared` and traps the whole process.
    try? await Task.sleep(for: .milliseconds(50))

    // And the token paths report the condition instead of touching the SDK.
    await #expect(throws: RectoAuthError.clerkNotLoaded) {
      try await provider.loginFromCache(onIdToken: { _ in })
    }
  }
}

@Suite("fake matches the deployed contract")
struct FakeContractTests {
  @Test("a pointer move to a node the server does not have is refused")
  func unknownPointerTargetIsRefused() async throws {
    // `convex/documents.ts` throws `Unknown currentNodeId`. A fake that accepted
    // it would let a test pass against a state the deployment cannot produce.
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument()
    await #expect(throws: InMemoryTransport.TransportFault.unknownPointerTarget) {
      _ = try await transport.updateCurrentNodeId(
        documentId: seeded.documentId, currentNodeId: "never-existed", markdown: "x",
        wordCount: 1, updatedAt: Date().timeIntervalSince1970 * 1000)
    }
    #expect(
      try await transport.getDocument(documentId: seeded.documentId)?.currentNodeId
        == seeded.rootNodeId)
  }

  @Test("documents.create leaves the body's provenance absent")
  func createLeavesProvenanceAbsent() async throws {
    let transport = InMemoryTransport()
    let created = try await transport.createDocument(title: "native-spike")
    let document = try #require(try await transport.getDocument(documentId: created.documentId))
    // The body is empty and nothing has vouched for which node it belongs to.
    #expect(document.markdownHeadNodeId == nil)
    #expect(document.markdown == "")
  }

  @Test("a successful commit stamps the body with the node it committed")
  func commitStampsProvenance() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument()
    let node = try await transport.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "committed")
    let document = try #require(try await transport.getDocument(documentId: seeded.documentId))
    #expect(document.markdownHeadNodeId == node)
    #expect(document.currentNodeId == node)
  }

  @Test("a draft save stamps with the head it was written against")
  func draftSaveStampsProvenance() async throws {
    let transport = InMemoryTransport()
    let seeded = await transport.seedDocument()
    let current = try #require(try await transport.getDocument(documentId: seeded.documentId))
    _ = try await transport.updateMarkdown(
      documentId: seeded.documentId, markdown: "typed", wordCount: 1,
      expectedUpdatedAt: current.updatedAt, expectedHeadNodeId: seeded.rootNodeId, title: nil)
    #expect(
      try await transport.getDocument(documentId: seeded.documentId)?.markdownHeadNodeId
        == seeded.rootNodeId)

    // A legacy caller that passes no head CLEARS the stamp rather than leaving
    // a stale one another device could promote.
    let after = try #require(try await transport.getDocument(documentId: seeded.documentId))
    _ = try await transport.updateMarkdown(
      documentId: seeded.documentId, markdown: "typed again", wordCount: 2,
      expectedUpdatedAt: after.updatedAt, expectedHeadNodeId: nil, title: nil)
    #expect(try await transport.getDocument(documentId: seeded.documentId)?.markdownHeadNodeId == nil)
  }
}
