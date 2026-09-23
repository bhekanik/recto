import Foundation
import RectoHistory
import RectoStore

/// Convex function names, in `module:function` form.
public enum ConvexFunction {
  public static let documentsList = "documents:list"
  public static let documentsGet = "documents:get"
  public static let documentsCreate = "documents:create"
  public static let documentsCommitEdit = "documents:commitEdit"
  public static let documentsUpdateCurrentNodeId = "documents:updateCurrentNodeId"
  public static let documentsUpdateMarkdown = "documents:updateMarkdown"
  public static let documentsRename = "documents:rename"
  public static let documentsRemove = "documents:remove"
  public static let docNodesListSince = "docNodes:listSince"
  public static let docNodesAppend = "docNodes:append"
  public static let writingStatsRecord = "writingStats:record"
  public static let writingStatsList = "writingStats:list"

  // Features beyond sync, called through `RectoAPI`.
  public static let exportDocx = "export:docx"
  public static let versionsList = "versions:list"
  public static let versionsCreate = "versions:create"
  public static let versionsRemove = "versions:remove"
  public static let versionsRename = "versions:rename"

  /// Every name above, for the contract test that finds each in `convex/`.
  public static let all: [String] = [
    documentsList, documentsGet, documentsCreate, documentsCommitEdit,
    documentsUpdateCurrentNodeId, documentsUpdateMarkdown, documentsRename,
    documentsRemove, docNodesListSince, docNodesAppend, writingStatsRecord,
    writingStatsList, exportDocx, versionsList, versionsCreate, versionsRemove, versionsRename,
  ]
}

/// A deterministic refusal from the server (`convex/documents.ts`, `refuse()`).
///
/// Convex throws these as a `ConvexError` whose data is `{code, message}`, which
/// is what separates "retrying this exact call can never succeed" from a
/// transient rejection such as an exhausted OCC retry — Convex surfaces those as
/// plain errors and they ARE safe to retry. Matching on message substrings
/// cannot tell the two apart, and guessing wrong either parks work that would
/// have gone through or retries a refusal forever.
public struct ServerRefusal: Error, Equatable, Sendable {
  public enum Code: String, Sendable, CaseIterable {
    case invalidArgument = "invalid_argument"
    case unauthenticated
    case notFound = "not_found"
    case unknownNode = "unknown_node"
    case tooLarge = "too_large"
    case parentMismatch = "parent_mismatch"
  }

  public var code: Code
  public var message: String

  public init(code: Code, message: String) {
    self.code = code
    self.message = message
  }

  /// Retrying the identical call can never succeed, so the job is parked rather
  /// than retried forever.
  ///
  /// `unauthenticated` is deliberately NOT terminal: a Clerk `convex` token
  /// lives 60 seconds and can expire between two jobs of a long drain, so it
  /// goes down the re-authenticate-and-retry path instead (`TERMINAL_REFUSAL_CODES`
  /// on the server says the same).
  public var isTerminal: Bool { code != .unauthenticated }

  /// Parse the `data` a `ConvexError` carries. Returns nil for anything that is
  /// not one of our refusals, so an unrecognised failure keeps its retry.
  public init?(convexErrorData data: String) {
    guard let parsed = try? JSONSerialization.jsonObject(with: Data(data.utf8)),
      let object = parsed as? [String: Any],
      let raw = object["code"] as? String,
      let code = Code(rawValue: raw)
    else { return nil }
    self.code = code
    self.message = (object["message"] as? String) ?? raw
  }
}

/// A row from `documents.list` (metadata only — the body arrives with the nodes).
public struct RemoteDocumentSummary: Decodable, Sendable, Equatable {
  public let id: String
  public let title: String
  public let titleMode: TitleMode
  public let wordCount: Double
  public let updatedAt: Double
  public let documentUuid: String?

  private enum CodingKeys: String, CodingKey {
    case id = "_id"
    case title, titleMode, wordCount, updatedAt, documentUuid
  }

