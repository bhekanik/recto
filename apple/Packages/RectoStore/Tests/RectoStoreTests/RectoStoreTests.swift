import Foundation
import RectoHistory
import Testing

@testable import RectoStore

private func makeStore() throws -> RectoStore { try RectoStore.inMemory() }

private func seedDocument(
  _ store: RectoStore, localId: String = "doc-1", markdown: String = ""
) async throws -> DocumentRecord {
  let document = DocumentRecord(
    localId: localId, title: "native-spike-test", markdown: markdown, wordCount: 0,
    localHeadNodeId: "root", syncState: .synced, updatedAt: 0, createdAt: 0)
  try await store.save(document)
  try await store.mergeRemoteNodes(
    documentLocalId: localId,
    nodes: [
      DocNodeRecord(
        documentLocalId: localId, nodeId: "root", parentNodeId: nil,
        patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: markdown,
        origin: "server", createdAt: 0)
    ])
  return document
}

/// Build the node + outbox job a `GroupCommit` turns into, the way
/// `DocumentSession` does.
private func nodeAndJob(
  documentLocalId: String, commit: GroupCommit, now: Double
) -> (DocNodeRecord, OutboxJob) {
  let node = DocNodeRecord(
    documentLocalId: documentLocalId, nodeId: commit.nodeId,
    parentNodeId: commit.parentNodeId, patch: commit.patch, snapshot: commit.snapshot,
    selection: commit.selection, origin: "test", createdAt: now)
  let job = OutboxJob(
    documentLocalId: documentLocalId, kind: .commitEdit, clientMutationId: ulid(),
    baseHeadNodeId: commit.parentNodeId, payload: "{}", createdAt: now)
  return (node, job)
}

@Suite("RectoStore")
struct RectoStoreTests {
  @Test("migrations create every table plan 023 §4.2 lists")
  func schema() async throws {
    let store = try makeStore()
    let expected = [
      "documents", "doc_nodes", "versions", "comments", "review_branches", "writing_stats",
      "settings", "ai_runs", "outbox", "window_state",
    ]
    for table in expected {
      #expect(try await store.tableExists(table), "\(table)")
    }
  }

