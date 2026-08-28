import Foundation
import GRDB
import RectoHistory

/// How far the local document is from the server (plan 023 §4.2, §4.4).
public enum SyncState: String, Codable, Sendable, DatabaseValueConvertible {
  /// Local head equals the last acknowledged remote head; nothing queued.
  case synced
  /// Local work is queued in the outbox and not yet acknowledged.
  case pending
  /// The outbox is draining right now.
  case syncing
  /// The server head is not an ancestor of the local head. Both branches are
  /// kept; the UI offers a compare sheet.
  case diverged
  /// The last drain attempt failed and is waiting on backoff.
  case failed
}

/// The local mirror of a `documents` row plus everything the native client
/// needs that the server has no column for.
public struct DocumentRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "documents"

  /// Client-minted uuid; stable across an offline create (plan 023 §4.1(5)).
  public var localId: String
  /// `Id<"documents">` once the server has seen it.
  public var convexId: String?
  public var title: String
  /// Materialized Markdown at `localHead`.
  public var markdown: String
  /// Text ahead of `localHead` that no node exists for yet: the debounced draft
  /// row, so a crash between keystroke and node boundary loses nothing.
  public var draftMarkdown: String?
  public var draftSelectionAnchor: Int?
  public var draftSelectionHead: Int?
  public var wordCount: Int
  public var localHeadNodeId: String
  /// The server's `currentNodeId` as last observed.
  public var remoteHeadNodeId: String?
  /// The server's `updatedAt` as last observed — the CAS token `updateMarkdown`
  /// compares against.
  public var remoteUpdatedAt: Double?
  public var syncState: SyncState
  /// Set when `syncState == .diverged`: the remote head we refused to adopt.
  public var divergedRemoteHeadNodeId: String?
  public var updatedAt: Double
  public var createdAt: Double
  /// Soft delete; the row is purged once the server acknowledges the removal.
  public var deletedAt: Double?

  public init(
    localId: String,
    convexId: String? = nil,
    title: String,
    markdown: String,
    draftMarkdown: String? = nil,
    draftSelectionAnchor: Int? = nil,
    draftSelectionHead: Int? = nil,
    wordCount: Int,
    localHeadNodeId: String,
    remoteHeadNodeId: String? = nil,
    remoteUpdatedAt: Double? = nil,
    syncState: SyncState = .pending,
    divergedRemoteHeadNodeId: String? = nil,
    updatedAt: Double,
    createdAt: Double,
    deletedAt: Double? = nil
  ) {
    self.localId = localId
    self.convexId = convexId
    self.title = title
    self.markdown = markdown
    self.draftMarkdown = draftMarkdown
    self.draftSelectionAnchor = draftSelectionAnchor
    self.draftSelectionHead = draftSelectionHead
    self.wordCount = wordCount
    self.localHeadNodeId = localHeadNodeId
    self.remoteHeadNodeId = remoteHeadNodeId
    self.remoteUpdatedAt = remoteUpdatedAt
    self.syncState = syncState
    self.divergedRemoteHeadNodeId = divergedRemoteHeadNodeId
    self.updatedAt = updatedAt
    self.createdAt = createdAt
    self.deletedAt = deletedAt
  }

  /// The text the editor should show: the pending draft when there is one,
  /// otherwise the head.
  public var displayMarkdown: String { draftMarkdown ?? markdown }

  public var draftSelection: NodeSelection? {
    guard let anchor = draftSelectionAnchor, let head = draftSelectionHead else { return nil }
    return NodeSelection(anchor: anchor, head: head)
  }
}

/// One immutable undo-tree node, plus the two local-only columns: a cached
/// materialization and whether the server has acknowledged it.
public struct DocNodeRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "doc_nodes"

  public var documentLocalId: String
  public var nodeId: String
  public var parentNodeId: String?
  public var patch: String
  public var snapshot: String?
  public var selectionAnchor: Int?
  public var selectionHead: Int?
  public var origin: String
  public var createdAt: Double
  /// Cached materialized Markdown for recently visited nodes (plan 023 §4.2).
  public var materialized: String?
  public var materializedAt: Double?
  /// The server has this node (an outbox commit was acknowledged, or it arrived
  /// from `docNodes.listSince`).
  public var synced: Bool

  public init(
    documentLocalId: String,
    nodeId: String,
    parentNodeId: String?,
    patch: String,
    snapshot: String? = nil,
    selection: NodeSelection? = nil,
    origin: String,
    createdAt: Double,
    materialized: String? = nil,
    materializedAt: Double? = nil,
    synced: Bool = false
  ) {
    self.documentLocalId = documentLocalId
    self.nodeId = nodeId
    self.parentNodeId = parentNodeId
    self.patch = patch
    self.snapshot = snapshot
    self.selectionAnchor = selection?.anchor
    self.selectionHead = selection?.head
    self.origin = origin
    self.createdAt = createdAt
    self.materialized = materialized
    self.materializedAt = materializedAt
    self.synced = synced
  }

  public var selection: NodeSelection? {
    guard let anchor = selectionAnchor, let head = selectionHead else { return nil }
    return NodeSelection(anchor: anchor, head: head)
  }

  public var docNode: DocNode {
    DocNode(
      nodeId: nodeId, parentNodeId: parentNodeId, patch: patch, snapshot: snapshot,
      selection: selection, origin: origin, createdAt: createdAt)
  }
}

