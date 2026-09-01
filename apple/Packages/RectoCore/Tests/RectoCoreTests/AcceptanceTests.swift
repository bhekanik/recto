import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

/// The acceptance list from plan 023 §9, N4:
/// "Create/edit/undo offline, kill app, relaunch, reconnect: zero loss;
///  two-client fast-forward and divergence flows pass."
@Suite("N4 acceptance")
struct AcceptanceTests {
  @Test("a title acknowledged before its body commit leaves no phantom ingress")
  func titleBeforeBodyAcknowledgementSettles() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let remote = try await server.createDocument(
      title: "Before", documentUuid: "title-before-body-ack")
    let harness = try Harness(directory: directory, transport: server)
    let localId = try await harness.adoptRemoteDocument(remote, localId: "title-before-body-ack")
    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: harness.sync, origin: "mac",
      deriveTitle: { $0 }, schedulesTimers: false)
    try await session.open()
    await harness.sync.start()
    let markdown = "# Title reached the server first"
    let generation = try harness.store.saveEditorIngressSynchronously(
      documentLocalId: localId, markdown: markdown, selection: nil, wordCount: 5,
      clientMutationId: ulid(),
      draftPayload: OutboxPayload(markdown: markdown, wordCount: 5).encoded)
    let titleJob = OutboxJob(
      documentLocalId: localId, kind: .draftSave, clientMutationId: ulid(),
      payload: OutboxPayload(title: markdown, markdown: markdown, wordCount: 5).encoded,
      createdAt: 1)
    #expect(try await harness.store.finishEditorIngressTitle(
      documentLocalId: localId, markdown: markdown, expectedDraftRevision: generation,
      title: markdown, job: titleJob))

    await harness.sync.drainNow()
    let titleAcknowledged = try #require(try await harness.store.document(localId: localId))
    #expect(titleAcknowledged.markdown != markdown)
    #expect(titleAcknowledged.editorIngressRevision != nil)
    #expect(titleAcknowledged.editorIngressAcknowledged)
    #expect(try await harness.store.pendingJobs(documentLocalId: localId).isEmpty)

    try await session.applyPersistedLocalChange(
      markdown: markdown, selection: nil, structural: true, generation: generation)
    await harness.sync.drainNow()

    let settled = try #require(try await harness.store.document(localId: localId))
    let remoteSettled = try #require(try await server.getDocument(documentId: remote.documentId))
    #expect(remoteSettled.markdown == markdown)
    #expect(remoteSettled.title == markdown)
    #expect(settled.draftMarkdown == nil)
    #expect(settled.editorIngressRevision == nil)
    #expect(!settled.editorIngressAcknowledged)
    #expect(try await harness.store.pendingJobs(documentLocalId: localId).isEmpty)
    #expect(try await harness.store.unsyncedWorkCount() == 0)
    #expect(try await harness.store.nodes(documentLocalId: localId).count == 2)
  }

  @Test("opening a recovered clean head wakes an already-running sync engine")
  func recoveredTitleRepairWakesSync() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let remote = try await server.createDocument(
      title: "Before", documentUuid: "recovered-title-wake")
    let localId: String
    let markdown = "# Recovered remotely"
    let nodeCount: Int

    do {
      let first = try Harness(directory: directory, transport: server)
      localId = try await first.adoptRemoteDocument(remote, localId: "recovered-title-wake")
      let session = DocumentSession(
        documentLocalId: localId, store: first.store, sync: first.sync, origin: "mac",
        deriveTitle: { $0 }, schedulesTimers: false)
      try await session.open()
      await first.sync.start()

      let generation = try first.store.saveEditorIngressSynchronously(
        documentLocalId: localId, markdown: markdown, selection: nil, wordCount: 2,
        clientMutationId: ulid(),
        draftPayload: OutboxPayload(markdown: markdown, wordCount: 2).encoded)
      try await session.applyPersistedLocalChange(
        markdown: markdown, selection: nil, structural: true, generation: generation)
      await first.sync.drainNow()

      // The commit advanced the server CAS while the preserved body-only draft
      // was already in flight. Complete its retry explicitly at the refreshed
      // baseline, then kill the client before any title worker can run.
      if let bodyOnlyJob = try await first.store.pendingJobs(documentLocalId: localId)
        .first(where: { $0.kind == .draftSave })
      {
        let beforeBodyAck = try #require(try await first.store.document(localId: localId))
        let bodyResponse = try await server.updateMarkdown(
          documentId: remote.documentId, markdown: markdown, wordCount: 2,
          expectedUpdatedAt: try #require(beforeBodyAck.remoteUpdatedAt),
          expectedHeadNodeId: bodyOnlyJob.baseHeadNodeId,
          title: nil)
        #expect(!bodyResponse.stale)
        #expect(!bodyResponse.headMoved)
        try await first.store.setSyncState(
          documentLocalId: localId, beforeBodyAck.syncState,
          remoteUpdatedAt: bodyResponse.updatedAt)
        try await first.store.acknowledgeEditorIngress(
          documentLocalId: localId, markdown: markdown, title: nil)
        try await first.store.completeJob(id: try #require(bodyOnlyJob.id))
      }

      let pending = try #require(try await first.store.document(localId: localId))
      #expect(pending.editorIngressRevision != nil)
      #expect(pending.draftMarkdown == markdown)
      #expect(try await first.store.pendingJobs(documentLocalId: localId).isEmpty)
      #expect(try await server.getDocument(documentId: remote.documentId)?.title == "Before")
      nodeCount = try await first.store.nodes(documentLocalId: localId).count
      await first.sync.stop()
      try await first.store.closeForTesting()
    }

    let relaunched = try Harness(directory: directory, transport: server)
    await relaunched.sync.start()
    await relaunched.sync.drainNow()
    #expect(try await server.getDocument(documentId: remote.documentId)?.title == "Before")

    let reopened = DocumentSession(
      documentLocalId: localId, store: relaunched.store, sync: relaunched.sync, origin: "mac",
      deriveTitle: { $0 }, schedulesTimers: false)
    try await reopened.open()
    for _ in 0..<100 {
      if try await server.getDocument(documentId: remote.documentId)?.title == markdown { break }
      try await Task.sleep(for: .milliseconds(5))
    }

    #expect(try await server.getDocument(documentId: remote.documentId)?.title == markdown)
    #expect(try await relaunched.store.nodes(documentLocalId: localId).count == nodeCount)
    #expect(try await relaunched.store.document(localId: localId)?.editorIngressRevision == nil)
    #expect(try await relaunched.store.pendingJobs(documentLocalId: localId).isEmpty)
  }

  @Test("a live clean revert wakes the sync drain")
  func liveCleanRevertWakesSyncDrain() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let remote = try await server.createDocument(
      title: "Live clean revert", documentUuid: "live-clean-revert")
    let harness = try Harness(directory: directory, transport: server)
    let localId = try await harness.adoptRemoteDocument(remote, localId: "live-clean-revert")
    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: harness.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    await harness.sync.start()

    let older = "older draft already sent"
    let olderGeneration = try harness.store.saveEditorIngressSynchronously(
      documentLocalId: localId, markdown: older, selection: nil, wordCount: 4,
      clientMutationId: ulid(),
      draftPayload: OutboxPayload(markdown: older, wordCount: 4).encoded)
    try await session.applyPersistedLocalChange(
      markdown: older, selection: nil, generation: olderGeneration)
    await harness.sync.drainNow()
    #expect(try await server.getDocument(documentId: remote.documentId)?.markdown == older)

    let clean = ""
    let cleanGeneration = try harness.store.saveEditorIngressSynchronously(
      documentLocalId: localId, markdown: clean, selection: nil, wordCount: 0,
      clientMutationId: ulid(),
      draftPayload: OutboxPayload(markdown: clean, wordCount: 0).encoded)
    try await session.applyPersistedLocalChange(
      markdown: clean, selection: nil, generation: cleanGeneration)

    try await Task.sleep(for: .milliseconds(100))
    #expect(try await server.getDocument(documentId: remote.documentId)?.markdown == clean)
  }

  @Test("a clean revert survives relaunch and supersedes an older remote draft")
  func cleanRevertIsDurableRemoteIntent() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let remote = try await server.createDocument(
      title: "Clean revert", documentUuid: "clean-revert")
    let localId: String

    do {
      let first = try Harness(directory: directory, transport: server)
      localId = try await first.adoptRemoteDocument(remote, localId: "clean-revert")
      let session = DocumentSession(
        documentLocalId: localId, store: first.store, sync: first.sync, origin: "mac",
        schedulesTimers: false)
      try await session.open()

      let older = "older draft already sent"
      let olderGeneration = try first.store.saveEditorIngressSynchronously(
        documentLocalId: localId, markdown: older, selection: nil, wordCount: 4,
        clientMutationId: ulid(),
        draftPayload: OutboxPayload(markdown: older, wordCount: 4).encoded)
      try await session.applyPersistedLocalChange(
        markdown: older, selection: nil, generation: olderGeneration)
      await first.sync.drainNow()
      #expect(try await server.getDocument(documentId: remote.documentId)?.markdown == older)

      let clean = ""
      _ = try first.store.saveEditorIngressSynchronously(
        documentLocalId: localId, markdown: clean, selection: nil, wordCount: 0,
        clientMutationId: ulid(),
        draftPayload: OutboxPayload(markdown: clean, wordCount: 0).encoded)
      let pending = try #require(try await first.store.document(localId: localId))
      #expect(pending.displayMarkdown == clean)
      #expect(pending.editorIngressRevision != nil)
      #expect(pending.syncState == .pending)
      try await first.store.closeForTesting()
    }

    let relaunched = try Harness(directory: directory, transport: server)
    let reopened = DocumentSession(
      documentLocalId: localId, store: relaunched.store, sync: relaunched.sync, origin: "mac",
      schedulesTimers: false)
    try await reopened.open()
    #expect(await reopened.currentState?.markdown == "")

    await relaunched.sync.drainNow()

    #expect(try await server.getDocument(documentId: remote.documentId)?.markdown == "")
    let settled = try #require(try await relaunched.store.document(localId: localId))
    #expect(settled.displayMarkdown == "")
    #expect(settled.draftMarkdown == nil)
    #expect(settled.editorIngressRevision == nil)
    #expect(settled.syncState == .synced)
    #expect(try await relaunched.store.pendingJobs(documentLocalId: localId).isEmpty)
  }

  @Test(
    "relaunch restores canonically equivalent editor ingress exactly",
    arguments: [("😀 café\r\nnext\n", "😀 cafe\u{301}\r\nnext\n"),
      ("😀 cafe\u{301}\r\nnext\n", "😀 café\r\nnext\n")]
  )
  func exactEditorIngressSurvivesRelaunch(original: String, edited: String) async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let remote = try await server.createDocument(
      title: "Exact ingress", documentUuid: "exact-ingress")
    let localId: String

    do {
      let first = try Harness(directory: directory, transport: server)
      localId = try await first.adoptRemoteDocument(remote, localId: "exact-ingress")
      let session = DocumentSession(
        documentLocalId: localId, store: first.store, sync: first.sync, origin: "mac",
        schedulesTimers: false)
      try await session.open()
      try await session.applyLocalChange(markdown: original, selection: nil, structural: true)
      _ = try first.store.saveEditorIngressSynchronously(
        documentLocalId: localId, markdown: edited, selection: nil, wordCount: 2,
        clientMutationId: ulid(),
        draftPayload: OutboxPayload(markdown: edited, wordCount: 2).encoded)
      try await first.store.closeForTesting()
    }

    let relaunched = try Harness(directory: directory, transport: server)
    let reopened = DocumentSession(
      documentLocalId: localId, store: relaunched.store, sync: relaunched.sync, origin: "mac",
      schedulesTimers: false)
    try await reopened.open()
    let state = try #require(await reopened.currentState)
    #expect(Array(state.markdown.utf16) == Array(edited.utf16))
    let persisted = try #require(
      try await relaunched.store.document(localId: localId)?.displayMarkdown)
    #expect(Array(persisted.utf16) == Array(edited.utf16))
    await relaunched.sync.start()
    await relaunched.sync.drainNow()
    let published = try #require(
      try await server.getDocument(documentId: remote.documentId)?.markdown)
    #expect(Array(published.utf16) == Array(edited.utf16))
  }

  @Test("an open offline session rebases onto the acknowledged server root")
  func openSessionRebasesAfterOfflineRootAdoption() async throws {
    let store = try RectoStore.inMemory()
    let library = DocumentLibrary(store: store, sync: nil, origin: "mac")
    let local = try await library.createDocument(title: "Root race")
    let oldRoot = local.localHeadNodeId
    let session = DocumentSession(
      documentLocalId: local.localId, store: store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    let markdown = "typed while create acknowledgement lands · 中文 · 🚀"
    let generation = try store.saveEditorIngressSynchronously(
      documentLocalId: local.localId, markdown: markdown, selection: nil, wordCount: 8,
      clientMutationId: ulid(),
      draftPayload: OutboxPayload(markdown: markdown, wordCount: 8).encoded)

    try await store.finishOfflineCreate(
      documentLocalId: local.localId, convexId: "server-document",
      serverRootNodeId: "server-root", rewritePayloadNodeIds: { raw, _, _ in raw })
    try await session.applyPersistedLocalChange(
      markdown: markdown, selection: nil, generation: generation)
    try await session.flush()

    let restored = try #require(try await store.document(localId: local.localId))
    #expect(restored.displayMarkdown == markdown)
    #expect(restored.localHeadNodeId != "server-root")
    let committed = try #require(
      try await store.node(documentLocalId: local.localId, nodeId: restored.localHeadNodeId))
    #expect(committed.parentNodeId == "server-root")
    #expect(try await store.node(documentLocalId: local.localId, nodeId: oldRoot) == nil)
  }

  @Test("lost offline-create answer replays one server document after relaunch")
  func lostCreateAcknowledgementIsIdempotentAcrossRelaunch() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let localId = "offline-create-replay-uuid"
    let expectedMarkdown = "# Train notes\n\nUnicode: café · 中文 · 🚀"

    do {
      let first = try Harness(directory: directory, transport: server)
      _ = try await first.createLocalDocument(title: "Train notes", localId: localId)
      let session = DocumentSession(
        documentLocalId: localId,
        store: first.store,
        sync: first.sync,
        origin: "mac",
        schedulesTimers: false)
      try await session.open()
      try await session.applyLocalChange(
        markdown: expectedMarkdown, selection: nil, structural: true)

      await server.inject([.dropAcknowledgement])
      await first.sync.drainNow()

      #expect(await server.documents.count == 1)
      #expect(try await first.store.document(localId: localId)?.convexId == nil)
      #expect(try await first.store.pendingJobs(documentLocalId: localId).count == 2)
      try await first.store.closeForTesting()
    }

    let relaunched = try Harness(directory: directory, transport: server)
    let createJob = try #require(
      try await relaunched.store.pendingJobs(documentLocalId: localId)
        .first { $0.kind == .createDocument })
    try await relaunched.store.failJob(
      id: try #require(createJob.id), error: "", retryAfter: 0, now: 0)

    await relaunched.sync.drainNow()

    let remoteId = try #require(
      try await relaunched.store.document(localId: localId)?.convexId)
    #expect(await server.createAttempts == [localId, localId])
    #expect(await server.documents.count == 1)
    #expect(try await server.getDocument(documentId: remoteId)?.markdown == expectedMarkdown)
    #expect(try await relaunched.store.pendingJobs(documentLocalId: localId).isEmpty)
  }

  @Test("offline create + edits + undo survive a process kill and reach the server on reconnect")
  func offlineWorkSurvivesRelaunch() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = InMemoryTransport()
    let localId: String
    let expectedMarkdown = "Chapter one. 😀\n\nA second paragraph."

    // --- Session 1: entirely offline. The transport is never called. ---
    do {
      let harness = try Harness(directory: directory, transport: server)
      localId = try await harness.createLocalDocument(title: "native-spike-offline")
      let session = DocumentSession(
        documentLocalId: localId, store: harness.store, sync: nil, origin: "mac",
        schedulesTimers: false)
      try await session.open()
      try await session.applyLocalChange(
        markdown: "Chapter one. 😀", selection: nil, structural: true)
      try await session.applyLocalChange(
        markdown: "Chapter one. 😀\n\nA second paragraph.", selection: nil, structural: true)
      try await session.applyLocalChange(
        markdown: "Chapter one. 😀\n\nA second paragraph. Oops.", selection: nil, structural: true)
      // Undo the last edit; the branch stays in the DAG.
      #expect(try await session.undo())
      #expect(try await session.redo())
      #expect(try await session.undo())
      try await session.flush()
      #expect(await session.currentState?.markdown == expectedMarkdown)
      // Nothing has reached the server.
      #expect(await server.documents.isEmpty)
    }

    // --- The process dies. Session 2 opens the same database. ---
    let relaunched = try Harness(directory: directory, transport: server)
    let restored = try #require(try await relaunched.store.document(localId: localId))
    #expect(restored.markdown == expectedMarkdown, "zero loss across a relaunch")
    // root + three edits. The undo moved the pointer; it grew nothing.
    #expect(try await relaunched.store.nodes(documentLocalId: localId).count == 4)
    let queued = try await relaunched.store.pendingJobs(documentLocalId: localId)
    #expect(queued.count >= 6, "create, commits, undo and redo pointer moves stay queued")

    // --- Reconnect and drain. ---
    await relaunched.sync.drainNow()

    let convexId = try #require(try await relaunched.store.document(localId: localId)?.convexId)
    let remote = try #require(try await server.getDocument(documentId: convexId))
    #expect(remote.markdown == expectedMarkdown)
    #expect(try await relaunched.store.pendingJobs(documentLocalId: localId).isEmpty)
    // Every local node reached the server, including the undone branch.
    let localNodes = try await relaunched.store.nodes(documentLocalId: localId)
    let remoteNodes = try await server.listNodes(documentId: convexId, sinceCreatedAt: nil)
    #expect(Set(remoteNodes.map(\.nodeId)) == Set(localNodes.map(\.nodeId)))
    let finalDoc = try #require(try await relaunched.store.document(localId: localId))
    #expect(finalDoc.syncState == .synced)
    // Only claimed once the heads actually agree.
    #expect(finalDoc.remoteHeadNodeId == finalDoc.localHeadNodeId)
  }

  @Test("a second client fast-forwards onto the first client's head")
  func twoClientFastForward() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-ff")

    let directoryA = Harness.makeDirectory()
    let directoryB = Harness.makeDirectory()
    defer {
      try? FileManager.default.removeItem(at: directoryA)
      try? FileManager.default.removeItem(at: directoryB)
    }
    let macA = try Harness(directory: directoryA, transport: server, origin: "mac")
    let macB = try Harness(directory: directoryB, transport: server, origin: "ipad")
    let idA = try await macA.adoptRemoteDocument(seeded)
    let idB = try await macB.adoptRemoteDocument(seeded)

    // A writes and syncs.
    let sessionA = DocumentSession(
      documentLocalId: idA, store: macA.store, sync: macA.sync, origin: "mac",
      schedulesTimers: false)
    try await sessionA.open()
    try await sessionA.applyLocalChange(
      markdown: "written on the mac", selection: nil, structural: true)
    await macA.sync.drainNow()
    #expect(try await server.getDocument(documentId: seeded.documentId)?.markdown == "written on the mac")

    // B has no local work, so it adopts A's head and keeps its caret.
    let sessionB = DocumentSession(
      documentLocalId: idB, store: macB.store, sync: macB.sync, origin: "ipad",
      schedulesTimers: false)
    try await sessionB.open()
    try await macB.sync.reconcileHead(localId: idB)

    let adopted = try #require(try await macB.store.document(localId: idB))
    #expect(adopted.markdown == "written on the mac")
    #expect(adopted.syncState == .synced)
    #expect(adopted.divergedRemoteHeadNodeId == nil)
  }

  @Test("two clients editing the same base diverge, and both branches are kept")
  func twoClientDivergence() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-diverge")

    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    // The other client commits onto the shared root while this one is offline.
    let theirNode = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId,
      markdown: "their version")

    // This client commits its own child of the same root.
    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "our version", selection: nil, structural: true)
    let ourHead = try #require(try await mac.store.document(localId: localId)?.localHeadNodeId)

    await mac.sync.drainNow()

    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.syncState == .diverged)
    #expect(document.divergedRemoteHeadNodeId == theirNode)
    // Both branches survive on the server: commitEdit inserts the node whatever
    // the head check says, so no text was dropped.
    let remoteNodes = try await server.listNodes(
      documentId: seeded.documentId, sinceCreatedAt: nil)
    #expect(remoteNodes.contains { $0.nodeId == ourHead })
    #expect(remoteNodes.contains { $0.nodeId == theirNode })

    // The UI gets everything the compare sheet needs.
    try await session.open()
    let divergence = try #require(await session.currentState?.divergence)
    #expect(divergence.localHeadNodeId == ourHead)
    #expect(divergence.remoteHeadNodeId == theirNode)
    #expect(divergence.baseNodeId == seeded.rootNodeId)
  }

  @Test("keeping the local branch re-parents it onto the server's head")
  func resolveKeepingLocal() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-keep-local")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    _ = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "their version")

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "our version", selection: nil, structural: true)
    await mac.sync.drainNow()
    #expect(try await mac.store.document(localId: localId)?.syncState == .diverged)

    try await session.resolveDivergenceKeepingLocal()
    await mac.sync.drainNow()

    #expect(try await server.getDocument(documentId: seeded.documentId)?.markdown == "our version")
    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.divergedRemoteHeadNodeId == nil)
    #expect(document.markdown == "our version")
  }

  @Test("keeping the remote branch leaves the local one reachable")
  func resolveKeepingRemote() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-keep-remote")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    _ = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "their version")

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "our version", selection: nil, structural: true)
    let ourHead = try #require(try await mac.store.document(localId: localId)?.localHeadNodeId)
    await mac.sync.drainNow()

    try await session.resolveDivergenceKeepingRemote()
    #expect(try await mac.store.document(localId: localId)?.markdown == "their version")
    // Nothing is deleted: the local branch is still in the history panel.
    #expect(try await mac.store.node(documentLocalId: localId, nodeId: ourHead) != nil)
    #expect(
      try await mac.store.materializedMarkdown(documentLocalId: localId, nodeId: ourHead)
        == "our version")
  }

  @Test("a lost acknowledgement is replayed with the same key and answered identically")
  func lostAcknowledgementIsReplayed() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-lost-ack")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "committed once", selection: nil, structural: true)

    // The mutation lands, then the socket drops before the answer arrives.
    await server.inject([.dropAcknowledgement])
    await mac.sync.drainNow()

    let queued = try await mac.store.pendingJobs(documentLocalId: localId)
    #expect(queued.count == 1, "the job stays queued until it is acknowledged")
    let key = try #require(queued.first?.clientMutationId)
    #expect(queued.first?.attempts == 1)
    #expect(try await mac.store.document(localId: localId)?.syncState == .failed)

    // Retry. The same key comes back, and the server replays its original answer
    // instead of reporting a spurious divergence.
    try await mac.store.failJob(id: try #require(queued.first?.id), error: "", retryAfter: 0, now: 0)
    await mac.sync.drainNow()

    let attempts = await server.commitAttempts
    #expect(attempts == [key, key], "the idempotency key is reused, not regenerated")
    #expect(try await mac.store.pendingJobs(documentLocalId: localId).isEmpty)
    #expect(try await server.getDocument(documentId: seeded.documentId)?.markdown == "committed once")
    #expect(try await server.getDocument(documentId: seeded.documentId)?.title == "committed once")
    #expect(try await mac.store.document(localId: localId)?.title == "committed once")
    #expect(try await mac.store.document(localId: localId)?.syncState == .synced)
  }

  @Test("a token expiring mid-drain re-authenticates and finishes the queue")
  func tokenExpiryMidDrain() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-token")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "first", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "first second", selection: nil, structural: true)
    try await session.applyLocalChange(
      markdown: "first second third", selection: nil, structural: true)

    // Clerk's convex-template token lives 60 seconds; a long drain outlives it.
    await server.inject([.tokenExpired])
    await mac.sync.drainNow()
    #expect(await server.loginCount == 1, "the engine re-authenticates rather than just backing off")
    #expect(try await !mac.store.pendingJobs(documentLocalId: localId).isEmpty)

    // Clear the backoff the way the retry timer would, then finish.
    for job in try await mac.store.pendingJobs(documentLocalId: localId) {
      try await mac.store.failJob(id: try #require(job.id), error: "", retryAfter: 0, now: 0)
    }
    await mac.sync.drainNow()

    #expect(try await mac.store.pendingJobs(documentLocalId: localId).isEmpty)
    #expect(
      try await server.getDocument(documentId: seeded.documentId)?.markdown
        == "first second third")
  }

  @Test("an offline drain leaves the queue intact and backs off")
  func offlineDrainIsHarmless() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-offline-drain")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "typed offline", selection: nil, structural: true)

    await server.inject([.offline])
    await mac.sync.drainNow()

    let queued = try await mac.store.pendingJobs(documentLocalId: localId)
    #expect(queued.count == 1)
    #expect(queued.first?.attempts == 1)
    #expect((queued.first?.nextAttemptAt ?? 0) > 0, "backoff is scheduled")
    #expect(try await mac.store.document(localId: localId)?.markdown == "typed offline")
  }
}
