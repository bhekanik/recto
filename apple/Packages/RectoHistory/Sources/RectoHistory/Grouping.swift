import Foundation

/// ~500 ms time-gap coalescing, matching the web engines' `newGroupDelay` (07 §4).
public let groupDelayMS: Double = 500

/// One committed undo-tree node, ready to persist and advance the pointer.
public struct GroupCommit: Equatable, Sendable {
  public var nodeId: String
  public var parentNodeId: String
  public var patch: String
  public var snapshot: String?
  public var selection: NodeSelection?
  /// The full materialized Markdown at this node (for the pointer/markdown write).
  public var markdown: String

  public init(
    nodeId: String,
    parentNodeId: String,
    patch: String,
    snapshot: String?,
    selection: NodeSelection?,
    markdown: String
  ) {
    self.nodeId = nodeId
    self.parentNodeId = parentNodeId
    self.patch = patch
    self.snapshot = snapshot
    self.selection = selection
    self.markdown = markdown
  }
}

/// Model-level grouping engine (blueprint 07 §4, port of `lib/history/grouping.ts`).
///
/// Keystroke-level changes coalesce into one draft node; a node boundary is
/// committed when any of these fire:
///   1. a >~500 ms typing pause (idle),
///   2. an adjacency break (the edit jumped to a different region),
///   3. a structural boundary (paste, block change, mode switch).
/// Selection-only moves never commit a node.
///
/// Differences from the web version, both deliberate:
///  - Commits are **returned**, not delivered through a callback. The caller is
///    an actor that has to persist them in one transaction; a callback would
///    have to hop isolation domains mid-mutation.
///  - The idle timer lives in the caller. This type only reports the deadline
///    (`idleDeadline`), which keeps it pure and lets tests drive time directly.
public struct GroupingController: Sendable {
  private var parentNodeId: String
  private var parentMarkdown: JSString
  private var draftMarkdown: JSString
  private var draftSelection: NodeSelection?
  private var lastChangeAt: Double = 0
  private var lastChangeEnd: Int = -1
  private var depthSinceSnapshot: Int
  private let mintNodeId: @Sendable () -> String

  public init(
    rootNodeId: String,
    rootMarkdown: String,
    depthSinceSnapshot: Int = 0,
    mintNodeId: @escaping @Sendable () -> String = { ulid() }
  ) {
    self.parentNodeId = rootNodeId
    self.parentMarkdown = JSString(rootMarkdown)
    self.draftMarkdown = self.parentMarkdown
    self.depthSinceSnapshot = depthSinceSnapshot
    self.mintNodeId = mintNodeId
  }

  public var currentNodeId: String { parentNodeId }

  /// The pending draft's Markdown — what the editor shows and what the debounced
  /// draft row persists, before any node exists for it.
  public var draft: String { draftMarkdown.string ?? draftMarkdown.lossyString }

  public var hasPendingDraft: Bool { draftMarkdown != parentMarkdown }

  /// When the idle boundary fires, in the caller's clock. `nil` when nothing is
  /// pending.
  public var idleDeadline: Double? {
    hasPendingDraft && lastChangeAt > 0 ? lastChangeAt + groupDelayMS : nil
  }

  /// Reposition after a navigation/restore. Never commits.
  public mutating func setCurrent(
    nodeId: String, markdown: String, depthSinceSnapshot: Int = 0
  ) {
    parentNodeId = nodeId
    parentMarkdown = JSString(markdown)
    draftMarkdown = parentMarkdown
    draftSelection = nil
    lastChangeAt = 0
    lastChangeEnd = -1
    self.depthSinceSnapshot = depthSinceSnapshot
  }

  /// Feed a canonical-Markdown change from any lens. Returns the commits the
  /// boundary rules produced (0, 1, or — when a structural edit also closes an
  /// older draft — 2).
  public mutating func record(
    markdown: String,
    selection: NodeSelection?,
    structural: Bool = false,
    now: Double
  ) -> [GroupCommit] {
    let next = JSString(markdown)
    // Selection-only move: update the pending caret, never commit (07 §4.4).
    if next == draftMarkdown {
      draftSelection = selection
      return []
    }

    var commits: [GroupCommit] = []
    let incremental = computePatch(draftMarkdown, next)
    let gap = lastChangeAt > 0 ? now - lastChangeAt : 0
    let adjacencyBreak =
      lastChangeEnd >= 0 && draftMarkdown != parentMarkdown
      && abs(incremental.from - lastChangeEnd) > 1
    let boundaryBefore = gap > groupDelayMS || adjacencyBreak || structural

    if boundaryBefore, draftMarkdown != parentMarkdown, let commit = commitDraft() {
      commits.append(commit)
    }

    draftMarkdown = next
    draftSelection = selection
    lastChangeAt = now
    lastChangeEnd = incremental.from + incremental.insert.count

    if structural, let commit = commitDraft() {
      // A structural edit is its own node — commit immediately.
      commits.append(commit)
    }
    return commits
  }

  /// The idle deadline elapsed.
  public mutating func tick() -> GroupCommit? {
    guard draftMarkdown != parentMarkdown else { return nil }
    return commitDraft()
  }

  /// Force-commit any pending draft (mode switch, blur, before navigate/persist).
  public mutating func flush() -> GroupCommit? { tick() }

  private mutating func commitDraft() -> GroupCommit? {
    guard draftMarkdown != parentMarkdown else { return nil }

    let patch = computePatch(parentMarkdown, draftMarkdown).encoded
    depthSinceSnapshot += 1
    let takeSnapshot = depthSinceSnapshot >= snapshotEveryN
    if takeSnapshot { depthSinceSnapshot = 0 }

    let markdown = draftMarkdown.string ?? draftMarkdown.lossyString
    let commit = GroupCommit(
      nodeId: mintNodeId(),
      parentNodeId: parentNodeId,
      patch: patch,
      snapshot: takeSnapshot ? markdown : nil,
      selection: draftSelection,
      markdown: markdown
    )

    parentNodeId = commit.nodeId
    parentMarkdown = draftMarkdown
    lastChangeEnd = -1
    return commit
  }
}
