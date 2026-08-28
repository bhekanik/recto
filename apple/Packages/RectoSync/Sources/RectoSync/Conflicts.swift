import Foundation
import RectoHistory

/// What to do when the server's head is not where we left it (plan 023 §4.4).
///
/// No CRDT: the undo tree is an append-only DAG, so nodes never conflict — only
/// the head pointer can. ADR-06 stands.
public enum ConflictResolution: Sendable, Equatable {
  /// Heads agree; nothing to do.
  case inSync
  /// The remote head is an ancestor of our head: the server simply has not seen
  /// our nodes. Upload the missing ones (oldest first) and re-commit onto
  /// `rebaseOnto` (the current remote head).
  case uploadAncestors(missing: [String], rebaseOnto: String)
  /// Our head is an ancestor of the remote head: someone else built on our work.
  /// Adopt the remote head, keeping the caret. `whenIdle` is false when there is
  /// pending local work, in which case the caller waits for the outbox to drain
  /// before adopting so a keystroke is not overwritten mid-sentence.
  case adoptRemote(headNodeId: String, whenIdle: Bool)
  /// Neither head reaches the other. Both branches are kept — the DAG allows it
  /// — and the UI offers keep local / keep remote / edit merged.
  case diverged(local: String, remote: String)
  /// The remote head is not in the local DAG yet. Pull `docNodes.listSince` and
  /// decide again; guessing here is how you lose a branch.
  case awaitingNodes(remoteHeadNodeId: String)
}

public enum ConflictResolver {
  /// Pure decision. `nodesById` must contain every local node; `hasPendingWork`
  /// is true when the outbox still holds anything for this document or a draft
  /// sits ahead of the head.
  /// `remotePointerIsNewer` distinguishes "the server has not seen our nodes
  /// yet" from "the server deliberately moved its pointer back".
  ///
  /// Both look identical by ancestry — the remote head is an ancestor of ours —
  /// but a remote undo is a decision, not lag, and uploading over it would drag
  /// the other device forward again. `documents.pointerRevision` is the counter
  /// that tells them apart; it does not depend on either clock.
  public static func resolve(
    localHead: String,
    remoteHead: String,
    nodesById: [String: DocNode],
    hasPendingWork: Bool,
    remotePointerIsNewer: Bool = false
  ) -> ConflictResolution {
    if localHead == remoteHead { return .inSync }
    guard nodesById[remoteHead] != nil else {
      return .awaitingNodes(remoteHeadNodeId: remoteHead)
    }

    if isAncestor(remoteHead, of: localHead, in: nodesById) {
      if remotePointerIsNewer {
        // A remote undo: they moved back on purpose, after everything we sent.
        return .adoptRemote(headNodeId: remoteHead, whenIdle: !hasPendingWork)
      }
      let missing = pathBetween(ancestor: remoteHead, descendant: localHead, in: nodesById)
      return .uploadAncestors(missing: missing, rebaseOnto: remoteHead)
    }

    if isAncestor(localHead, of: remoteHead, in: nodesById) {
      return .adoptRemote(headNodeId: remoteHead, whenIdle: !hasPendingWork)
    }

    return .diverged(local: localHead, remote: remoteHead)
  }

  /// Node ids strictly between `ancestor` and `descendant`, plus `descendant`
  /// itself, oldest first — the nodes the server is missing.
  public static func pathBetween(
    ancestor: String, descendant: String, in nodesById: [String: DocNode]
  ) -> [String] {
    var path: [String] = []
    var cursor: String? = descendant
    while let id = cursor, id != ancestor {
      path.append(id)
      cursor = nodesById[id]?.parentNodeId
    }
    return path.reversed()
  }

  /// The nearest common ancestor of two heads, for the compare sheet's base.
  public static func commonAncestor(
    _ left: String, _ right: String, in nodesById: [String: DocNode]
  ) -> String? {
    let leftChain = ancestorChain(left, nodesById)
    var cursor: String? = right
    while let id = cursor {
      if leftChain.contains(id) { return id }
      cursor = nodesById[id]?.parentNodeId
    }
    return nil
  }
}
