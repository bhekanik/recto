import Foundation

public struct NodeSelection: Equatable, Hashable, Sendable, Codable {
  public var anchor: Int
  public var head: Int

  public init(anchor: Int, head: Int) {
    self.anchor = anchor
    self.head = head
  }
}

/// A materializable undo-tree node (mirrors the `docNodes` row shape).
public struct DocNode: Equatable, Sendable {
  public var nodeId: String
  public var parentNodeId: String?
  public var patch: String
  public var snapshot: String?
  public var selection: NodeSelection?
  public var origin: String
  public var createdAt: Double

  public init(
    nodeId: String,
    parentNodeId: String?,
    patch: String,
    snapshot: String? = nil,
    selection: NodeSelection? = nil,
    origin: String = "",
    createdAt: Double = 0
  ) {
    self.nodeId = nodeId
    self.parentNodeId = parentNodeId
    self.patch = patch
    self.snapshot = snapshot
    self.selection = selection
    self.origin = origin
    self.createdAt = createdAt
  }
}

public enum MaterializeError: Error, Equatable, Sendable {
  case unknownNode(String)
  case emptyChain
}

/// Reconstruct the canonical Markdown at a node: walk up to the nearest ancestor
/// carrying a `snapshot` (the root always has one, so this terminates), then
/// replay each patch forward down to the target (blueprint 03 §4.3, 07 §5.1).
public func materialize(_ targetNodeId: String, _ nodesById: [String: DocNode]) throws -> String {
  guard var current = nodesById[targetNodeId] else {
    throw MaterializeError.unknownNode(targetNodeId)
  }

  var chain: [DocNode] = []
  while true {
    chain.append(current)
    if current.snapshot != nil { break }
    guard let parentId = current.parentNodeId, let parent = nodesById[parentId] else { break }
    current = parent
  }
  chain.reverse()

  guard let base = chain.first else { throw MaterializeError.emptyChain }
  var markdown = JSString(base.snapshot ?? "")
  for node in chain.dropFirst() {
    markdown = applyPatch(markdown, try TextPatch.decode(node.patch))
  }
  guard let string = markdown.string else { throw PatchDecodingError.illFormedResult }
  return string
}

/// Number of nodes since the last snapshot on this branch, so the snapshot
/// cadence survives a relaunch (the grouping controller resumes from it).
public func depthSinceSnapshot(_ nodeId: String, _ nodesById: [String: DocNode]) -> Int {
  var depth = 0
  var current = nodesById[nodeId]
  while let node = current {
    if node.snapshot != nil { return depth }
    depth += 1
    guard let parentId = node.parentNodeId else { return depth }
    current = nodesById[parentId]
  }
  return depth
}

/// The set of nodeIds on the path from root to the given node (the live spine).
public func ancestorChain(_ nodeId: String, _ nodesById: [String: DocNode]) -> Set<String> {
  var chain: Set<String> = []
  var current = nodesById[nodeId]
  while let node = current {
    chain.insert(node.nodeId)
    guard let parentId = node.parentNodeId else { break }
    current = nodesById[parentId]
  }
  return chain
}

/// Is `candidate` an ancestor of (or equal to) `nodeId`? Drives the
/// fast-forward branch of the conflict rules (plan 023 §4.4).
public func isAncestor(_ candidate: String, of nodeId: String, in nodesById: [String: DocNode])
  -> Bool
{
  ancestorChain(nodeId, nodesById).contains(candidate)
}

/// Distance of a node from the root, for indentation in the tree view.
public func depthOf(_ nodeId: String, _ nodesById: [String: DocNode]) -> Int {
  var depth = 0
  var current = nodesById[nodeId]
  while let parentId = current?.parentNodeId {
    depth += 1
    current = nodesById[parentId]
  }
  return depth
}

/// Union-merge two append-only node sets by nodeId. Nodes are immutable and
/// ULID-keyed, so this is a conflict-free set union (blueprint 07 §7, ADR-10).
public func unionMerge(_ a: [DocNode], _ b: [DocNode]) -> [DocNode] {
  var seen: [String: DocNode] = [:]
  var order: [String] = []
  for node in a + b {
    if seen.updateValue(node, forKey: node.nodeId) == nil { order.append(node.nodeId) }
  }
  return order.compactMap { seen[$0] }
}

public func indexNodes(_ nodes: [DocNode]) -> [String: DocNode] {
  Dictionary(nodes.map { ($0.nodeId, $0) }, uniquingKeysWith: { _, latest in latest })
}
