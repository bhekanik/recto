import Foundation

/// Working material attached to a draft's text: alternatives for now, ghosts
/// later. It belongs to a history node, like the text does, so undo, branches
/// and sync carry it with the words it describes.
///
/// A node stores it only where it changes. Every other node, including nodes
/// written by clients that do not know about it, derives it from its parent by
/// mapping the ranges through the node's patch, so an older client's edit
/// shifts alternatives instead of erasing them.
public struct WritingState: Codable, Equatable, Sendable {
  public static let currentVersion = 1
  /// The largest encoded state a node may carry, matching the server.
  public static let maxEncodedBytes = 64 * 1024

  public var version: Int
  public var alternatives: [AlternativeGroup]
  /// Passages set aside in place: still in the text, shown faintly.
  public var ghosts: [GhostSpan]

  public init(alternatives: [AlternativeGroup] = [], ghosts: [GhostSpan] = []) {
    self.version = Self.currentVersion
    self.alternatives = alternatives
    self.ghosts = ghosts
  }

  private enum CodingKeys: String, CodingKey { case version, alternatives, ghosts }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    version = try container.decode(Int.self, forKey: .version)
    alternatives = try container.decodeIfPresent([AlternativeGroup].self, forKey: .alternatives) ?? []
    ghosts = try container.decodeIfPresent([GhostSpan].self, forKey: .ghosts) ?? []
  }

  public var isEmpty: Bool { alternatives.isEmpty && ghosts.isEmpty }

  /// Sorted keys, so equal states encode to equal strings across devices.
  public var encoded: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: (try? encoder.encode(self)) ?? Data("{}".utf8), as: UTF8.self)
  }

  /// A state written by a newer client that this one cannot read is treated as
  /// absent rather than misread; the newer client keeps it on its own nodes.
  public static func decode(_ raw: String) -> WritingState? {
    guard let state = try? JSONDecoder().decode(WritingState.self, from: Data(raw.utf8)),
      state.version == currentVersion
    else { return nil }
    return state
  }
}

/// Wordings for one passage. `candidates[0]` is the original; the text holds
/// the active candidate wherever the group is attached.
public struct AlternativeGroup: Codable, Equatable, Sendable, Identifiable {
  public enum Scope: String, Codable, Sendable { case word, sentence, paragraph }

  public var id: String
  public var scope: Scope
  /// UTF-16 range in the node's Markdown.
  public var location: Int
  public var length: Int
  public var candidates: [AlternativeCandidate]
  public var activeId: String
  /// An edit cut across the passage. Its wordings are kept, but nothing in the
  /// text is touched through it until it is attached again.
  public var detached: Bool

  public init(
    id: String, scope: Scope, location: Int, length: Int,
    candidates: [AlternativeCandidate], activeId: String, detached: Bool = false
  ) {
    self.id = id
    self.scope = scope
    self.location = location
    self.length = length
    self.candidates = candidates
    self.activeId = activeId
    self.detached = detached
  }

  public var range: NSRange { NSRange(location: location, length: length) }
  public var active: AlternativeCandidate? { candidates.first { $0.id == activeId } }
  public var isOnOriginal: Bool { candidates.first?.id == activeId }
}

/// A passage the writer set aside without deleting it.
public struct GhostSpan: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  /// UTF-16 range in the node's Markdown.
  public var location: Int
  public var length: Int

  public init(id: String, location: Int, length: Int) {
    self.id = id
    self.location = location
    self.length = length
  }

  public var range: NSRange { NSRange(location: location, length: length) }
}

public struct AlternativeCandidate: Codable, Equatable, Sendable, Identifiable {
  public enum Author: String, Codable, Sendable { case human, ai }

  public var id: String
  public var text: String
  public var author: Author

  public init(id: String, text: String, author: Author) {
    self.id = id
    self.text = text
    self.author = author
  }
}

