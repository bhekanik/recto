import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

/// The round-2 review's repro scenarios, plus one per remaining blocking finding.
/// Each asserts the *observable* consequence, so reverting the fix fails here
/// rather than somewhere three layers away.
@Suite("round-2 repros")
struct ReviewerRepros {
  // MARK: - 1. Recovered draft must be what the session shows

  @Test("a draft persisted before a crash is what the reopened session displays")
  func recoveredDraftIsShown() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let localId: String

    do {
      let harness = try Harness(directory: directory, transport: InMemoryTransport())
      localId = try await harness.createLocalDocument()
      let session = DocumentSession(
        documentLocalId: localId, store: harness.store, sync: nil, origin: "mac",
        schedulesTimers: false)
      try await session.open()
      try await session.applyLocalChange(
        markdown: "committed sentence.", selection: nil, structural: true)
      // Typed on, but no node boundary and no flush before the process dies.
      try await session.applyLocalChange(
        markdown: "committed sentence. And the part I would hate to lose",
        selection: NodeSelection(anchor: 52, head: 52))
      await session.writeDraft(
        markdown: "committed sentence. And the part I would hate to lose",
        selection: NodeSelection(anchor: 52, head: 52))
    }

    let relaunched = try Harness(directory: directory, transport: InMemoryTransport())
    let session = DocumentSession(
      documentLocalId: localId, store: relaunched.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()

    // Reading the store directly would have passed all along; the bug was that
    // the SESSION showed the head instead.
    let state = try #require(await session.currentState)
    #expect(state.markdown == "committed sentence. And the part I would hate to lose")

    // And the recovered text commits as one node against the persisted head,
    // not as a retype of the whole document.
    try await session.flush()
    let nodes = try await relaunched.store.nodes(documentLocalId: localId)
    #expect(nodes.count == 3)  // root + committed sentence + the recovered draft
    #expect(
      try await relaunched.store.document(localId: localId)?.markdown
        == "committed sentence. And the part I would hate to lose")
  }

  // MARK: - 2. A stale draft must not detach markdown from the head

  @Test("a draft whose head has moved is refused, not written over the winner")
  func staleDraftCannotDetachMarkdown() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-stale-draft")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()

    // A draft queued against the root…
    try await session.applyLocalChange(markdown: "my draft text", selection: nil)
    await session.writeDraft(markdown: "my draft text", selection: nil)

    // …while another client advances the head.
    let theirNode = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId,
      markdown: "their committed text")

    // Reconciliation refreshes `remoteUpdatedAt`, so the draft's `updatedAt` CAS
    // will now PASS. Only the head check stands between this stale draft and
    // `documents.markdown`; that is exactly the finding.
    try await mac.sync.reconcileHead(localId: localId)
    #expect(try await mac.store.document(localId: localId)?.remoteUpdatedAt != nil)

    await mac.sync.drainNow()

    let remote = try #require(try await server.getDocument(documentId: seeded.documentId))
    #expect(remote.currentNodeId == theirNode)
    // The detached state the repro produced: markdown from us, pointer at them.
    #expect(remote.markdown == "their committed text")
    // Nothing local was lost: the draft row is still here.
    #expect(try await mac.store.document(localId: localId)?.draftMarkdown == "my draft text")
  }

  // MARK: - 3. A rejected pointer move must not be acknowledged

  @Test("a rejected pointer move reconciles instead of reporting synced")
  func rejectedPointerMoveIsNotAcknowledged() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-pointer")
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
    await mac.sync.drainNow()
    let ourHead = try #require(try await mac.store.document(localId: localId)?.localHeadNodeId)

    // Our undo is queued, and another client moves the pointer to the root
    // before it drains. That bumps `pointerRevision`, so our move loses the
    // compare-and-set. (Round 7 replaced the wall-clock rule this repro used to
    // trigger: a stale event time is no longer a rejection, which is finding 3.)
    #expect(try await session.undo())
    _ = try await server.updateCurrentNodeId(
      documentId: seeded.documentId, currentNodeId: seeded.rootNodeId, markdown: "",
      wordCount: 0, updatedAt: Date().timeIntervalSince1970 * 1000,
      expectedPointerRevision: nil)

    await mac.sync.drainNow()

    let remote = try #require(try await server.getDocument(documentId: seeded.documentId))
    #expect(remote.currentNodeId == seeded.rootNodeId, "the rejected move did not take")
    #expect(ourHead != seeded.rootNodeId)
    let document = try #require(try await mac.store.document(localId: localId))
    // The rejection was read, not acknowledged: the client reconciled onto the
    // head that won instead of keeping its own and calling that `synced`.
    #expect(document.remoteHeadNodeId == seeded.rootNodeId)
    #expect(
      document.localHeadNodeId == remote.currentNodeId,
      "a synced document must agree with the server about the head")
    #expect(document.markdown == "")
  }

  // MARK: - 4. Offline create is replay-safe and re-keys the whole root

  @Test("a replayed offline create finishes the adoption instead of duplicating the document")
  func offlineCreateIsReplaySafe() async throws {
    let server = InMemoryTransport()
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.createLocalDocument(title: "native-spike-replay")

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "offline text", selection: nil, structural: true)

    await mac.sync.drainNow()
    #expect(await server.documents.count == 1)

    // Replay the create as if its acknowledgement had been lost.
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .createDocument, clientMutationId: ulid(),
        payload: OutboxPayload(title: "native-spike-replay").encoded, createdAt: 0))
    await mac.sync.drainNow()

    #expect(await server.documents.count == 1, "a replay must not create a second document")

    // The child hangs off the SERVER's root — in the node row and in what was
    // actually sent — so the remote DAG materializes.
    let convexId = try #require(try await mac.store.document(localId: localId)?.convexId)
    let remoteNodes = try await server.listNodes(documentId: convexId, sinceCreatedAt: nil)
    let remoteRoot = try #require(remoteNodes.first { $0.parentNodeId == nil })
    let child = try #require(remoteNodes.first { $0.parentNodeId != nil })
    #expect(child.parentNodeId == remoteRoot.nodeId)
    #expect(try await server.materializeRemote(documentId: convexId, nodeId: child.nodeId)
      == "offline text")
    #expect(try await server.getDocument(documentId: convexId)?.markdown == "offline text")
  }

  // MARK: - 6. Adoption must not race local work

  @Test("a keystroke during adoption keeps the local draft and defers the remote head")
  func adoptionDoesNotRaceLocalWork() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-adopt-race")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    _ = try await server.commitFromOtherClient(
      documentId: seeded.documentId, parentNodeId: seeded.rootNodeId, markdown: "their text")
    // Pull their node so the resolver can see it.
    let nodes = try await server.listNodes(documentId: seeded.documentId, sinceCreatedAt: nil)
    try await mac.store.mergeRemoteNodes(
      documentLocalId: localId, nodes: nodes.map { $0.record(documentLocalId: localId) })

    // Local work lands before the adoption commits.
    try await mac.store.saveDraft(
      documentLocalId: localId, markdown: "text I am still typing", selection: nil,
      wordCount: 4, job: nil)

    try await mac.sync.reconcileHead(localId: localId)

    let document = try #require(try await mac.store.document(localId: localId))
    #expect(document.draftMarkdown == "text I am still typing", "the draft survives")
    #expect(document.localHeadNodeId == seeded.rootNodeId, "the head is NOT adopted mid-edit")
    #expect(document.syncState == .pending)
  }

  // MARK: - 7. Keep-remote must not leave jobs that reverse the choice

  @Test("keeping remote rewrites the discarded branch's queue instead of replaying it")
  func keepRemoteRewritesTheQueue() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-keep-remote-queue")
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
    await mac.sync.drainNow()
    #expect(try await mac.store.document(localId: localId)?.syncState == .diverged)

    // The user keeps working while the compare sheet is up, so these are still
    // queued when the decision is made — the case the finding describes.
    try await session.applyLocalChange(markdown: "our second", selection: nil, structural: true)
    await session.writeDraft(markdown: "our second draft", selection: nil)
    let beforeResolve = try await mac.store.pendingJobs(documentLocalId: localId)
    #expect(beforeResolve.contains { $0.kind == .commitEdit })
    #expect(beforeResolve.contains { $0.kind == .draftSave })

    try await session.resolveDivergenceKeepingRemote()

    // Nothing left that would move the pointer back or overwrite their markdown;
    // the commits became node-only uploads so the text is still preserved.
    let queued = try await mac.store.pendingJobs(documentLocalId: localId)
    #expect(!queued.isEmpty)
    #expect(queued.allSatisfy { $0.kind == .appendNode })

    await mac.sync.drainNow()

    let remote = try #require(try await server.getDocument(documentId: seeded.documentId))
    #expect(remote.markdown == "their version", "the discarded branch never wins")
    #expect(try await mac.store.document(localId: localId)?.markdown == "their version")
    // The local branch is preserved on the server, just not as the head.
    let remoteNodes = try await server.listNodes(documentId: seeded.documentId, sinceCreatedAt: nil)
    #expect(remoteNodes.count >= 4)
  }

  // MARK: - 10. Sign-out must not silently delete unsent text
  //
  // Covered in RectoAuthTests (it needs the auth object, not a session).

  @Test("a create interrupted between the server insert and the adoption is finished on retry")
  func partialOfflineCreateIsResumed() async throws {
    let server = InMemoryTransport()
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.createLocalDocument(title: "native-spike-partial")

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "offline text", selection: nil, structural: true)
    let localRoot = try #require(
      try await mac.store.nodes(documentLocalId: localId).first { $0.parentNodeId == nil })

    // The process died after `documents.create` landed and after the id was
    // recorded, but BEFORE the root was adopted: the child still names the local
    // root, in the node row and in the queued payload.
    let created = await server.seedDocument(title: "native-spike-partial")
    var document = try #require(try await mac.store.document(localId: localId))
    document.convexId = created.documentId
    document.remoteHeadNodeId = created.rootNodeId
    try await mac.store.save(document)
    #expect(try await mac.store.node(documentLocalId: localId, nodeId: localRoot.nodeId) != nil)

    await mac.sync.drainNow()

    // The retry finished the adoption instead of acknowledging a half-done one.
    #expect(try await mac.store.node(documentLocalId: localId, nodeId: localRoot.nodeId) == nil)
    let remoteNodes = try await server.listNodes(
      documentId: created.documentId, sinceCreatedAt: nil)
    let child = try #require(remoteNodes.first { $0.parentNodeId != nil })
    #expect(child.parentNodeId == created.rootNodeId)
    #expect(
      try await server.materializeRemote(documentId: created.documentId, nodeId: child.nodeId)
        == "offline text")
  }
}
