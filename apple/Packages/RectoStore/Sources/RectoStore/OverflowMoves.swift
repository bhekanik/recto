import Foundation
import GRDB

/// Text moved between a draft and its Overflow notes by one history node.
///
/// The move rides the node: committing the node applies it, and moving the head
/// across the node reverses or reapplies it. Only the moved text is touched, so
/// notes typed after the move survive an undo, unlike a whole-notes snapshot.
public struct OverflowMoveIntent: Equatable, Sendable {
  public enum Kind: String, Codable, Sendable {
    /// Draft text removed by the node is appended to the notes.
    case stash
    /// Notes text at `notesLocation` is removed and inserted into the draft.
    case restore
  }

  public let kind: Kind
  public let text: String
  /// For `.restore`: the UTF-16 offset of `text` in the notes being moved from.
  public let notesLocation: Int
  /// For `.restore`: the notes generation the selection was read at.
  public let notesGeneration: Int?

  public static func stash(_ text: String) -> OverflowMoveIntent {
    OverflowMoveIntent(kind: .stash, text: text, notesLocation: 0, notesGeneration: nil)
  }

  public static func restore(_ text: String, at notesLocation: Int, generation: Int) -> OverflowMoveIntent {
    OverflowMoveIntent(kind: .restore, text: text, notesLocation: notesLocation, notesGeneration: generation)
  }
}

struct OverflowMoveRecord: Codable, FetchableRecord, PersistableRecord, Equatable {
  static let databaseTableName = "overflow_move"
  var documentLocalId: String
  var nodeId: String
  var kind: OverflowMoveIntent.Kind
  /// The moved text as it appears in the draft.
  var text: String
  /// The exact run the notes hold while they hold this text: `text`, plus the
  /// blank line that separates an appended run from earlier notes.
  var notesText: String
  var notesLocation: Int
  /// The notes generation this move last left behind. While the notes are still
  /// at it, `notesLocation` is exact; after other edits the run is appended.
  var notesGeneration: Int
  /// Whether the notes currently show this move's effect: the run added for a
  /// stash, the run taken out for a restore.
  var applied: Bool
}

extension RectoStore {
  /// Apply a new node's move inside the transaction that commits the node.
  /// Throwing rolls back the node too, so the draft and notes never disagree.
  static func applyNewOverflowMove(_ db: Database, documentLocalId: String, nodeId: String, intent: OverflowMoveIntent) throws {
    var row = try OverflowRecord.fetchOne(db, key: documentLocalId) ?? OverflowRecord(documentLocalId: documentLocalId)
    // A conflict keeps both copies until the writer picks one; moving text into
    // a copy that may be discarded could lose it.
    guard row.remoteMarkdown == nil else { throw OverflowError.unresolvedCopy }
    var move = OverflowMoveRecord(
      documentLocalId: documentLocalId, nodeId: nodeId, kind: intent.kind, text: intent.text,
      notesText: intent.text, notesLocation: intent.notesLocation, notesGeneration: 0, applied: true)
    switch intent.kind {
    case .stash:
      appendRun(&move, to: &row.markdown)
    case .restore:
      let notes = row.markdown as NSString
      let range = NSRange(location: intent.notesLocation, length: (intent.text as NSString).length)
      guard intent.notesGeneration == row.generation, NSMaxRange(range) <= notes.length,
        (notes.substring(with: range) as NSString).isEqual(to: intent.text)
      else { throw OverflowError.changed }
      row.markdown = notes.replacingCharacters(in: range, with: "")
    }
    guard row.markdown.utf8.count <= 65_536 else { throw OverflowError.tooLarge }
    row.generation += 1
    move.notesGeneration = row.generation
    try row.save(db)
    try move.insert(db)
  }

