import Foundation
import RectoHistory
import GRDB
import Testing
@testable import RectoStore

@Suite("durable Overflow")
struct OverflowTests {
  private func seed(_ store: RectoStore) async throws {
    try await store.save(DocumentRecord(localId: "doc", title: "Draft", markdown: "prose", wordCount: 1, localHeadNodeId: "root", syncState: .synced, updatedAt: 0, createdAt: 0))
  }

  @Test("v8 upgrade preserves prose and its ordered outbox")
  func migration() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("mirror.sqlite")
    do {
      let old = try RectoStore.openAtSchemaVersion(url: url, target: Migrations.v8)
      try await old.write { db in
        try DocumentRecord(localId: "doc", title: "Draft", markdown: "prose", wordCount: 1, localHeadNodeId: "root", syncState: .pending, updatedAt: 0, createdAt: 0).insert(db)
        var job = OutboxJob(documentLocalId: "doc", kind: .commitEdit, clientMutationId: "preserved", payload: "{}", createdAt: 0)
        try job.insert(db)
      }
    }
    let current = try RectoStore(url: url)
    #expect(try await current.document(localId: "doc")?.markdown == "prose")
    #expect(try await current.pendingJobs().first?.clientMutationId == "preserved")
    #expect(try current.overflow(localId: "doc").markdown == "")
  }

  @Test("account purge cascades note buffers and immutable requests")
  func purge() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "private", expectedGeneration: 0)
    _ = try await store.prepareOverflowMutation(localId: "doc")
    try await store.purgeEverything()
    #expect(try await store.unsyncedWorkCount() == 0)
    #expect(try await store.documentsWithUnsyncedOverflow().isEmpty)
  }

  @Test("write survives immediate reopen and full document hydration")
  func reopen() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("mirror.sqlite")
    let store = try RectoStore(url: url)
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "offline notes", expectedGeneration: 0)
    try await seed(store)
    let reopened = try RectoStore(url: url)
    #expect(try reopened.overflow(localId: "doc").markdown == "offline notes")
    #expect(try await reopened.document(localId: "doc")?.localHeadNodeId == "root")
    #expect(try await reopened.pendingJobCount() == 0)
  }

  @Test("lost reply retries exact payload and old acknowledgement retains new typing")
  func retry() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "first", expectedGeneration: 0)
    let first = try #require(try await store.prepareOverflowMutation(localId: "doc"))
    _ = try store.saveOverflow(localId: "doc", markdown: "second", expectedGeneration: 1)
    #expect(try await store.prepareOverflowMutation(localId: "doc") == first)
    try await store.acknowledgeOverflow(localId: "doc", mutation: first, revision: 1)
    #expect(try store.overflow(localId: "doc").markdown == "second")
    #expect(try store.overflow(localId: "doc").isDirty)
    let second = try #require(try await store.prepareOverflowMutation(localId: "doc"))
    #expect(second.markdown == "second")
    #expect(second.expectedRevision == 1)
    #expect(second.id != first.id)
    try await store.acknowledgeOverflow(localId: "doc", mutation: first, revision: 99)
    #expect(try store.overflow(localId: "doc").revision == 1)
  }

  @Test("CAS conflict preserves both copies until explicit resolution")
  func conflict() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "mine", expectedGeneration: 0)
    let mutation = try #require(try await store.prepareOverflowMutation(localId: "doc"))
    try await store.receiveOverflow(localId: "doc", markdown: "theirs", revision: 4, rejectedMutation: mutation.id)
    #expect(try store.overflow(localId: "doc").markdown == "mine")
    #expect(try store.overflow(localId: "doc").remoteMarkdown == "theirs")
    #expect(try await store.prepareOverflowMutation(localId: "doc") == nil)
    _ = try store.resolveOverflow(localId: "doc", keepLocal: true, expectedGeneration: 1)
    let next = try #require(try await store.prepareOverflowMutation(localId: "doc"))
    #expect(next.expectedRevision == 4)
    #expect(next.markdown == "mine")
  }

  @Test("clean remote adoption fences stale pane writes and protects byte identity")
  func remote() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    try await store.receiveOverflow(localId: "doc", markdown: "e\u{301}", revision: 1)
    #expect(throws: OverflowError.self) { _ = try store.saveOverflow(localId: "doc", markdown: "stale", expectedGeneration: 0) }
    #expect(try store.overflow(localId: "doc").markdown.utf8.elementsEqual("e\u{301}".utf8))
    _ = try store.saveOverflow(localId: "doc", markdown: "é", expectedGeneration: 1)
    #expect(try store.overflow(localId: "doc").generation == 2)
  }

  @Test("dirty notes prevent remote deletion and count as retained account work")
  func deletion() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "only copy", expectedGeneration: 0)
    #expect(try await store.unsyncedWorkCount() == 1)
    #expect(try await store.deleteRemotelyRemovedDocument(localId: "doc") == false)
    let mutation = try #require(try await store.prepareOverflowMutation(localId: "doc"))
    try await store.acknowledgeOverflow(localId: "doc", mutation: mutation, revision: 1)
    #expect(try await store.deleteRemotelyRemovedDocument(localId: "doc"))
    #expect(throws: StoreError.self) { _ = try store.overflow(localId: "doc") }
  }

  @Test("pending observations arriving after recheck are reconciled in the acknowledgement transaction")
  func observedAfterRecheck() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "mine", expectedGeneration: 0)
    let mutation = try #require(try await store.prepareOverflowMutation(localId: "doc"))
    try await store.receiveOverflow(localId: "doc", markdown: "newest", revision: 2)
    try await store.acknowledgeOverflow(localId: "doc", mutation: mutation, revision: 1, latestMarkdown: "mine", latestRevision: 1)
    #expect(try store.overflow(localId: "doc").markdown == "newest")
    #expect(try store.overflow(localId: "doc").revision == 2)
    #expect(try store.overflow(localId: "doc").observedMarkdown == nil)
    #expect(try !store.overflow(localId: "doc").isDirty)
  }

  @Test("conflict observations cannot replace a newer durable remote buffer")
  func newestConflict() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "mine", expectedGeneration: 0)
    try await store.receiveOverflow(localId: "doc", markdown: "latest", revision: 5)
    try await store.receiveOverflow(localId: "doc", markdown: "older", revision: 3)
    #expect(try store.overflow(localId: "doc").remoteMarkdown == "latest")
    #expect(try store.overflow(localId: "doc").remoteRevision == 5)
  }

  @Test("auth fence and UTF8 ceiling reject writes without corrupting last saved notes")
  func rejection() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store)
    _ = try store.saveOverflow(localId: "doc", markdown: "saved", expectedGeneration: 0)
    #expect(throws: OverflowError.self) { _ = try store.saveOverflow(localId: "doc", markdown: String(repeating: "é", count: 32_769), expectedGeneration: 1) }
    let fence = store.freezeLocalMutations()
    #expect(throws: StoreError.self) { _ = try store.saveOverflow(localId: "doc", markdown: "blocked", expectedGeneration: 1) }
    store.resumeLocalMutations(frozenAt: fence)
    #expect(try store.overflow(localId: "doc").markdown == "saved")
  }
}
