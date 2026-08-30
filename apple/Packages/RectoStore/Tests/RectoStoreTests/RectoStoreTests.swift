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

  @Test("reverting editor ingress to the clean head restores synced state")
  func cleanIngressRevert() async throws {
    let store = try makeStore()
    var cleanDocument = try await seedDocument(store, markdown: "clean")
    cleanDocument.remoteHeadNodeId = "root"
    try await store.save(cleanDocument)

    _ = try store.saveEditorIngressSynchronously(
      documentLocalId: "doc-1", markdown: "A", selection: nil, wordCount: 1)
    _ = try store.saveEditorIngressSynchronously(
      documentLocalId: "doc-1", markdown: "clean", selection: nil, wordCount: 1)

    let document = try #require(try await store.document(localId: "doc-1"))
    #expect(document.draftMarkdown == nil)
    #expect(document.localHeadNodeId == document.remoteHeadNodeId)
    #expect(document.syncState == .synced)
    #expect(try await store.pendingJobs(documentLocalId: "doc-1").isEmpty)
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

@Suite("outbox failure state")
struct OutboxFailureTests {
  @Test("hasFailedJobs reflects whether a queued job has already errored")
  func hasFailedJobs() async throws {
    let store = try RectoStore.inMemory()
    _ = try await seedDocument(store)
    #expect(try await store.hasFailedJobs(documentLocalId: "doc-1") == false)

    let job = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "1",
        createdAt: 0))
    #expect(try await store.hasFailedJobs(documentLocalId: "doc-1") == false)

    try await store.failJob(id: try #require(job.id), error: "boom", retryAfter: 0, now: 0)
    #expect(try await store.hasFailedJobs(documentLocalId: "doc-1") == true)

    try await store.completeJob(id: try #require(job.id))
    #expect(try await store.hasFailedJobs(documentLocalId: "doc-1") == false)
  }
}

@Suite("round-2 store transactions")
struct StoreTransactionTests {
  private func seeded() async throws -> RectoStore {
    let store = try RectoStore.inMemory()
    _ = try await seedDocument(store)
    return store
  }

  @Test("moveHead refuses when the head moved under it")
  func moveHeadCAS() async throws {
    let store = try await seeded()
    try await store.mergeRemoteNodes(
      documentLocalId: "doc-1",
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "n1", parentNodeId: "root",
          patch: computePatch("", "a").encoded, origin: "t", createdAt: 1),
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "n2", parentNodeId: "root",
          patch: computePatch("", "b").encoded, origin: "t", createdAt: 2),
      ])
    _ = try await store.moveHead(
      documentLocalId: "doc-1", to: "n1", markdown: "a", wordCount: 1,
      expectedHeadNodeId: "root", job: nil)

    // A navigation that materialized against the old head must not land.
    await #expect(throws: StoreError.headMoved(expected: "root", actual: "n1")) {
      _ = try await store.moveHead(
        documentLocalId: "doc-1", to: "n2", markdown: "b", wordCount: 1,
        expectedHeadNodeId: "root", job: nil)
    }
    #expect(try await store.document(localId: "doc-1")?.localHeadNodeId == "n1")
  }

  @Test("adoptRemoteHead is a CAS on the head, the draft and the queue")
  func adoptRemoteHeadCAS() async throws {
    let store = try await seeded()
    try await store.mergeRemoteNodes(
      documentLocalId: "doc-1",
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "remote", parentNodeId: "root",
          patch: computePatch("", "theirs").encoded, origin: "other", createdAt: 1)
      ])

    // A draft appearing between the decision and the write blocks the adopt.
    try await store.saveDraft(
      documentLocalId: "doc-1", markdown: "still typing", selection: nil, wordCount: 2, job: nil)
    #expect(
      try await store.adoptRemoteHead(
        documentLocalId: "doc-1", observedLocalHeadNodeId: "root", remoteHeadNodeId: "remote",
        markdown: "theirs", wordCount: 1, remoteUpdatedAt: 5, remotePointerRevision: 2) == false)
    #expect(try await store.document(localId: "doc-1")?.draftMarkdown == "still typing")
    #expect(try await store.document(localId: "doc-1")?.localHeadNodeId == "root")

    // Once idle it lands, and carries the revision.
    try await store.saveDraft(
      documentLocalId: "doc-1", markdown: "", selection: nil, wordCount: 0, job: nil)
    #expect(
      try await store.adoptRemoteHead(
        documentLocalId: "doc-1", observedLocalHeadNodeId: "root", remoteHeadNodeId: "remote",
        markdown: "theirs", wordCount: 1, remoteUpdatedAt: 5, remotePointerRevision: 2) == true)
    let document = try #require(try await store.document(localId: "doc-1"))
    #expect(document.localHeadNodeId == "remote")
    #expect(document.syncState == .synced)
    #expect(document.remotePointerRevision == 2)
  }

  @Test("a queued job blocks adoption even when the head and draft match")
  func adoptBlockedByQueue() async throws {
    let store = try await seeded()
    try await store.mergeRemoteNodes(
      documentLocalId: "doc-1",
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "remote", parentNodeId: "root",
          patch: computePatch("", "theirs").encoded, origin: "other", createdAt: 1)
      ])
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "{}",
        createdAt: 0))
    #expect(
      try await store.adoptRemoteHead(
        documentLocalId: "doc-1", observedLocalHeadNodeId: "root", remoteHeadNodeId: "remote",
        markdown: "theirs", wordCount: 1, remoteUpdatedAt: 5, remotePointerRevision: 2) == false)
  }

  @Test("resolveKeepingRemote rewrites commits to node-only uploads and drops the rest")
  func keepRemoteQueueRewrite() async throws {
    let store = try await seeded()
    try await store.mergeRemoteNodes(
      documentLocalId: "doc-1",
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "remote", parentNodeId: "root",
          patch: computePatch("", "theirs").encoded, origin: "other", createdAt: 1)
      ])
    for kind in [OutboxKind.commitEdit, .draftSave, .pointerMove, .commitEdit] {
      _ = try await store.enqueue(
        OutboxJob(
          documentLocalId: "doc-1", kind: kind, clientMutationId: ulid(),
          baseHeadNodeId: "root", payload: "{}", createdAt: 0))
    }

    try await store.setSyncState(
      documentLocalId: "doc-1", .diverged, divergedRemoteHeadNodeId: "remote")
    try await store.resolveKeepingRemote(
      documentLocalId: "doc-1",
      expecting: .init(
        localHeadNodeId: "root", divergedRemoteHeadNodeId: "remote", remotePointerRevision: nil),
      markdown: "theirs", wordCount: 1)

    let queued = try await store.pendingJobs(documentLocalId: "doc-1")
    #expect(queued.count == 2)
    #expect(queued.allSatisfy { $0.kind == .appendNode })
    // A node-only upload must not carry a head to commit onto.
    #expect(queued.allSatisfy { $0.baseHeadNodeId == nil })
    let document = try #require(try await store.document(localId: "doc-1"))
    #expect(document.localHeadNodeId == "remote")
    #expect(document.divergedRemoteHeadNodeId == nil)
  }

  @Test("finishOfflineCreate re-keys the root everywhere, including encoded payloads")
  func finishOfflineCreateRewritesPayloads() async throws {
    let store = try RectoStore.inMemory()
    let localRoot = "local-root"
    try await store.save(
      DocumentRecord(
        localId: "doc-1", title: "native-spike", markdown: "", wordCount: 0,
        localHeadNodeId: localRoot, updatedAt: 0, createdAt: 0))
    try await store.mergeRemoteNodes(
      documentLocalId: "doc-1",
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: localRoot, parentNodeId: nil,
          patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "", origin: "local",
          createdAt: 0),
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "child", parentNodeId: localRoot,
          patch: computePatch("", "text").encoded, origin: "local", createdAt: 1),
      ])
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(),
        baseHeadNodeId: localRoot,
        payload: #"{"nodeId":"child","parentNodeId":"local-root","markdown":"text"}"#,
        createdAt: 1))

    try await store.finishOfflineCreate(
      documentLocalId: "doc-1", convexId: "j57abc", serverRootNodeId: "server-root",
      rewritePayloadNodeIds: { raw, oldRoot, newRoot in
        raw.replacingOccurrences(of: "\"parentNodeId\":\"\(oldRoot)\"", with: "\"parentNodeId\":\"\(newRoot)\"")
      })

    #expect(try await store.document(localId: "doc-1")?.convexId == "j57abc")
    #expect(try await store.node(documentLocalId: "doc-1", nodeId: localRoot) == nil)
    #expect(try await store.node(documentLocalId: "doc-1", nodeId: "child")?.parentNodeId == "server-root")
    let job = try #require(try await store.pendingJobs(documentLocalId: "doc-1").first)
    #expect(job.baseHeadNodeId == "server-root")
    // The encoded payload carries its OWN copy of the parent; rewriting only the
    // node row would still send the deleted root.
    #expect(job.payload.contains("server-root"))
    #expect(!job.payload.contains("local-root"))
  }

  @Test("commit rejects a node whose parent is not the expected head")
  func commitRejectsParentHeadMismatch() async throws {
    let store = try RectoStore.inMemory()
    try await store.save(
      DocumentRecord(
        localId: "doc-parent", title: "Parent defense", markdown: "", wordCount: 0,
        localHeadNodeId: "server-root", updatedAt: 0, createdAt: 0))
    try await store.mergeRemoteNodes(
      documentLocalId: "doc-parent",
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-parent", nodeId: "server-root", parentNodeId: nil,
          patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "",
          origin: "server", createdAt: 0)
      ])
    let orphan = DocNodeRecord(
      documentLocalId: "doc-parent", nodeId: "child", parentNodeId: "deleted-local-root",
      patch: computePatch("", "safe").encoded, origin: "mac", createdAt: 1)

    await #expect(
      throws: StoreError.parentMismatch(
        expected: "server-root", actual: "deleted-local-root")
    ) {
      _ = try await store.commit(
        documentLocalId: "doc-parent", node: orphan, markdown: "safe", wordCount: 1,
        expectedHeadNodeId: "server-root", job: nil)
    }
    #expect(try await store.node(documentLocalId: "doc-parent", nodeId: "child") == nil)
    #expect(try await store.document(localId: "doc-parent")?.localHeadNodeId == "server-root")
  }

  @Test("finishOfflineCreate is idempotent")
  func finishOfflineCreateIsIdempotent() async throws {
    let store = try RectoStore.inMemory()
    try await store.save(
      DocumentRecord(
        localId: "doc-1", convexId: "j57abc", title: "t", markdown: "", wordCount: 0,
        localHeadNodeId: "server-root", updatedAt: 0, createdAt: 0))
    try await store.mergeRemoteNodes(
      documentLocalId: "doc-1",
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "server-root", parentNodeId: nil,
          patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "", origin: "server",
          createdAt: 0)
      ])
    try await store.finishOfflineCreate(
      documentLocalId: "doc-1", convexId: "j57abc", serverRootNodeId: "server-root",
      rewritePayloadNodeIds: { raw, _, _ in raw })
    #expect(try await store.nodes(documentLocalId: "doc-1").count == 1)
    #expect(try await store.document(localId: "doc-1")?.localHeadNodeId == "server-root")
  }

  @Test("an interrupted hydration is reported as incomplete")
  func incompleteHydration() async throws {
    let store = try RectoStore.inMemory()
    // A row pointing at a head node that never arrived: it can never materialize.
    try await store.save(
      DocumentRecord(
        localId: "doc-1", convexId: "j57abc", title: "t", markdown: "x", wordCount: 1,
        localHeadNodeId: "missing", updatedAt: 0, createdAt: 0))
    #expect(try await store.incompleteDocumentIds() == ["doc-1"])

    try await store.hydrate(
      document: DocumentRecord(
        localId: "doc-1", convexId: "j57abc", title: "t", markdown: "x", wordCount: 1,
        localHeadNodeId: "head", updatedAt: 0, createdAt: 0),
      nodes: [
        DocNodeRecord(
          documentLocalId: "doc-1", nodeId: "head", parentNodeId: nil,
          patch: TextPatch(from: 0, to: 0, insert: "").encoded, snapshot: "x", origin: "server",
          createdAt: 0)
      ])
    #expect(try await store.incompleteDocumentIds().isEmpty)
  }

  @Test("unsyncedWorkCount counts drafts and queued jobs")
  func unsyncedWork() async throws {
    let store = try await seeded()
    #expect(try await store.unsyncedWorkCount() == 0)
    try await store.saveDraft(
      documentLocalId: "doc-1", markdown: "typing", selection: nil, wordCount: 1, job: nil)
    #expect(try await store.unsyncedWorkCount() == 1)
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "{}",
        createdAt: 0))
    #expect(try await store.unsyncedWorkCount() == 2)
  }
}

