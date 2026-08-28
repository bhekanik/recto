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

  /// Decoding THROWS. It used to return an all-empty payload, which turned a
  /// corrupt row into a valid destructive mutation: a commit with an empty
  /// `nodeId` and `patch` passes the server's `v.string()` validators, inserts
  /// that node, and can move `currentNodeId` to `""`.
  public static func decode(_ raw: String) throws -> OutboxPayload {
    do {
      return try JSONDecoder().decode(OutboxPayload.self, from: Data(raw.utf8))
    } catch {
      throw OutboxPayloadError.undecodable(underlying: String(describing: error))
    }
  }

  /// Fields this kind of job cannot be sent without. Guessing a default here is
  /// what makes a malformed row indistinguishable from real work.
  ///
  /// `baseHeadNodeId` lives on the job rather than the payload, but it is just as
  /// load-bearing: a commit whose expected head we fell back to the CURRENT head
  /// for is a commit onto a parent the user never chose.
  public func validate(for kind: OutboxKind, baseHeadNodeId: String? = nil) throws {
    func require(_ condition: Bool, _ field: String) throws {
      guard condition else { throw OutboxPayloadError.missingField(kind: kind, field: field) }
    }
    switch kind {
    case .commitEdit:
      try require(!(nodeId ?? "").isEmpty, "nodeId")
      try require(!(patch ?? "").isEmpty, "patch")
      try require(markdown != nil, "markdown")
      try require(wordCount != nil, "wordCount")
      try require(!(baseHeadNodeId ?? "").isEmpty, "baseHeadNodeId")
    case .appendNode:
      try require(!(nodeId ?? "").isEmpty, "nodeId")
      try require(!(patch ?? "").isEmpty, "patch")
      try require(markdown != nil, "markdown")
      try require(wordCount != nil, "wordCount")
    case .pointerMove:
      try require(!(nodeId ?? "").isEmpty, "nodeId")
      try require(markdown != nil, "markdown")
      try require(wordCount != nil, "wordCount")
      try require(createdAt != nil, "createdAt")
    case .draftSave:
      try require(markdown != nil, "markdown")
      try require(wordCount != nil, "wordCount")
    case .createDocument, .rename:
      try require(title != nil, "title")
    case .writingStats:
      try require(!(date ?? "").isEmpty, "date")
      try require(words != nil, "words")
    case .remove:
      break
    }
  }
}

/// Why a queued row cannot be sent.
public enum OutboxPayloadError: Error, Equatable, Sendable, LocalizedError {
  case undecodable(underlying: String)
  case missingField(kind: OutboxKind, field: String)

  public var errorDescription: String? {
    switch self {
    case .undecodable(let underlying): "Queued work could not be decoded: \(underlying)"
    case .missingField(let kind, let field):
      "Queued \(kind.rawValue) work is missing \(field)"
    }
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
