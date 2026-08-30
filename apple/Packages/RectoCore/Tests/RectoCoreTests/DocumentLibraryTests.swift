import Foundation
import RectoStore
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
    #expect(created.syncState == .pending)
    #expect(try await library.documents() == [created])
    #expect(try await store.nodes(documentLocalId: created.localId).count == 1)
    let jobs = try await store.pendingJobs(documentLocalId: created.localId)
    #expect(jobs.count == 1)
    #expect(jobs.first?.kind == .createDocument)
    #expect(jobs.first?.clientMutationId == "01KCREATE0000000000000000")
  }
}