@Suite("schema upgrades")
struct MigrationTests {
  @Test("a populated v1 database upgrades with its rows and queue order intact")
  func upgradesFromV1() async throws {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "recto-migration-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appending(path: "recto.sqlite")

    // A real file at v1, with the rows an upgrading user would actually have —
    // not a fresh database that runs every migration at once.
    do {
      let pool = try RectoStore.openAtSchemaVersion(url: url, target: Migrations.v1)
      try await pool.write { db in
        try db.execute(
          sql: """
            INSERT INTO documents
              (localId, convexId, title, markdown, draftMarkdown, wordCount, localHeadNodeId,
               syncState, updatedAt, createdAt)
            VALUES ('doc-1', 'j57abc', 'native-spike', 'body', 'a draft', 1, 'n2', 'pending', 5, 1)
            """)
        for (nodeId, parent, order) in [("root", nil as String?, 0.0), ("n1", "root", 1.0), ("n2", "n1", 2.0)] {
          try db.execute(
            sql: """
              INSERT INTO doc_nodes
                (documentLocalId, nodeId, parentNodeId, patch, snapshot, origin, createdAt, synced)
              VALUES ('doc-1', ?, ?, '{"from":0,"to":0,"insert":""}', NULL, 'local', ?, 0)
              """,
            arguments: [nodeId, parent, order])
        }
        for (index, key) in ["MUT-1", "MUT-2", "MUT-3"].enumerated() {
          try db.execute(
            sql: """
              INSERT INTO outbox
                (documentLocalId, kind, clientMutationId, baseHeadNodeId, payload, attempts,
                 nextAttemptAt, createdAt)
              VALUES ('doc-1', 'commitEdit', ?, 'n1', ?, 0, 0, ?)
              """,
            arguments: [key, "payload-\(index)", Double(index)])
        }
      }
      try pool.close()
    }

    // Now the upgrade the user's next launch performs.
    let store = try RectoStore(url: url)

    let document = try #require(try await store.document(localId: "doc-1"))
    #expect(document.markdown == "body")
    #expect(document.draftMarkdown == "a draft")
    #expect(document.localHeadNodeId == "n2")
    // New columns default rather than losing the row. v4 normalises the
    // baseline to 0: the wire decodes an absent revision as 0 too, so `nil`
    // would make an unchanged legacy pointer look newer than itself.
    #expect(document.remotePointerRevision == 0)
    #expect(document.remoteMarkdownHeadNodeId == nil)
    #expect(document.draftRevision == 0)

    #expect(try await store.nodes(documentLocalId: "doc-1").count == 3)

    // FIFO across the upgrade: the queue is the ordering guarantee the server's
    // single-slot replay window depends on.
    let queued = try await store.pendingJobs(documentLocalId: "doc-1")
    #expect(queued.map(\.clientMutationId) == ["MUT-1", "MUT-2", "MUT-3"])
    let head = try await store.nextJob(documentLocalId: "doc-1", now: 1_000)
    #expect(head?.clientMutationId == "MUT-1")

    // And a genuine advance is still recorded.
    try await store.setSyncState(
      documentLocalId: "doc-1", .pending, remotePointerRevision: 3)
    #expect(try await store.document(localId: "doc-1")?.remotePointerRevision == 3)
  }
}

