import Foundation
import RectoStore
import Testing
@testable import RectoSync

private actor OverflowAPI: RectoAPI {
  var calls: [[String: ConvexValue]] = []
  var queryCount = 0
  var failNextQuery = false
  var advanceOnQuery: (String, String, Int)?
  func failQuery() { failNextQuery = true }
  func advanceDuringQuery(id: String, markdown: String, revision: Int) { advanceOnQuery = (id, markdown, revision) }
  var receivers: [String: @Sendable (Data) -> Void] = [:]
  var bodies: [String: String] = [:]
  var revisions: [String: Int] = [:]
  var receipt: [String: String] = [:]
  var loseNextReply = false
  var holdNext = false
  var held: CheckedContinuation<Void, Never>?
  func holdReply() { holdNext = true }
  func releaseReply() { held?.resume(); held = nil }
  func loseReply() { loseNextReply = true }
  func setRemote(_ id: String, markdown: String, revision: Int) throws {
    bodies[id] = markdown
    revisions[id] = revision
    receipt[id] = nil
    receivers[id]?(try JSONSerialization.data(withJSONObject: ["markdown": markdown, "revision": revision]))
  }
  func decode<T: Decodable>(_ object: [String: Any]) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
  }
  func query<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
    queryCount += 1
    if failNextQuery { failNextQuery = false; throw RemoteCallError(code: nil, message: "Lost recheck") }
    if let (id, markdown, revision) = advanceOnQuery {
      advanceOnQuery = nil
      try setRemote(id, markdown: markdown, revision: revision)
    }
    guard name == "overflow:get", case .string(let id) = args["documentId"] else { throw RemoteCallError(code: nil, message: "Invalid query") }
    return try decode(["markdown": bodies[id] ?? "", "revision": revisions[id] ?? 0])
  }
  func subscribe<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) -> AsyncThrowingStream<T, any Error> {
    guard case .string(let id) = args["documentId"] else { return AsyncThrowingStream { $0.finish() } }
    return AsyncThrowingStream { continuation in
      receivers[id] = { data in
        do { continuation.yield(try JSONDecoder().decode(T.self, from: data)) }
        catch { continuation.finish(throwing: error) }
      }
    }
  }
  func action<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
    throw RemoteCallError(code: nil, message: "Unexpected action")
  }
  func mutation<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
    calls.append(args)
    guard name == "overflow:save", case .string(let id) = args["documentId"],
      case .string(let body) = args["markdown"], case .number(let expected) = args["expectedRevision"],
      case .string(let mutation) = args["clientMutationId"] else { throw RemoteCallError(code: nil, message: "Invalid call") }
    let revision = revisions[id] ?? 0
    if receipt[id] == mutation { return try decode(["saved": true, "revision": revision]) }
    guard Int(expected) == revision else { return try decode(["saved": false, "revision": revision, "markdown": bodies[id] ?? ""]) }
    bodies[id] = body
    revisions[id] = revision + 1
    receipt[id] = mutation
    receivers[id]?(try JSONSerialization.data(withJSONObject: ["markdown": body, "revision": revision + 1]))
    if holdNext {
      holdNext = false
      await withCheckedContinuation { held = $0 }
    }
    if loseNextReply {
      loseNextReply = false
      throw RemoteCallError(code: nil, message: "Lost response")
    }
    return try decode(["saved": true, "revision": revision + 1])
  }
}

@Suite("Overflow background sync")
struct OverflowSyncTests {
  private func seed(_ store: RectoStore, id: String, convexId: String?) async throws {
    try await store.save(DocumentRecord(localId: id, convexId: convexId, title: "Draft", markdown: "prose", wordCount: 1, localHeadNodeId: "root", syncState: .synced, updatedAt: 0, createdAt: 0))
  }

  @Test("empty and clean large libraries produce no network calls")
  func noPolling() async throws {
    let store = try RectoStore.inMemory()
    let api = OverflowAPI()
    let sync = OverflowSync(store: store, api: api)
    await sync.syncOnce()
    for number in 0..<100 { try await seed(store, id: "\(number)", convexId: "server-\(number)") }
    await sync.syncOnce()
    #expect(await api.calls.isEmpty)
    #expect(await api.queryCount == 0)
  }