extension WritingState {
  /// The state after `patch` turned the parent's text into `markdown`.
  ///
  /// Insertions at a passage's edges stay outside it, so typing next to a word
  /// does not grow it. An edit inside a passage edits the active wording. An
  /// edit that crosses a passage's edge detaches it.
  public func mapped(through patch: TextPatch, into markdown: JSString) -> WritingState {
    var next = self
    let delta = patch.insert.count - (patch.to - patch.from)
    for index in next.alternatives.indices where !next.alternatives[index].detached {
      var group = next.alternatives[index]
      let start = group.location
      let end = group.location + group.length
      if patch.to <= start {
        group.location += delta
      } else if patch.from >= end {
        // After the passage: untouched.
      } else if patch.from >= start, patch.to <= end {
        group.length += delta
        if group.length == 0 {
          group.detached = true
        } else if let active = group.candidates.firstIndex(where: { $0.id == group.activeId }),
          let text = markdown.slice(group.location, group.location + group.length).string
        {
          group.candidates[active].text = text
        } else {
          group.detached = true
        }
      } else {
        group.detached = true
      }
      next.alternatives[index] = group
    }
    // A ghost keeps whatever of it the edit left: typing inside it stays
    // ghosted, an edit across an edge trims it, deleting all of it removes it.
    next.ghosts = next.ghosts.compactMap { ghost in
      var ghost = ghost
      let start = ghost.location, end = ghost.location + ghost.length
      if patch.to <= start {
        ghost.location += delta
      } else if patch.from >= end {
      } else if patch.from >= start, patch.to <= end {
        ghost.length += delta
      } else if patch.from <= start, patch.to >= end {
        return nil
      } else if patch.from <= start {
        ghost.location = patch.from + patch.insert.count
        ghost.length = end - patch.to
      } else {
        ghost.length = patch.from - start
      }
      return ghost.length > 0 ? ghost : nil
    }
    return next
  }

  /// Groups whose stored range no longer holds their active wording are
  /// detached, so a state that disagrees with its text cannot rewrite it.
  public func validated(against markdown: JSString) -> WritingState {
    var next = self
    for index in next.alternatives.indices where !next.alternatives[index].detached {
      let group = next.alternatives[index]
      let end = group.location + group.length
      guard group.location >= 0, group.length > 0, end <= markdown.count,
        let active = group.active,
        markdown.slice(group.location, end) == JSString(active.text)
      else {
        next.alternatives[index].detached = true
        continue
      }
    }
    next.ghosts.removeAll { $0.location < 0 || $0.length <= 0 || $0.location + $0.length > markdown.count }
    return next
  }
}

/// The writing state at `targetNodeId`: the nearest explicit state at or above
/// it, mapped down through every patch in between.
public func materializeWriting(_ targetNodeId: String, _ nodesById: [String: DocNode]) throws -> WritingState {
  guard nodesById[targetNodeId] != nil else { throw MaterializeError.unknownNode(targetNodeId) }
  var chain: [DocNode] = []
  var cursor: String? = targetNodeId
  var explicit: WritingState?
  var seen = Set<String>()
  while let id = cursor, let node = nodesById[id], seen.insert(id).inserted {
    if let raw = node.writing, let state = WritingState.decode(raw) {
      explicit = state
      break
    }
    chain.append(node)
    cursor = node.parentNodeId
  }
  guard let explicit, let base = cursor else { return WritingState() }
  var markdown = JSString(try materialize(base, nodesById))
  var state = explicit.validated(against: markdown)
  for node in chain.reversed() {
    let patch = try TextPatch.decode(node.patch)
    markdown = applyPatch(markdown, patch)
    state = state.mapped(through: patch, into: markdown)
  }
  return state
}

extension WritingState {
  /// The attached passage containing `location`, edges included, so a caret
  /// just after a word still finds it.
  public func group(containing location: Int) -> AlternativeGroup? {
    alternatives.first { !$0.detached && $0.location <= location && location <= $0.location + $0.length }
  }

