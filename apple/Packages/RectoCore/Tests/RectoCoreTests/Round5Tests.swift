import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

@Suite("round-5 repros")
struct Round5Tests {
  // MARK: - 3. A session opened during a freeze is born frozen

  @Test("a window opened while signing out cannot write")
  func sessionOpenedDuringFreezeIsFrozen() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()

    await harness.registry.freezeAndFlushAll()
    #expect(await harness.registry.isFrozenForTesting)

    // A window that arrives AFTER the freeze: freezing the sessions that
    // happened to exist would have let this one write between the final
    // unsynced count and the purge.
    let session = try await harness.registry.session(for: localId)
    await #expect(throws: SessionError.frozen) {
      try await session.applyLocalChange(markdown: "typed during sign-out", selection: nil)
    }
    #expect(try await harness.store.document(localId: localId)?.draftMarkdown == nil)

    await harness.registry.resumeAll()
    try await session.applyLocalChange(markdown: "typed after", selection: nil)
    #expect(try await harness.store.document(localId: localId)?.draftMarkdown == "typed after")
  }

  // MARK: - 6. A rejected pointer move must still read as a remote undo

  @Test("a rejected pointer move reconciles the remote undo it lost to")
  func rejectedPointerMoveSeesTheRemoteUndo() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-rejected-undo")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "child text", selection: nil, structural: true)
    await mac.sync.drainNow()
    let child = try #require(try await mac.store.document(localId: localId)).localHeadNodeId

    // Another client undoes to the root. That is a pointer write only.
    _ = try await server.updateCurrentNodeId(
      documentId: seeded.documentId, currentNodeId: seeded.rootNodeId, markdown: "",
      wordCount: 0, updatedAt: Date().timeIntervalSince1970 * 1000)

    // Our own stale redo, queued with an older event time, loses the LWW check.
    let timestamp = Date().timeIntervalSince1970 * 1000 - 600_000
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .pointerMove, clientMutationId: ulid(),
        baseHeadNodeId: child,
        payload: OutboxPayload(
          nodeId: child, createdAt: timestamp, markdown: "child text", wordCount: 2
        ).encoded,
        createdAt: timestamp))

    await mac.sync.drainNow()

    // Storing the response's revision before reconciling turned "newer" into
    // "equal", and the remote undo then read as server lag.
    let document = try #require(try await mac.store.document(localId: localId))
    #expect(
      document.localHeadNodeId == seeded.rootNodeId,
      "the local head followed the remote undo it lost to")
    #expect(try await server.getDocument(documentId: seeded.documentId)?.currentNodeId
      == seeded.rootNodeId)
  }

  // MARK: - 7. Every completedAndBlock writes a barrier

  @Test("a rejected pointer move holds the queue behind it")
  func rejectedPointerMoveBlocksTheQueue() async throws {
    let server = InMemoryTransport()
    let seeded = await server.seedDocument(title: "native-spike-block-pointer")
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mac = try Harness(directory: directory, transport: server, origin: "mac")
    let localId = try await mac.adoptRemoteDocument(seeded)

    let session = DocumentSession(
      documentLocalId: localId, store: mac.store, sync: mac.sync, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "child", selection: nil, structural: true)
    await mac.sync.drainNow()
    let child = try #require(try await mac.store.document(localId: localId)).localHeadNodeId

    _ = try await server.updateCurrentNodeId(
      documentId: seeded.documentId, currentNodeId: seeded.rootNodeId, markdown: "",
      wordCount: 0, updatedAt: Date().timeIntervalSince1970 * 1000)

    let stale = Date().timeIntervalSince1970 * 1000 - 600_000
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .pointerMove, clientMutationId: ulid(),
        baseHeadNodeId: child,
        payload: OutboxPayload(nodeId: child, createdAt: stale, markdown: "child", wordCount: 1)
          .encoded,
        createdAt: stale))
    // Queued behind it: a rename that must NOT go out while the head is unsettled.
    _ = try await mac.store.enqueue(
      OutboxJob(
        documentLocalId: localId, kind: .rename, clientMutationId: ulid(),
        payload: OutboxPayload(title: "should-not-be-sent").encoded, createdAt: stale + 1))

    await mac.sync.drainNow()

    #expect(try await mac.store.document(localId: localId)?.queueBlockedReason != nil)
    #expect(
      try await server.getDocument(documentId: seeded.documentId)?.title
        != "should-not-be-sent", "the queue behind the rejection stayed put")
  }

  // MARK: - 9. A failed open leaves nothing behind

  @Test("a failed open does not leak a holder or a half-built session")
  func failedOpenLeavesNoState() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())

    // No such document: `open()` throws.
    await #expect(throws: (any Error).self) {
      _ = try await harness.registry.session(for: "does-not-exist")
    }
    #expect(await harness.registry.openDocumentIds.isEmpty, "no session left behind")

    // Now it exists; the retry must reach a holder count of one, so a single
    // release performs the final close.
    let localId = try await harness.createLocalDocument(localId: "does-not-exist")
    let session = try await harness.registry.session(for: localId)
    try await session.applyLocalChange(markdown: "works now", selection: nil, structural: true)
    #expect(await harness.registry.openDocumentIds == [localId])

    await harness.registry.release(localId)
    #expect(await harness.registry.openDocumentIds.isEmpty, "one release was enough")
  }
}