  @Test("a commit writes node, head and outbox job atomically")
  func commitIsAtomic() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)

    var controller = GroupingController(rootNodeId: "root", rootMarkdown: "")
    let commits = controller.record(
      markdown: "hello", selection: NodeSelection(anchor: 5, head: 5), structural: true, now: 0)
    let commit = try #require(commits.first)
    let (node, job) = nodeAndJob(documentLocalId: "doc-1", commit: commit, now: 1)

    let updated = try await store.commit(
      documentLocalId: "doc-1", node: node, markdown: commit.markdown, wordCount: 1,
      expectedHeadNodeId: "root", job: job, now: 1)

    #expect(updated.localHeadNodeId == commit.nodeId)
    #expect(updated.markdown == "hello")
    #expect(updated.syncState == .pending)
    #expect(try await store.pendingJobCount() == 1)
    #expect(try await store.node(documentLocalId: "doc-1", nodeId: commit.nodeId) != nil)
  }

  @Test("a commit onto a head that already moved is rejected, leaving nothing behind")
  func commitRejectsStaleHead() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    var controller = GroupingController(rootNodeId: "root", rootMarkdown: "")
    let commit = try #require(
      controller.record(markdown: "a", selection: nil, structural: true, now: 0).first)
    let (node, job) = nodeAndJob(documentLocalId: "doc-1", commit: commit, now: 1)
    _ = try await store.commit(
      documentLocalId: "doc-1", node: node, markdown: "a", wordCount: 1,
      expectedHeadNodeId: "root", job: job, now: 1)

    let (node2, job2) = nodeAndJob(documentLocalId: "doc-1", commit: commit, now: 2)
    await #expect(throws: StoreError.self) {
      _ = try await store.commit(
        documentLocalId: "doc-1", node: node2, markdown: "b", wordCount: 1,
        expectedHeadNodeId: "root", job: job2, now: 2)
    }
    // The rejected attempt queued nothing.
    #expect(try await store.pendingJobCount() == 1)
  }

  @Test("materialization replays patches and caches the result")
  func materialization() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)

    var controller = GroupingController(rootNodeId: "root", rootMarkdown: "")
    var markdown = ""
    var head = "root"
    var nodeIds: [String] = []
    for index in 0..<60 {
      markdown += "line \(index) 😀\n"
      let commit = try #require(
        controller.record(markdown: markdown, selection: nil, structural: true, now: Double(index))
          .first)
      let (node, _) = nodeAndJob(documentLocalId: "doc-1", commit: commit, now: Double(index))
      _ = try await store.commit(
        documentLocalId: "doc-1", node: node, markdown: commit.markdown, wordCount: index,
        expectedHeadNodeId: head, job: nil, now: Double(index))
      head = commit.nodeId
      nodeIds.append(commit.nodeId)
    }

    // The cache is trimmed, so an early node has to be replayed from a snapshot.
    let earlyId = nodeIds[2]
    #expect(try await store.node(documentLocalId: "doc-1", nodeId: earlyId)?.materialized == nil)
    let replayed = try await store.materializedMarkdown(documentLocalId: "doc-1", nodeId: earlyId)
    #expect(replayed == "line 0 😀\nline 1 😀\nline 2 😀\n")
    // …and is cached afterwards.
    #expect(try await store.node(documentLocalId: "doc-1", nodeId: earlyId)?.materialized == replayed)
  }

  @Test("the materialization cache stays bounded")
  func cacheBounded() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    var controller = GroupingController(rootNodeId: "root", rootMarkdown: "")
    var markdown = ""
    var head = "root"
    for index in 0..<60 {
      markdown += "x"
      let commit = try #require(
        controller.record(markdown: markdown, selection: nil, structural: true, now: Double(index))
          .first)
      let (node, _) = nodeAndJob(documentLocalId: "doc-1", commit: commit, now: Double(index))
      _ = try await store.commit(
        documentLocalId: "doc-1", node: node, markdown: commit.markdown, wordCount: 1,
        expectedHeadNodeId: head, job: nil, now: Double(index))
      head = commit.nodeId
    }
    let cached = try await store.nodes(documentLocalId: "doc-1").filter { $0.materialized != nil }
    #expect(cached.count <= RectoStore.materializationCacheSize)
  }

  @Test("outbox drains per document in insertion order")
  func outboxOrdering() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store, localId: "doc-1")
    _ = try await seedDocument(store, localId: "doc-2")

    var ids: [Int64] = []
    for index in 0..<3 {
      let job = try await store.enqueue(
        OutboxJob(
          documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(),
          payload: "\(index)", createdAt: Double(index)))
      ids.append(try #require(job.id))
    }
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-2", kind: .commitEdit, clientMutationId: ulid(), payload: "other",
        createdAt: 9))

    #expect(try await store.documentsWithPendingJobs() == ["doc-1", "doc-2"])
    for expected in ids {
      let next = try #require(try await store.nextJob(documentLocalId: "doc-1", now: 1_000))
      #expect(next.id == expected)
      try await store.completeJob(id: expected)
    }
    #expect(try await store.nextJob(documentLocalId: "doc-1", now: 1_000) == nil)
    #expect(try await store.nextJob(documentLocalId: "doc-2", now: 1_000) != nil)
  }

  @Test("a failed job backs off and blocks the ones behind it")
  func outboxBackoffBlocks() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    let first = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "1",
        createdAt: 0))
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "2",
        createdAt: 0))

    try await store.failJob(id: try #require(first.id), error: "boom", retryAfter: 4, now: 0)
    // Retry-until-acked: the second job must NOT overtake the first.
    #expect(try await store.nextJob(documentLocalId: "doc-1", now: 1_000) == nil)
    let retried = try #require(try await store.nextJob(documentLocalId: "doc-1", now: 5_000))
    #expect(retried.id == first.id)
    #expect(retried.attempts == 1)
    #expect(retried.lastError == "boom")
  }

  @Test("backoff grows exponentially and is capped")
  func backoffCurve() {
    #expect(outboxBackoff(attempts: 1, jitter: 1) == 1)
    #expect(outboxBackoff(attempts: 4, jitter: 1) == 8)
    #expect(outboxBackoff(attempts: 20, jitter: 1) == 300)
  }

  @Test("an idempotency key cannot be reused")
  func idempotencyKeyIsUnique() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    let key = ulid()
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: key, payload: "1",
        createdAt: 0))
    await #expect(throws: (any Error).self) {
      _ = try await store.enqueue(
        OutboxJob(
          documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: key, payload: "2",
          createdAt: 0))
    }
  }

  @Test("remote nodes union-merge without overwriting local ones")
  func mergeIsAppendOnly() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    let local = DocNodeRecord(
      documentLocalId: "doc-1", nodeId: "n1", parentNodeId: "root",
      patch: TextPatch(from: 0, to: 0, insert: "hi").encoded, origin: "local", createdAt: 1,
      materialized: "hi", synced: false)
    try await store.mergeRemoteNodes(documentLocalId: "doc-1", nodes: [local])

    let conflicting = DocNodeRecord(
      documentLocalId: "doc-1", nodeId: "n1", parentNodeId: "root",
      patch: TextPatch(from: 0, to: 0, insert: "DIFFERENT").encoded, origin: "server",
      createdAt: 1, synced: true)
    try await store.mergeRemoteNodes(documentLocalId: "doc-1", nodes: [conflicting])

    let stored = try #require(try await store.node(documentLocalId: "doc-1", nodeId: "n1"))
    #expect(stored.patch == local.patch)
    #expect(stored.origin == "local")
    #expect(stored.synced == true)
    #expect(stored.materialized == "hi")
  }

  @Test("the draft row holds text ahead of the head and clears on commit")
  func draftRow() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    try await store.saveDraft(
      documentLocalId: "doc-1", markdown: "typing…",
      selection: NodeSelection(anchor: 7, head: 7), wordCount: 1, job: nil, now: 5)
    var document = try #require(try await store.document(localId: "doc-1"))
    #expect(document.draftMarkdown == "typing…")
    #expect(document.displayMarkdown == "typing…")
    #expect(document.draftSelection == NodeSelection(anchor: 7, head: 7))

    var controller = GroupingController(rootNodeId: "root", rootMarkdown: "")
    let commit = try #require(
      controller.record(markdown: "typing…", selection: nil, structural: true, now: 0).first)
    let (node, _) = nodeAndJob(documentLocalId: "doc-1", commit: commit, now: 6)
    _ = try await store.commit(
      documentLocalId: "doc-1", node: node, markdown: "typing…", wordCount: 1,
      expectedHeadNodeId: "root", job: nil, now: 6)

    document = try #require(try await store.document(localId: "doc-1"))
    #expect(document.draftMarkdown == nil)
    #expect(document.displayMarkdown == "typing…")
  }

  @Test("writing stats are monotonic per day")
  func writingStatsMonotonic() async throws {
    let store = try makeStore()
    try await store.recordWritingStat(date: "2026-08-28", words: 300, now: 1)
    try await store.recordWritingStat(date: "2026-08-28", words: 120, now: 2)
    try await store.recordWritingStat(date: "2026-08-28", words: 450, now: 3)
    let stats = try await store.writingStats()
    #expect(stats.count == 1)
    #expect(stats[0].words == 450)
  }

  @Test("sign-out purges every user-keyed row")
  func purge() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store, markdown: "secret draft")
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "x",
        createdAt: 0))
    try await store.recordWritingStat(date: "2026-08-28", words: 10)
    try await store.saveSetting(key: "theme", json: #"{"palette":"paper"}"#)
    try await store.saveWindowState(WindowStateRecord(windowId: "w1", json: "{}", updatedAt: 0))

    try await store.purgeEverything()

    #expect(try await store.documents().isEmpty)
    #expect(try await store.nodes(documentLocalId: "doc-1").isEmpty)
    #expect(try await store.pendingJobCount() == 0)
    #expect(try await store.writingStats().isEmpty)
    #expect(try await store.settings().isEmpty)
    #expect(try await store.windowStates().isEmpty)
  }

  @Test("deleting a document cascades its history")
  func cascade() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    #expect(try await store.nodes(documentLocalId: "doc-1").count == 1)
    try await store.deleteDocumentRow(localId: "doc-1")
    #expect(try await store.nodes(documentLocalId: "doc-1").isEmpty)
  }

  @Test("the mirror survives a reopen with its queue intact")
  func survivesReopen() async throws {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "recto-store-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appending(path: "recto.sqlite")

    do {
      let store = try RectoStore(url: url)
      _ = try await seedDocument(store, markdown: "offline work")
      _ = try await store.enqueue(
        OutboxJob(
          documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: "MUT-1",
          payload: "payload", createdAt: 0))
    }

    let reopened = try RectoStore(url: url)
    #expect(try await reopened.document(localId: "doc-1")?.markdown == "offline work")
    let job = try #require(try await reopened.nextJob(documentLocalId: "doc-1", now: 1_000))
    #expect(job.clientMutationId == "MUT-1")
    #expect(job.payload == "payload")
  }
}