  @Test("offline creation waits for server ID then syncs durable notes")
  func offlineCreate() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store, id: "doc", convexId: nil)
    _ = try store.saveOverflow(localId: "doc", markdown: "offline", expectedGeneration: 0)
    let api = OverflowAPI()
    let sync = OverflowSync(store: store, api: api)
    await sync.syncOnce()
    #expect(await api.calls.isEmpty)
    try await seed(store, id: "doc", convexId: "server")
    await sync.syncOnce()
    #expect(await api.bodies["server"] == "offline")
    #expect(try !store.overflow(localId: "doc").isDirty)
    #expect(try await store.document(localId: "doc")?.markdown == "prose")
    #expect(try await store.pendingJobCount() == 0)
  }

  @Test("restarting after a lost response retries immutable request before newer notes")
  func restartRetry() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store, id: "doc", convexId: "server")
    _ = try store.saveOverflow(localId: "doc", markdown: "first", expectedGeneration: 0)
    let api = OverflowAPI()
    await api.loseReply()
    await OverflowSync(store: store, api: api).syncOnce()
    _ = try store.saveOverflow(localId: "doc", markdown: "second", expectedGeneration: 1)
    let restarted = OverflowSync(store: store, api: api)
    await restarted.syncOnce()
    let calls = await api.calls
    #expect(calls.count == 2)
    #expect(calls[0] == calls[1])
    #expect(try store.overflow(localId: "doc").markdown == "second")
    #expect(try store.overflow(localId: "doc").isDirty)
    await restarted.syncOnce()
    #expect(await api.bodies["server"] == "second")
    #expect(try !store.overflow(localId: "doc").isDirty)
  }

  @Test("stop waits for in-flight calls and their late acknowledgement cannot clear notes")
  func stopWaits() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store, id: "doc", convexId: "server")
    _ = try store.saveOverflow(localId: "doc", markdown: "saved locally", expectedGeneration: 0)
    let api = OverflowAPI()
    await api.holdReply()
    let sync = OverflowSync(store: store, api: api)
    await sync.start()
    let deadline = ContinuousClock.now + .seconds(2)
    while await api.calls.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
    #expect(await api.calls.count == 1)
    let stopping = Task { await sync.stop() }
    await Task.yield()
    await api.releaseReply()
    await stopping.value
    #expect(try store.overflow(localId: "doc").isDirty)
    #expect(try store.overflow(localId: "doc").pending != nil)
    await sync.syncOnce()
    #expect(try !store.overflow(localId: "doc").isDirty)
  }

  @Test("subscription advancing before a blocked reply is reconciled after acknowledgement")
  func subscriptionBeforeReply() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store, id: "doc", convexId: "server")
    _ = try store.saveOverflow(localId: "doc", markdown: "mine", expectedGeneration: 0)
    let api = OverflowAPI()
    await api.holdReply()
    let sync = OverflowSync(store: store, api: api)
    await sync.openDocument(localId: "doc")
    await sync.start()
    let deadline = ContinuousClock.now + .seconds(2)
    while await api.held == nil, ContinuousClock.now < deadline { await Task.yield() }
    try await api.setRemote("server", markdown: "newer device", revision: 2)
    await Task.yield()
    await api.releaseReply()
    while try store.overflow(localId: "doc").revision != 2, ContinuousClock.now < deadline { await Task.yield() }
    await sync.stop()
    #expect(try store.overflow(localId: "doc").markdown == "newer device")
    #expect(try store.overflow(localId: "doc").revision == 2)
    #expect(try store.overflow(localId: "doc").remoteMarkdown == nil)
  }

  @Test("own pending subscription plus newer local typing does not create a conflict")
  func ownPendingObservation() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store, id: "doc", convexId: "server")
    _ = try store.saveOverflow(localId: "doc", markdown: "first", expectedGeneration: 0)
    let api = OverflowAPI()
    await api.holdReply()
    let sync = OverflowSync(store: store, api: api)
    let saving = Task { await sync.syncOnce() }
    let deadline = ContinuousClock.now + .seconds(2)
    while await api.held == nil, ContinuousClock.now < deadline { await Task.yield() }
    _ = try store.saveOverflow(localId: "doc", markdown: "second", expectedGeneration: 1)
    try await store.receiveOverflow(localId: "doc", markdown: "first", revision: 1)
    await api.releaseReply()
    await saving.value
    #expect(try store.overflow(localId: "doc").markdown == "second")
    #expect(try store.overflow(localId: "doc").isDirty)
    #expect(try store.overflow(localId: "doc").remoteMarkdown == nil)
  }

  @Test("a failed recheck keeps the request pending and retry reconciles the latest remote copy")
  func recheckRetry() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store, id: "doc", convexId: "server")
    _ = try store.saveOverflow(localId: "doc", markdown: "mine", expectedGeneration: 0)
    let api = OverflowAPI()
    await api.failQuery()
    let sync = OverflowSync(store: store, api: api)
    await sync.syncOnce()
    let pending = try store.overflow(localId: "doc").pending
    #expect(pending != nil)
    #expect(try store.overflow(localId: "doc").revision == 0)
    await api.advanceDuringQuery(id: "server", markdown: "newer remote", revision: 2)
    await sync.syncOnce()
    let calls = await api.calls
    #expect(calls.count == 2)
    #expect(calls[0] == calls[1])
    #expect(try store.overflow(localId: "doc").markdown == "newer remote")
    #expect(try store.overflow(localId: "doc").revision == 2)
    #expect(try store.overflow(localId: "doc").pending == nil)
    #expect(try !store.overflow(localId: "doc").isDirty)
  }

  @Test("a conflict parks its notes while another document still syncs")
  func conflict() async throws {
    let store = try RectoStore.inMemory()
    try await seed(store, id: "one", convexId: "server-one")
    try await seed(store, id: "two", convexId: "server-two")
    _ = try store.saveOverflow(localId: "one", markdown: "mine", expectedGeneration: 0)
    _ = try store.saveOverflow(localId: "two", markdown: "other draft", expectedGeneration: 0)
    let api = OverflowAPI()
    try await api.setRemote("server-one", markdown: "theirs", revision: 3)
    let sync = OverflowSync(store: store, api: api)
    await sync.syncOnce()
    #expect(try store.overflow(localId: "one").remoteMarkdown == "theirs")
    #expect(try store.overflow(localId: "one").markdown == "mine")
    #expect(await api.bodies["server-two"] == "other draft")
    let count = await api.calls.count
    await sync.syncOnce()
    #expect(await api.calls.count == count)
  }
}
