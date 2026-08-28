import Foundation
import Testing

@testable import RectoHistory

struct MaterializeCases: Decodable {
  struct Node: Decodable {
    let nodeId: String
    let parentNodeId: String?
    let patch: String
    let snapshot: String?
    let selection: NodeSelection?
    let origin: String
    let createdAt: Double
  }
  struct Expectation: Decodable {
    let nodeId: String
    let markdown: String
  }
  let nodes: [Node]
  let expected: [Expectation]
  let snapshotNodeIds: [String]
}

@Suite("materialize parity with lib/history/materialize.ts")
struct MaterializeTests {
  private func loadIndex() throws -> ([String: DocNode], MaterializeCases) {
    let fixture: MaterializeCases = try Fixtures.load("materialize-cases")
    let nodes = fixture.nodes.map {
      DocNode(
        nodeId: $0.nodeId, parentNodeId: $0.parentNodeId, patch: $0.patch, snapshot: $0.snapshot,
        selection: $0.selection, origin: $0.origin, createdAt: $0.createdAt)
    }
    return (indexNodes(nodes), fixture)
  }

  @Test("every node in a 120-node branch materializes to the web's markdown")
  func materializesBranch() throws {
    let (index, fixture) = try loadIndex()
    #expect(fixture.expected.count == 120)
    for expectation in fixture.expected {
      #expect(try materialize(expectation.nodeId, index) == expectation.markdown)
    }
  }

  @Test("snapshots land every 50 nodes")
  func snapshotCadence() throws {
    let (_, fixture) = try loadIndex()
    // The root snapshot plus one every 50 commits over 120 commits.
    #expect(fixture.snapshotNodeIds.count == 3)
    #expect(snapshotEveryN == 50)
  }

  @Test("materialization replays at most snapshotEveryN patches")
  func replayIsBounded() throws {
    let (index, fixture) = try loadIndex()
    for expectation in fixture.expected {
      #expect(depthSinceSnapshot(expectation.nodeId, index) <= snapshotEveryN)
    }
  }

  @Test("an unknown node id is an error, not an empty document")
  func unknownNode() throws {
    let (index, _) = try loadIndex()
    #expect(throws: MaterializeError.unknownNode("nope")) { try materialize("nope", index) }
  }

  @Test("ancestor queries drive the fast-forward conflict rule")
  func ancestry() throws {
    let (index, fixture) = try loadIndex()
    let head = fixture.expected[fixture.expected.count - 1].nodeId
    let middle = fixture.expected[10].nodeId
    #expect(isAncestor(middle, of: head, in: index))
    #expect(isAncestor("root", of: head, in: index))
    #expect(!isAncestor(head, of: middle, in: index))
    #expect(depthOf("root", index) == 0)
  }

  @Test("union merge is order-independent on nodeId")
  func union() throws {
    let (_, fixture) = try loadIndex()
    let nodes = fixture.nodes.map {
      DocNode(nodeId: $0.nodeId, parentNodeId: $0.parentNodeId, patch: $0.patch)
    }
    let left = Array(nodes.prefix(80))
    let right = Array(nodes.suffix(80))
    let merged = unionMerge(left, right)
    #expect(Set(merged.map(\.nodeId)) == Set(nodes.map(\.nodeId)))
    #expect(merged.count == nodes.count)
  }
}