  /// Reverse the moves of the nodes the head leaves, then reapply those of the
  /// nodes it enters, in the transaction that moves the head.
  ///
  /// Moved text is removed only where it is found exactly, never by similarity.
  /// If the writer has edited it since, the notes keep their version: the text
  /// may then be in both the draft and the notes, but it is never lost.
  static func shiftOverflowMoves(_ db: Database, documentLocalId: String, leaving: [String], entering: [String]) throws {
    let nodeIds = leaving + entering
    guard !nodeIds.isEmpty else { return }
    let moves = try OverflowMoveRecord
      .filter(Column("documentLocalId") == documentLocalId)
      .filter(nodeIds.contains(Column("nodeId")))
      .fetchAll(db)
    guard !moves.isEmpty, var row = try OverflowRecord.fetchOne(db, key: documentLocalId) else { return }
    var byNode = Dictionary(uniqueKeysWithValues: moves.map { ($0.nodeId, $0) })
    let original = row.markdown
    let startGeneration = row.generation
    var toggled: [String] = []

    for nodeId in leaving {
      guard var move = byNode[nodeId], move.applied else { continue }
      switch move.kind {
      case .stash:
        guard removeRun(&move, from: &row.markdown) else { continue }
      case .restore:
        insertRun(&move, into: &row.markdown, exact: move.notesGeneration == startGeneration)
      }
      move.applied = false
      byNode[nodeId] = move
      toggled.append(nodeId)
    }
    for nodeId in entering {
      guard var move = byNode[nodeId], !move.applied else { continue }
      switch move.kind {
      case .stash:
        insertRun(&move, into: &row.markdown, exact: move.notesGeneration == startGeneration)
      case .restore:
        // Edited since: the draft regains the text and the notes keep theirs.
        _ = removeRun(&move, from: &row.markdown)
      }
      move.applied = true
      byNode[nodeId] = move
      toggled.append(nodeId)
    }

    if !(row.markdown as NSString).isEqual(to: original) {
      guard row.markdown.utf8.count <= 65_536 else { throw OverflowError.tooLarge }
      row.generation += 1
      try row.update(db)
    }
    for nodeId in toggled {
      guard var move = byNode[nodeId] else { continue }
      move.notesGeneration = row.generation
      try move.update(db)
    }
  }

  private static func appendRun(_ move: inout OverflowMoveRecord, to notes: inout String) {
    let separator = notes.isEmpty || notes.hasSuffix("\n\n") ? "" : notes.hasSuffix("\n") ? "\n" : "\n\n"
    move.notesLocation = (notes as NSString).length
    move.notesText = separator + move.text
    notes += move.notesText
  }

  private static func insertRun(_ move: inout OverflowMoveRecord, into notes: inout String, exact: Bool) {
    guard exact, move.notesLocation <= (notes as NSString).length else {
      appendRun(&move, to: &notes)
      return
    }
    notes = (notes as NSString).replacingCharacters(
      in: NSRange(location: move.notesLocation, length: 0), with: move.notesText)
  }

  /// Records where the run was found, so reinserting it puts it back there.
  private static func removeRun(_ move: inout OverflowMoveRecord, from notes: inout String) -> Bool {
    guard let range = locate(move.notesText, near: move.notesLocation, in: notes) else { return false }
    notes = (notes as NSString).replacingCharacters(in: range, with: "")
    move.notesLocation = range.location
    return true
  }

  /// The run at its recorded offset, or its only occurrence anywhere.
  static func locate(_ text: String, near location: Int, in notes: String) -> NSRange? {
    let notes = notes as NSString
    let length = (text as NSString).length
    guard length > 0 else { return nil }
    let recorded = NSRange(location: location, length: length)
    if NSMaxRange(recorded) <= notes.length, (notes.substring(with: recorded) as NSString).isEqual(to: text) {
      return recorded
    }
    let first = notes.range(of: text, options: .literal)
    guard first.location != NSNotFound else { return nil }
    let rest = NSRange(location: first.location + 1, length: notes.length - first.location - 1)
    guard notes.range(of: text, options: .literal, range: rest).location == NSNotFound else { return nil }
    return first
  }
}
