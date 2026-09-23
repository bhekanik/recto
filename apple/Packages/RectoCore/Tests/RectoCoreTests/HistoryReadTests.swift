import Foundation
import RectoHistory
import RectoStore
import RectoSync
import RectoSyncTesting
import Testing

@testable import RectoCore

/// What the history panel reads: every node, oldest first, and the text at any
/// of them.
@Suite("DocumentSession history reads")
struct HistoryReadTests {
  @Test("nodes come oldest first and any node materializes to its text")
  func nodesAndText() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()
    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "test",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "one", selection: nil, structural: true)
    try await session.applyLocalChange(markdown: "one two", selection: nil, structural: true)

    let nodes = await session.historyNodes()
    #expect(nodes.count == 3)
    #expect(nodes.map(\.createdAt) == nodes.map(\.createdAt).sorted())
    #expect(nodes.first?.parentNodeId == nil)
    #expect(try await session.markdown(at: nodes[1].nodeId) == "one")
    #expect(try await session.markdown(at: nodes[2].nodeId) == "one two")
    await #expect(throws: MaterializeError.self) { try await session.markdown(at: "nope") }
  }

  @Test("an origin override names the change's own node; the draft it closes keeps the device's")
  func originOverride() async throws {
    let directory = Harness.makeDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let harness = try Harness(directory: directory, transport: InMemoryTransport())
    let localId = try await harness.createLocalDocument()
    let session = DocumentSession(
      documentLocalId: localId, store: harness.store, sync: nil, origin: "device",
      schedulesTimers: false)
    try await session.open()
    try await session.applyLocalChange(markdown: "typed", selection: nil)
    try await session.applyLocalChange(markdown: "rewritten", selection: nil, structural: true, origin: "ai:Tighten")

    let nodes = await session.historyNodes()
    #expect(nodes.last?.origin == "ai:Tighten")
    #expect(nodes.contains { $0.origin == "device" }, "the typing before it is the device's")
    #expect(try await session.markdown(at: nodes.last!.nodeId) == "rewritten")
  }
}