@Suite("v3 to v4 upgrade")
struct V4MigrationTests {
  @Test("an existing divergence keeps its barrier across the v4 upgrade")
  func v3DivergenceKeepsItsBarrier() async throws {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
      .appending(path: "recto-v4-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appending(path: "recto.sqlite")

    // A v3 database with an UNRESOLVED divergence and work queued behind it —
    // exactly what an upgrading user can be holding.
    do {
      let pool = try RectoStore.openAtSchemaVersion(url: url, target: Migrations.v3)
      try await pool.write { db in
        try db.execute(
          sql: """
            INSERT INTO documents
              (localId, convexId, title, markdown, wordCount, localHeadNodeId,
               divergedRemoteHeadNodeId, syncState, updatedAt, createdAt, draftRevision)
            VALUES ('doc-1', 'j57abc', 'native-spike', 'ours', 1, 'n1', 'theirs',
                    'diverged', 5, 1, 0)
            """)
        try db.execute(
          sql: """
            INSERT INTO outbox
              (documentLocalId, kind, clientMutationId, baseHeadNodeId, payload, attempts,
               nextAttemptAt, createdAt)
            VALUES ('doc-1', 'pointerMove', 'MUT-1', 'n1', '{}', 0, 0, 1)
            """)
      }
      try pool.close()
    }

    let store = try RectoStore(url: url)

    // Adding a nullable column without backfilling would make this row look
    // drainable on the very next launch, and the pointer move behind the
    // conflict would walk the server off the disputed branch.
    let document = try #require(try await store.document(localId: "doc-1"))
    #expect(document.syncState == .diverged)
    #expect(document.queueBlockedReason == "diverged")
    #expect(try await store.documentsWithPendingJobs().isEmpty, "the queue stays held")
    #expect(try await store.pendingJobs(documentLocalId: "doc-1").count == 1, "nothing was lost")
  }
}

@Suite("remote field updates")
struct RemoteFieldUpdateTests {
  @Test("a remote title update touches only the title")
  func titleUpdateIsSurgical() async throws {
    let store = try RectoStore.inMemory()
    _ = try await seedDocument(store)

    // What `mirrorLibrary` would have read before a session wrote.
    let stale = try #require(try await store.document(localId: "doc-1"))

    try await store.saveDraft(
      documentLocalId: "doc-1", markdown: "typed after the list arrived", selection: nil,
      wordCount: 5, job: nil)
    try await store.setSyncState(documentLocalId: "doc-1", .pending)
    let afterEdit = try #require(try await store.document(localId: "doc-1"))

    try await store.updateRemoteTitle(
      documentLocalId: "doc-1", title: "renamed elsewhere", remoteUpdatedAt: 99)

    let updated = try #require(try await store.document(localId: "doc-1"))
    #expect(updated.title == "renamed elsewhere")
    #expect(updated.remoteUpdatedAt == 99)
    // Everything a whole-record save from `stale` would have reverted:
    #expect(updated.draftMarkdown == "typed after the list arrived")
    #expect(updated.draftRevision == afterEdit.draftRevision)
    #expect(updated.syncState == afterEdit.syncState)
    #expect(updated.localHeadNodeId == afterEdit.localHeadNodeId)
    #expect(stale.draftMarkdown == nil, "the stale copy really did predate the edit")
  }
}

@Suite("round-6 store")
struct Round6StoreTests {
  private func seedTwoDocuments(_ store: RectoStore) async throws {
    _ = try await seedDocument(store, localId: "doc-1")
    _ = try await seedDocument(store, localId: "doc-2")
  }