  public init(
    id: String,
    title: String,
    titleMode: TitleMode = .manual,
    wordCount: Double,
    updatedAt: Double,
    documentUuid: String? = nil
  ) {
    self.id = id
    self.title = title
    self.titleMode = titleMode
    self.wordCount = wordCount
    self.updatedAt = updatedAt
    self.documentUuid = documentUuid
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    title = try container.decode(String.self, forKey: .title)
    titleMode = try container.decodeIfPresent(TitleMode.self, forKey: .titleMode) ?? .manual
    wordCount = try container.decode(Double.self, forKey: .wordCount)
    updatedAt = try container.decode(Double.self, forKey: .updatedAt)
    documentUuid = try container.decodeIfPresent(String.self, forKey: .documentUuid)
  }
}

/// `documents.get`.
public struct RemoteDocument: Decodable, Sendable, Equatable {
  public let id: String
  public let title: String
  public let titleMode: TitleMode
  public let markdown: String
  public let wordCount: Double
  public let currentNodeId: String
  /// The node the server says `markdown` belongs to.
  ///
  /// `nil` means the provenance is unknown — a legacy `updateMarkdown` that
  /// passed no `expectedHeadNodeId` CLEARS the stamp — and unknown provenance
  /// must be treated as untrusted, never as "this is the head's text".
  public let markdownHeadNodeId: String?
  /// Monotonic counter bumped by every pointer write. Rows predating it read as
  /// 0. Unlike `updatedAt` it does not depend on either device's clock, so it is
  /// what decides which of two pointer writes is newer.
  public let pointerRevision: Double
  public let createdAt: Double
  public let updatedAt: Double

  private enum CodingKeys: String, CodingKey {
    case id = "_id"
    case title, titleMode, markdown, wordCount, currentNodeId, markdownHeadNodeId, pointerRevision
    case createdAt, updatedAt
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    title = try container.decode(String.self, forKey: .title)
    titleMode = try container.decodeIfPresent(TitleMode.self, forKey: .titleMode) ?? .manual
    markdown = try container.decode(String.self, forKey: .markdown)
    wordCount = try container.decode(Double.self, forKey: .wordCount)
    currentNodeId = try container.decode(String.self, forKey: .currentNodeId)
    markdownHeadNodeId = try container.decodeIfPresent(String.self, forKey: .markdownHeadNodeId)
    // Optional on the wire: a deployment that predates PR #1 does not send it.
    pointerRevision = try container.decodeIfPresent(Double.self, forKey: .pointerRevision) ?? 0
    createdAt = try container.decode(Double.self, forKey: .createdAt)
    updatedAt = try container.decode(Double.self, forKey: .updatedAt)
  }

