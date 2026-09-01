import Foundation
import RectoHistory
import RectoStore
import RectoSync
import Testing

@testable import RectoCore

@Suite("DocumentLibrary")
struct DocumentLibraryTests {
  @Test("create is one durable local document, root and outbox mutation")
  func createsOfflineDocumentAtomically() async throws {
    let store = try RectoStore.inMemory()
    let library = DocumentLibrary(
      store: store,
      sync: nil,
      origin: "mac",
      localId: { "offline-document-uuid" },
      nodeId: { "01KROOTNODE000000000000000" },
      mutationId: { "01KCREATE0000000000000000" },
      now: { 1_000 })

    let created = try await library.createDocument(title: "Train notes")

    #expect(created.localId == "offline-document-uuid")
    #expect(created.convexId == nil)
    #expect(created.localHeadNodeId == "01KROOTNODE000000000000000")
    #expect(created.markdown == "")
    #expect(created.titleMode == .derived)
    #expect(created.syncState == .pending)
    #expect(try await library.documents() == [created])
    #expect(try await store.nodes(documentLocalId: created.localId).count == 1)
    let jobs = try await store.pendingJobs(documentLocalId: created.localId)
    #expect(jobs.count == 1)
    #expect(jobs.first?.kind == .createDocument)
    #expect(jobs.first?.clientMutationId == "01KCREATE0000000000000000")
  }

  @Test("a same-value rename switches to manual and freezes derivation")
  func sameValueRenameFreezesDerivation() async throws {
    let store = try RectoStore.inMemory()
    let library = DocumentLibrary(
      store: store,
      sync: nil,
      origin: "mac",
      localId: { "offline-document-uuid" },
      nodeId: { "01KROOTNODE000000000000000" },
      mutationId: { ulid() },
      now: { 1_000 })
    let created = try await library.createDocument(title: "Train notes")

    let renamed = try await library.renameDocument(localId: created.localId, title: created.title)
    #expect(renamed.title == "Train notes")
    #expect(renamed.titleMode == .manual)

    let session = DocumentSession(
      documentLocalId: created.localId, store: store, sync: nil, origin: "mac",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "# A derived replacement", selection: nil)

    let edited = try #require(try await store.document(localId: created.localId))
    #expect(edited.title == "Train notes")
    #expect(edited.titleMode == .manual)
    let renameJob = try #require(
      try await store.pendingJobs(documentLocalId: created.localId).first { $0.kind == .rename })
    #expect(try OutboxPayload.decode(renameJob.payload).title == "Train notes")
  }
}
