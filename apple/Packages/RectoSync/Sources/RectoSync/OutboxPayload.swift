import Foundation
import RectoHistory
import RectoStore

/// The JSON body of an outbox row.
///
/// One flat struct rather than an enum with associated values: the payload has
/// to survive a schema change written by an older build of the app, and a flat
/// shape with optionals degrades to "field missing" instead of "cannot decode
/// this row at all", which would strand offline work.
public struct OutboxPayload: Codable, Sendable, Equatable {
  public var title: String?
  public var nodeId: String?
  public var parentNodeId: String?
  public var patch: String?
  public var snapshot: String?
  public var selectionAnchor: Int?
  public var selectionHead: Int?
  public var origin: String?
  public var createdAt: Double?
  public var markdown: String?
  public var wordCount: Int?
  public var date: String?
  public var words: Int?

  public init(
    title: String? = nil, nodeId: String? = nil, parentNodeId: String? = nil,
    patch: String? = nil, snapshot: String? = nil, selection: NodeSelection? = nil,
    origin: String? = nil, createdAt: Double? = nil, markdown: String? = nil,
    wordCount: Int? = nil, date: String? = nil, words: Int? = nil
  ) {
    self.title = title
    self.nodeId = nodeId
    self.parentNodeId = parentNodeId
    self.patch = patch
    self.snapshot = snapshot
    self.selectionAnchor = selection?.anchor
    self.selectionHead = selection?.head
    self.origin = origin
    self.createdAt = createdAt
    self.markdown = markdown
    self.wordCount = wordCount
    self.date = date
    self.words = words
  }

  public var selection: NodeSelection? {
    guard let selectionAnchor, let selectionHead else { return nil }
    return NodeSelection(anchor: selectionAnchor, head: selectionHead)
  }

  public var encoded: String {
    let data = (try? JSONEncoder().encode(self)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  public static func decode(_ raw: String) -> OutboxPayload {
    (try? JSONDecoder().decode(OutboxPayload.self, from: Data(raw.utf8))) ?? OutboxPayload()
  }
}

extension OutboxPayload {
  /// The payload for a node the grouping controller just produced.
  public static func commit(_ commit: GroupCommit, origin: String, createdAt: Double, wordCount: Int)
    -> OutboxPayload
  {
    OutboxPayload(
      nodeId: commit.nodeId, parentNodeId: commit.parentNodeId, patch: commit.patch,
      snapshot: commit.snapshot, selection: commit.selection, origin: origin,
      createdAt: createdAt, markdown: commit.markdown, wordCount: wordCount)
  }
}