  public init(
    id: String, title: String, titleMode: TitleMode = .manual, markdown: String,
    wordCount: Double, currentNodeId: String,
    markdownHeadNodeId: String? = nil, pointerRevision: Double = 0, createdAt: Double,
    updatedAt: Double
  ) {
    self.id = id
    self.title = title
    self.titleMode = titleMode
    self.markdown = markdown
    self.wordCount = wordCount
    self.currentNodeId = currentNodeId
    self.markdownHeadNodeId = markdownHeadNodeId
    self.pointerRevision = pointerRevision
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

/// A row from `docNodes.listSince`.
public struct RemoteNode: Decodable, Sendable, Equatable {
  public struct Selection: Decodable, Sendable, Equatable {
    public let anchor: Double
    public let head: Double

    public init(anchor: Double, head: Double) {
      self.anchor = anchor
      self.head = head
    }
  }

  public let nodeId: String
  public let parentNodeId: String?
  public let patch: String
  public let snapshot: String?
  public let selection: Selection?
  public let origin: String
  public let createdAt: Double

  public init(
    nodeId: String, parentNodeId: String?, patch: String, snapshot: String?,
    selection: Selection?, origin: String, createdAt: Double
  ) {
    self.nodeId = nodeId
    self.parentNodeId = parentNodeId
    self.patch = patch
    self.snapshot = snapshot
    self.selection = selection
    self.origin = origin
    self.createdAt = createdAt
  }

  public func record(documentLocalId: String) -> DocNodeRecord {
    DocNodeRecord(
      documentLocalId: documentLocalId,
      nodeId: nodeId,
      parentNodeId: parentNodeId,
      patch: patch,
      snapshot: snapshot,
      selection: selection.map { NodeSelection(anchor: Int($0.anchor), head: Int($0.head)) },
      origin: origin,
      createdAt: createdAt,
      synced: true)
  }
}

/// `documents.commitEdit` returns one of two shapes; Convex has no discriminated
/// union on the wire, so both are optional and `committed` selects between them.
public struct CommitEditResponse: Decodable, Sendable, Equatable {
  public let committed: Bool
  public let headNodeId: String?
  public let updatedAt: Double?
  public let pointerRevision: Double?
  public let diverged: Bool?
  public let remoteHeadNodeId: String?
  public let remotePointerRevision: Double?

  public init(
    committed: Bool, headNodeId: String?, updatedAt: Double?, pointerRevision: Double? = nil,
    diverged: Bool? = nil, remoteHeadNodeId: String? = nil, remotePointerRevision: Double? = nil
  ) {
    self.committed = committed
    self.headNodeId = headNodeId
    self.updatedAt = updatedAt
    self.pointerRevision = pointerRevision
    self.diverged = diverged
    self.remoteHeadNodeId = remoteHeadNodeId
    self.remotePointerRevision = remotePointerRevision
  }

  public var outcome: CommitOutcome {
    if committed, let headNodeId {
      return .committed(
        headNodeId: headNodeId, updatedAt: updatedAt ?? 0, pointerRevision: pointerRevision)
    }
    return .diverged(
      remoteHeadNodeId: remoteHeadNodeId ?? "", remotePointerRevision: remotePointerRevision)
  }
}

public enum CommitOutcome: Sendable, Equatable {
  case committed(headNodeId: String, updatedAt: Double, pointerRevision: Double?)
  case diverged(remoteHeadNodeId: String, remotePointerRevision: Double?)
}

public struct CreateDocumentResponse: Decodable, Sendable, Equatable {
  public let documentId: String
  public let rootNodeId: String

  public init(documentId: String, rootNodeId: String) {
    self.documentId = documentId
    self.rootNodeId = rootNodeId
  }
}

public struct UpdateCurrentNodeResponse: Decodable, Sendable, Equatable {
  /// False when the server's `updatedAt` was newer: the move lost the LWW check
  /// and `currentNodeId` is the head that won, not the one we asked for.
  public let applied: Bool
  public let currentNodeId: String
  public let updatedAt: Double?
  public let pointerRevision: Double?

  public init(
    applied: Bool, currentNodeId: String, updatedAt: Double?, pointerRevision: Double? = nil
  ) {
    self.applied = applied
    self.currentNodeId = currentNodeId
    self.updatedAt = updatedAt
    self.pointerRevision = pointerRevision
  }
}

public struct UpdateMarkdownResponse: Decodable, Sendable, Equatable {
  public let updatedAt: Double
  public let stale: Bool
  /// The head moved elsewhere: this draft belongs to a branch that is no longer
  /// current, and writing it would detach `documents.markdown` from
  /// `currentNodeId`. Not retryable — reconcile instead.
  public let headMoved: Bool

  private enum CodingKeys: String, CodingKey {
    case updatedAt, stale, headMoved
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    updatedAt = try container.decode(Double.self, forKey: .updatedAt)
    stale = try container.decode(Bool.self, forKey: .stale)
    headMoved = try container.decodeIfPresent(Bool.self, forKey: .headMoved) ?? false
  }

  public init(updatedAt: Double, stale: Bool, headMoved: Bool = false) {
    self.updatedAt = updatedAt
    self.stale = stale
    self.headMoved = headMoved
  }
}

public struct RemoteWritingStat: Decodable, Sendable, Equatable {
  public let date: String
  public let words: Double

  public init(date: String, words: Double) {
    self.date = date
    self.words = words
  }
}

/// A row of `versions.list`: a named point in a document's history.
public struct RemoteVersion: Decodable, Sendable, Equatable, Identifiable {
  public enum Kind: String, Decodable, Sendable {
    case auto
    case manual
  }

  public let id: String
  public let nodeId: String
  public let label: String
  public let kind: Kind
  public let createdAt: Double

  public init(id: String, nodeId: String, label: String, kind: Kind, createdAt: Double) {
    self.id = id
    self.nodeId = nodeId
    self.label = label
    self.kind = kind
    self.createdAt = createdAt
  }

  private enum CodingKeys: String, CodingKey {
    case id = "_id"
    case nodeId, label, kind, createdAt
  }
}