public struct VersionRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "versions"

  public var documentLocalId: String
  public var versionId: String
  public var nodeId: String
  public var label: String
  public var kind: String  // "auto" | "manual"
  public var createdAt: Double

  public init(
    documentLocalId: String, versionId: String, nodeId: String, label: String, kind: String,
    createdAt: Double
  ) {
    self.documentLocalId = documentLocalId
    self.versionId = versionId
    self.nodeId = nodeId
    self.label = label
    self.kind = kind
    self.createdAt = createdAt
  }
}

public struct CommentRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "comments"

  public var commentId: String
  public var documentLocalId: String
  public var authorUserId: String
  public var authorName: String
  public var anchorQuote: String
  public var anchorPrefix: String
  public var anchorSuffix: String
  public var anchorOffsetHint: Int
  public var body: String
  public var threadParentId: String?
  public var resolved: Bool
  public var createdAt: Double

  public init(
    commentId: String, documentLocalId: String, authorUserId: String, authorName: String,
    anchorQuote: String, anchorPrefix: String, anchorSuffix: String, anchorOffsetHint: Int,
    body: String, threadParentId: String?, resolved: Bool, createdAt: Double
  ) {
    self.commentId = commentId
    self.documentLocalId = documentLocalId
    self.authorUserId = authorUserId
    self.authorName = authorName
    self.anchorQuote = anchorQuote
    self.anchorPrefix = anchorPrefix
    self.anchorSuffix = anchorSuffix
    self.anchorOffsetHint = anchorOffsetHint
    self.body = body
    self.threadParentId = threadParentId
    self.resolved = resolved
    self.createdAt = createdAt
  }
}

public struct ReviewBranchRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "review_branches"

  public var branchId: String
  public var documentLocalId: String
  public var reviewerUserId: String
  public var baseNodeId: String
  public var headNodeId: String
  public var status: String  // "open" | "accepted" | "rejected"
  public var createdAt: Double
  public var updatedAt: Double

  public init(
    branchId: String, documentLocalId: String, reviewerUserId: String, baseNodeId: String,
    headNodeId: String, status: String, createdAt: Double, updatedAt: Double
  ) {
    self.branchId = branchId
    self.documentLocalId = documentLocalId
    self.reviewerUserId = reviewerUserId
    self.baseNodeId = baseNodeId
    self.headNodeId = headNodeId
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public struct WritingStatRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "writing_stats"

  /// Local calendar date "YYYY-MM-DD".
  public var date: String
  public var words: Int
  public var updatedAt: Double
  /// Not yet pushed to `writingStats.record`.
  public var dirty: Bool

  public init(date: String, words: Int, updatedAt: Double, dirty: Bool = true) {
    self.date = date
    self.words = words
    self.updatedAt = updatedAt
    self.dirty = dirty
  }
}

/// Key/value settings. Local-only until W7 ships the `settings` table and
/// `settings.get/save`, at which point `dirty` rows sync the same way stats do.
public struct SettingRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "settings"

  public var key: String
  public var json: String
  public var updatedAt: Double
  public var dirty: Bool

  public init(key: String, json: String, updatedAt: Double, dirty: Bool = true) {
    self.key = key
    self.json = json
    self.updatedAt = updatedAt
    self.dirty = dirty
  }
}

/// A cached AI run (plan 023 §8): the request/response pair a panel re-reads
/// without another billable call.
public struct AIRunRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "ai_runs"

  public var runId: String
  public var documentLocalId: String?
  public var kind: String
  public var requestJSON: String
  public var responseJSON: String?
  public var status: String
  public var createdAt: Double

  public init(
    runId: String, documentLocalId: String?, kind: String, requestJSON: String,
    responseJSON: String?, status: String, createdAt: Double
  ) {
    self.runId = runId
    self.documentLocalId = documentLocalId
    self.kind = kind
    self.requestJSON = requestJSON
    self.responseJSON = responseJSON
    self.status = status
    self.createdAt = createdAt
  }
}

/// Per-window layout, restored on relaunch (macOS scenes / iPad Stage Manager).
public struct WindowStateRecord: Codable, Sendable, FetchableRecord, PersistableRecord, Equatable {
  public static let databaseTableName = "window_state"

  public var windowId: String
  public var json: String
  public var updatedAt: Double

  public init(windowId: String, json: String, updatedAt: Double) {
    self.windowId = windowId
    self.json = json
    self.updatedAt = updatedAt
  }
}