  @Test("a ready job behind a backed-off head does not become a wake time")
  func backedOffHeadHidesItsTail() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    let head = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "1",
        createdAt: 0))
    // The tail carries the default zero timestamp. `MIN` over every row answered
    // with it, so the drain loop woke immediately, found a head it may not send,
    // and armed another zero-delay wake.
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "2",
        createdAt: 0))

    try await store.failJob(id: try #require(head.id), error: "boom", retryAfter: 4, now: 1_000)

    #expect(try await store.earliestNextAttempt() == 5_000)
    #expect(try await store.nextJob(documentLocalId: "doc-1", now: 1_000) == nil)
  }

  @Test("a blocked document arms no wake at all")
  func blockedDocumentHasNoWakeTime() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .rename, clientMutationId: ulid(), payload: "{}",
        createdAt: 0))
    try await store.setQueueBlocked(documentLocalId: "doc-1", reason: "diverged")

    // The queue cannot drain until the divergence is resolved, so a wake for it
    // is a spin: it can only ever request a drain that skips this document.
    #expect(try await store.earliestNextAttempt() == nil)
  }

  @Test("another document's ready head is still a wake time")
  func unblockedDocumentsStillWake() async throws {
    let store = try makeStore()
    try await seedTwoDocuments(store)
    let blockedJob = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .rename, clientMutationId: ulid(), payload: "{}",
        createdAt: 0))
    try await store.failJob(id: try #require(blockedJob.id), error: "boom", retryAfter: 60, now: 0)
    try await store.setQueueBlocked(documentLocalId: "doc-1", reason: "diverged")

    let ready = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-2", kind: .rename, clientMutationId: ulid(), payload: "{}",
        createdAt: 0))
    try await store.failJob(id: try #require(ready.id), error: "boom", retryAfter: 2, now: 1_000)

    #expect(try await store.earliestNextAttempt() == 3_000)
  }

  @Test("a parked head is not a wake time")
  func parkedJobsAreNotWakeTimes() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store)
    let job = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "{}",
        createdAt: 0))
    try await store.parkJob(id: try #require(job.id), reason: "unsendable")

    #expect(try await store.earliestNextAttempt() == nil)
  }

  @Test("a failed VACUUM does not fail the purge that already committed")
  func maintenanceFailureDoesNotFailTheTransition() async throws {
    let store = try makeStore()
    _ = try await seedDocument(store, markdown: "A's only copy")
    _ = try await store.enqueue(
      OutboxJob(
        documentLocalId: "doc-1", kind: .commitEdit, clientMutationId: ulid(), payload: "{}",
        createdAt: 0))
    try await store.setMirrorOwner("user_A")

    struct MaintenanceFailure: Error {}
    await store.setMaintenanceFailureForTesting(MaintenanceFailure())

    // The rows and the ownership marker move in one transaction that has already
    // committed by the time maintenance runs. Reporting its failure would tell
    // the caller to retry a decision whose destructive half already happened.
    try await store.purgeAndSetMirrorOwner("user_B")

    #expect(try await store.documents().isEmpty)
    #expect(try await store.pendingJobCount() == 0)
    #expect(try await store.mirrorOwner() == "user_B")
  }

  @Test("a purge keeps the device id but not the account's settings")
  func purgeKeepsTheDeviceIdentity() async throws {
    let store = try makeStore()
    try await store.saveSetting(key: RectoStore.deviceOriginKey, json: "device-1", dirty: false)
    try await store.saveSetting(key: "theme", json: "paper")
    try await store.setMirrorOwner("user_A")

    try await store.purgeAndSetMirrorOwner("user_B")

    // Minting a new origin on every sign-in would show one Mac as several
    // devices in the history panel.
    #expect(try await store.setting(RectoStore.deviceOriginKey)?.json == "device-1")
    #expect(try await store.setting("theme") == nil)
    #expect(try await store.mirrorOwner() == "user_B")
  }

  @Test("signing out clears the owner but keeps the device id")
  func signOutClearsOwnership() async throws {
    let store = try makeStore()
    try await store.saveSetting(key: RectoStore.deviceOriginKey, json: "device-1", dirty: false)
    try await store.setMirrorOwner("user_A")

    try await store.purgeAndSetMirrorOwner(nil)

    #expect(try await store.mirrorOwner() == nil)
    #expect(try await store.setting(RectoStore.deviceOriginKey)?.json == "device-1")
  }
}