  /// The attached passage exactly covering `range`.
  public func group(covering range: NSRange) -> AlternativeGroup? {
    alternatives.first { !$0.detached && $0.range == range }
  }

  /// Add `text` as a wording for `range` of `markdown`, starting a passage
  /// there (with the current text as its original) when none covers it.
  /// Refuses ranges that overlap another passage, so passages never nest.
  public func adding(
    _ text: String, author: AlternativeCandidate.Author, scope: AlternativeGroup.Scope,
    at range: NSRange, in markdown: String, newId: () -> String
  ) -> WritingState? {
    let source = markdown as NSString
    guard range.length > 0, NSMaxRange(range) <= source.length, !text.isEmpty else { return nil }
    var next = self
    if let index = next.alternatives.firstIndex(where: { !$0.detached && $0.range == range }) {
      guard !next.alternatives[index].candidates.contains(where: { $0.text == text }) else { return self }
      next.alternatives[index].candidates.append(AlternativeCandidate(id: newId(), text: text, author: author))
      return next
    }
    let overlaps = alternatives.contains {
      !$0.detached && $0.location < NSMaxRange(range) && range.location < $0.location + $0.length
    }
    guard !overlaps else { return nil }
    let original = AlternativeCandidate(id: newId(), text: source.substring(with: range), author: .human)
    var candidates = [original]
    if text != original.text { candidates.append(AlternativeCandidate(id: newId(), text: text, author: author)) }
    next.alternatives.append(AlternativeGroup(
      id: newId(), scope: scope, location: range.location, length: range.length,
      candidates: candidates, activeId: original.id))
    return next
  }

  /// Show `candidateId` in its passage: the text replacement to make and the
  /// state for the resulting text, with every other passage shifted.
  ///
  /// `article` replaces the indefinite article in front of the passage in the
  /// same change ("a thumbtack" → "an eraser"), so one undo restores both.
  public func choosing(
    _ candidateId: String, in groupId: String, markdown: String,
    article: (range: NSRange, text: String)? = nil
  ) -> (state: WritingState, range: NSRange, text: String)? {
    guard let index = alternatives.firstIndex(where: { $0.id == groupId && !$0.detached }),
      let candidate = alternatives[index].candidates.first(where: { $0.id == candidateId })
    else { return nil }
    let range = alternatives[index].range
    let source = markdown as NSString
    guard NSMaxRange(range) <= source.length else { return nil }
    var next = self
    next.alternatives[index].activeId = candidateId
    var text = source as String
    if let article {
      guard NSMaxRange(article.range) <= range.location else { return nil }
      let patch = TextPatch(from: article.range.location, to: NSMaxRange(article.range), insert: article.text)
      text = source.replacingCharacters(in: article.range, with: article.text)
      next = next.mapped(through: patch, into: JSString(text))
    }
    let shifted = next.alternatives[index].range
    let patch = TextPatch(from: shifted.location, to: NSMaxRange(shifted), insert: candidate.text)
    text = (text as NSString).replacingCharacters(in: shifted, with: candidate.text)
    next = next.mapped(through: patch, into: JSString(text))
    let start = article?.range.location ?? range.location
    let changed = NSRange(location: start, length: NSMaxRange(range) - start)
    let replacement = (text as NSString).substring(
      with: NSRange(location: start, length: NSMaxRange(changed) + (text as NSString).length - source.length - start))
    return (next, changed, replacement)
  }

  /// Remove a wording that is not showing. A passage left with only its
  /// original is removed, so its underline goes too.
  public func removing(_ candidateId: String, from groupId: String) -> WritingState? {
    guard let index = alternatives.firstIndex(where: { $0.id == groupId }),
      alternatives[index].activeId != candidateId,
      let position = alternatives[index].candidates.firstIndex(where: { $0.id == candidateId })
    else { return nil }
    var next = self
    next.alternatives[index].candidates.remove(at: position)
    if next.alternatives[index].candidates.count <= 1 { next.alternatives.remove(at: index) }
    return next
  }
}
