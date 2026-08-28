import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("round-3 repros")
struct Round3Tests {
  // MARK: - 2. Stale timers must not overwrite newer text

  @Test("a late draft debounce cannot write its old text over a newer one")
  func staleDraftTimerIsRefused() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()

    try await session.applyLocalChange(markdown: "change A", selection: nil)
    let generationA = try #require(try await harness.store.document(localId: localId))
      .draftRevision
    try await session.applyLocalChange(markdown: "change A then B", selection: nil)

    // A's 250 ms task finally fires, carrying A's text and A's token.
    await session.writeDraft(
      markdown: "change A", selection: nil, expectedDraftRevision: generationA)

    #expect(
      try await harness.store.document(localId: localId)?.draftMarkdown == "change A then B",
      "the newer text survives the older timer")
  }

  @Test("a late idle commit cannot clear a newer draft")
  func staleIdleTimerIsRefused() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "first", selection: nil)
    let stale = try #require(try await harness.store.document(localId: localId)).draftRevision
    try await session.applyLocalChange(markdown: "first and second", selection: nil)

    try await session.tickIdle(expectedDraftRevision: stale)

    let document = try #require(try await harness.store.document(localId: localId))
    #expect(document.draftMarkdown == "first and second")
    #expect(try await harness.store.nodes(documentLocalId: localId).count == 1, "no node committed")
  }

  // MARK: - 3. Offline root re-key must cover pointer targets

  @Test("an undo to the offline root is re-keyed before it is sent")
  func undoToOfflineRootIsRekeyed() async throws {
    let server = InMemoryTransport()
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.createLocalDocument(title: "native-spike-undo-root")
    let localRoot = try #require(
      try await mac.store.nodes(documentLocalId: localId).first).nodeId

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "offline text", selection: nil, structural: true)
    // …all the way back to the root the server has never heard of.
    #expect(try await session.undo())
    #expect(try await mac.store.document(localId: localId)?.localHeadNodeId == localRoot)

    await mac.sync.drainNow()

    let convexId = try #require(try await mac.store.document(localId: localId)?.convexId)
    let remote = try #require(try await server.getDocument(documentId: convexId))
    let remoteNodes = try await server.listNodes(documentId: convexId, sinceCreatedAt: nil)
    // The pointer must name a node the server actually has — it does not
    // validate this, so an un-rekeyed payload corrupts the head silently.
    #expect(remoteNodes.contains { $0.nodeId == remote.currentNodeId })
    #expect(remote.currentNodeId != localRoot)
  }

  // MARK: - 4. Remote deletion must not eat a draft-only document

  @Test("a document removed remotely is kept when it still holds a draft")
  func remoteDeletionKeepsDraftOnlyWork() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-deleted")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    try await mac.sync.mirrorLibrary(await server.summaries())
    let localId = try #require(try await mac.store.documents().first?.localId)

    // The write-ahead path persists the draft BEFORE its outbox job; a crash can
    // leave exactly this state.
    try await mac.store.saveDraft(
      documentLocalId: localId, markdown: "the only copy of this", selection: nil,
      wordCount: 5, job: nil)
    #expect(try await mac.store.pendingJobs(documentLocalId: localId).isEmpty)

    try await server.remove(documentId: seeded.documentId)
    try await mac.sync.mirrorLibrary(await server.summaries())

    #expect(try await mac.store.document(localId: localId)?.draftMarkdown == "the only copy of this")
  }

  @Test("a document removed remotely with nothing local is dropped")
  func remoteDeletionRemovesCleanRow() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-clean-delete")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    try await mac.sync.mirrorLibrary(await server.summaries())
    #expect(try await mac.store.documents().count == 1)

    try await server.remove(documentId: seeded.documentId)
    try await mac.sync.mirrorLibrary(await server.summaries())
    #expect(try await mac.store.documents().isEmpty)
  }

  // MARK: - 8. A divergence must hold the whole queue

  @Test("a divergence stops the jobs behind it reaching the server")
  func divergenceBlocksTheQueue() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-block")
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
    try await session.applyLocalChange(markdown: "our first", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "our second", selection: nil, structural: true)
    // A pointer move behind the commits: this is the one that would push the
    // server back to the branch the user has not decided about yet.
    #expect(try await session.undo())

    await mac.sync.drainNow()

    #expect(try await mac.store.document(localId: localId)?.syncState == .diverged)
    let remote = try #require(try await server.getDocument(documentId: seeded.documentId))
    #expect(remote.markdown == "their version", "the queue behind the divergence never ran")
    #expect(try await !mac.store.pendingJobs(documentLocalId: localId).isEmpty)
  }

  // MARK: - 9/10. Resolution CAS

  @Test("a resolution aborts when the divergence moved under it")
  func resolutionRaceIsRefused() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-race")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let theirs = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "R1")
    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "ours", selection: nil, structural: true)
    await mac.sync.drainNow()
    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.divergedRemoteHeadNodeId == theirs)

    // The store-level CAS is the guarantee; the sheet's snapshot is stale.
    await #expect(throws: StoreError.self) {
      try await mac.store.resolveKeepingRemote(
        documentLocalId: localId,
        expecting: .init(
          localHeadNodeId: document.localHeadNodeId, divergedRemoteHeadNodeId: theirs,
          remotePointerRevision: (document.remotePointerRevision ?? 0) + 99),
        markdown: "R1", wordCount: 1)
    }
    #expect(try await mac.store.document(localId: localId)?.divergedRemoteHeadNodeId == theirs)
  }

  @Test("keep-local queues the rebase behind the old branch's node uploads")
  func keepLocalOrdersTheQueue() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-keep-local-order")
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
    try await session.applyLocalChange(markdown: "ours one", selection: nil, structural: true)
    await mac.sync.drainNow()
    #expect(try await mac.store.document(localId: localId)?.syncState == .diverged)

    // More work queued while the sheet is up — offline, so it never drained.
    try await session.applyLocalChange(markdown: "ours two", selection: nil, structural: true)
    await session.writeDraft(markdown: "ours two draft", selection: nil)

    try await session.resolveDivergenceKeepingLocal()

    let queued = try await mac.store.pendingJobs(documentLocalId: localId)
    // Old commits demoted to node-only uploads, drafts dropped, and the rebased
    // commit last — anything else replays against the discarded base.
    #expect(queued.first?.kind == .appendNode)
    #expect(queued.last?.kind == .commitEdit)
    #expect(!queued.contains { $0.kind == .draftSave })
    #expect(!queued.contains { $0.kind == .pointerMove })

    await mac.sync.releaseDocument(localId: localId)
    await mac.sync.drainNow()
    #expect(try await server.getDocument(documentId: seeded.documentId)?.markdown == "ours two")
  }

  // MARK: - 11. Malformed work is parked, not sent

  @Test("an undecodable job is parked with its reason, never sent")
  func malformedJobIsParked() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-malformed")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .commitEdit, clientMutationId: ulid(),
        baseHeadNodeId: seeded.rootNodeId, payload: "{ this is not json",
        createdAt: 0))

    await mac.sync.drainNow()

    // Not sent: an empty nodeId/patch passes the server's validators and can
    // move `currentNodeId` to "".
    #expect(await server.commitAttempts.isEmpty)
    // Not deleted either — it is the only copy of that work.
    let parked = try await mac.store.parkedJobs()
    #expect(parked.count == 1)
    #expect(parked.first?.lastError?.isEmpty == false)
    #expect(try await mac.store.document(localId: localId)?.syncState == .failed)
    #expect(try await server.getDocument(documentId: seeded.documentId)?.currentNodeId
      == seeded.rootNodeId)
  }

  @Test("a job missing a required field is parked rather than sent with defaults")
  func incompleteJobIsParked() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-incomplete")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    // Decodes fine, but a commit without a nodeId is not a commit.
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .commitEdit, clientMutationId: ulid(),
        baseHeadNodeId: seeded.rootNodeId,
        payload: OutboxPayload(markdown: "text", wordCount: 1).encoded, createdAt: 0))

    await mac.sync.drainNow()

    #expect(await server.commitAttempts.isEmpty)
    #expect(try await mac.store.parkedJobs().count == 1)
  }
}
