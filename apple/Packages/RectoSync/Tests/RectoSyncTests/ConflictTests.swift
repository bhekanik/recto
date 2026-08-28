import Foundation
import RectoHistory
import Testing

@testable import RectoSync

/// A linear chain root → a → b → c, with a fork d off `a`.
private func sampleDAG() -> [String: DocNode] {
  indexNodes([
    DocNode(nodeId: "root", parentNodeId: nil, patch: "{}", snapshot: "", createdAt: 0),
    DocNode(nodeId: "a", parentNodeId: "root", patch: "{}", createdAt: 1),
    DocNode(nodeId: "b", parentNodeId: "a", patch: "{}", createdAt: 2),
    DocNode(nodeId: "c", parentNodeId: "b", patch: "{}", createdAt: 3),
    DocNode(nodeId: "d", parentNodeId: "a", patch: "{}", createdAt: 4),
  ])
}

@Suite("conflict rules (plan 023 §4.4)")
struct ConflictTests {
  @Test("identical heads need no work")
  func inSync() {
    #expect(
      ConflictResolver.resolve(
        localHead: "c", remoteHead: "c", nodesById: sampleDAG(), hasPendingWork: false) == .inSync)
  }

  @Test("a server behind us gets the missing nodes, oldest first")
  func serverBehind() {
    let resolution = ConflictResolver.resolve(
      localHead: "c", remoteHead: "a", nodesById: sampleDAG(), hasPendingWork: true)
    #expect(resolution == .uploadAncestors(missing: ["b", "c"], rebaseOnto: "a"))
  }

  @Test("a server ahead of us is adopted when idle, deferred when mid-edit")
  func serverAhead() {
    #expect(
      ConflictResolver.resolve(
        localHead: "a", remoteHead: "c", nodesById: sampleDAG(), hasPendingWork: false)
        == .adoptRemote(headNodeId: "c", whenIdle: true))
    #expect(
      ConflictResolver.resolve(
        localHead: "a", remoteHead: "c", nodesById: sampleDAG(), hasPendingWork: true)
        == .adoptRemote(headNodeId: "c", whenIdle: false))
  }

  @Test("two branches off a shared parent are a real divergence")
  func diverged() {
    #expect(
      ConflictResolver.resolve(
        localHead: "c", remoteHead: "d", nodesById: sampleDAG(), hasPendingWork: false)
        == .diverged(local: "c", remote: "d"))
  }

  @Test("an unknown remote head is never guessed at")
  func unknownRemoteHead() {
    // Deciding without the other client's nodes is how a branch gets lost.
    #expect(
      ConflictResolver.resolve(
        localHead: "c", remoteHead: "elsewhere", nodesById: sampleDAG(), hasPendingWork: false)
        == .awaitingNodes(remoteHeadNodeId: "elsewhere"))
  }

  @Test("the compare sheet gets the nearest common ancestor as its base")
  func commonAncestor() {
    #expect(ConflictResolver.commonAncestor("c", "d", in: sampleDAG()) == "a")
    #expect(ConflictResolver.commonAncestor("c", "root", in: sampleDAG()) == "root")
    #expect(ConflictResolver.commonAncestor("c", "c", in: sampleDAG()) == "c")
  }

  @Test("the path between two nodes excludes the ancestor and includes the tip")
  func path() {
    #expect(
      ConflictResolver.pathBetween(ancestor: "root", descendant: "c", in: sampleDAG())
        == ["a", "b", "c"])
    #expect(ConflictResolver.pathBetween(ancestor: "c", descendant: "c", in: sampleDAG()).isEmpty)
  }
}

@Suite("outbox payload")
struct OutboxPayloadTests {
  @Test("round-trips through JSON")
  func roundTrip() {
    let payload = OutboxPayload(
      nodeId: "n1", parentNodeId: "root", patch: #"{"from":0,"to":0,"insert":"hi 😀"}"#,
      snapshot: nil, selection: NodeSelection(anchor: 3, head: 5), origin: "device",
      createdAt: 12, markdown: "hi 😀", wordCount: 2)
    #expect(OutboxPayload.decode(payload.encoded) == payload)
    #expect(OutboxPayload.decode(payload.encoded).selection == NodeSelection(anchor: 3, head: 5))
  }

  @Test("an undecodable payload degrades to empty rather than stranding the row")
  func degrades() {
    // The alternative — refusing to decode — would leave offline work queued
    // behind a row that can never be sent.
    #expect(OutboxPayload.decode("not json") == OutboxPayload())
  }
}

@Suite("commit responses")
struct CommitResponseTests {
  @Test("the two commitEdit shapes map to the right outcome")
  func outcomes() {
    let ok = CommitEditResponse(
      committed: true, headNodeId: "n1", updatedAt: 42, pointerRevision: 7)
    #expect(ok.outcome == .committed(headNodeId: "n1", updatedAt: 42, pointerRevision: 7))

    let conflict = CommitEditResponse(
      committed: false, headNodeId: nil, updatedAt: nil, diverged: true,
      remoteHeadNodeId: "other", remotePointerRevision: 9)
    #expect(conflict.outcome == .diverged(remoteHeadNodeId: "other", remotePointerRevision: 9))
  }

  @Test("commitEdit arguments encode numbers as Convex numbers, not BigInts")
  func numericEncoding() throws {
    let request = CommitEditRequest(
      documentId: "d1", nodeId: "n1", parentNodeId: "root", patch: "{}", snapshot: nil,
      selection: NodeSelection(anchor: 1, head: 2), origin: "device", createdAt: 5,
      markdown: "text", wordCount: 3, expectedHeadNodeId: "root", clientMutationId: "m1")
    let encoded = try request.convexArgs.convexEncode()
    // `Int` would encode as {"$integer":...} and `v.number()` rejects it.
    #expect(!encoded.contains("$integer"))
    #expect(encoded.contains("\"wordCount\":3"))
    // `v.optional()` means absent, not null.
    #expect(!encoded.contains("\"snapshot\""))
  }
}
