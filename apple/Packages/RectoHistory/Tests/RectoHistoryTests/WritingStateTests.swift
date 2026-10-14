import Foundation
import Testing

@testable import RectoHistory

@Suite("writing state follows the text")
struct WritingStateTests {
  private let text = "Much of the tension in design."

  private func state(word: String = "tension") -> WritingState {
    let range = (text as NSString).range(of: word)
    return WritingState(alternatives: [
      AlternativeGroup(
        id: "g", scope: .word, location: range.location, length: range.length,
        candidates: [
          AlternativeCandidate(id: "o", text: word, author: .human),
          AlternativeCandidate(id: "p", text: "pressure", author: .human),
        ], activeId: "o")
    ])
  }

  private func edit(_ before: String, _ after: String, _ state: WritingState) -> AlternativeGroup {
    let patch = computePatch(before, after)
    return state.mapped(through: patch, into: JSString(after)).alternatives[0]
  }

  @Test("edits before shift the passage; edits after and at its edges leave it alone")
  func outside() {
    var group = edit(text, "So much of the tension in design.", state())
    #expect(!group.detached)
    #expect(("So much of the tension in design." as NSString).substring(with: group.range) == "tension")
    group = edit(text, "Much of the tension in UI design.", state())
    #expect(group.range == (text as NSString).range(of: "tension"))
    // Typing directly after the word does not make it part of the word.
    group = edit(text, "Much of the tensions in design.", state())
    #expect(group.range == (text as NSString).range(of: "tension"))
    #expect(group.active?.text == "tension")
  }

  @Test("an edit inside the passage edits the active wording; crossing its edge detaches it")
  func inside() {
    let group = edit(text, "Much of the tenzion in design.", state())
    #expect(!group.detached)
    #expect(group.active?.text == "tenzion")
    #expect(group.candidates[1].text == "pressure")
    #expect(edit(text, "Much of thension in design.", state()).detached)
    #expect(edit(text, "Much of the  in design.", state()).detached)
  }

  @Test("UTF-16 offsets survive emoji and repeated words")
  func unicode() {
    let source = "😀 the tension, the tension."
    let second = (source as NSString).range(of: "tension", options: .backwards)
    let initial = WritingState(alternatives: [AlternativeGroup(
      id: "g", scope: .word, location: second.location, length: second.length,
      candidates: [AlternativeCandidate(id: "o", text: "tension", author: .human)], activeId: "o")])
    let after = "😀😀 the tension, the tension."
    let group = initial.mapped(through: computePatch(source, after), into: JSString(after)).alternatives[0]
    #expect(group.location == second.location + 2)
    #expect((after as NSString).substring(with: group.range) == "tension")
  }

  @Test("a node without explicit state derives it through every patch below the nearest one")
  func materialized() throws {
    let root = DocNode(nodeId: "root", parentNodeId: nil, patch: "", snapshot: text)
    let marked = DocNode(
      nodeId: "marked", parentNodeId: "root",
      patch: computePatch(text, text).encoded, writing: state().encoded)
    let typed = "So much of the tension in design."
    let child = DocNode(nodeId: "child", parentNodeId: "marked", patch: computePatch(text, typed).encoded)
    let nodes = Dictionary(uniqueKeysWithValues: [root, marked, child].map { ($0.nodeId, $0) })
    #expect(try materializeWriting("root", nodes).isEmpty)
    #expect(try materializeWriting("marked", nodes) == state())
    let derived = try materializeWriting("child", nodes).alternatives[0]
    #expect((typed as NSString).substring(with: derived.range) == "tension")
  }

  @Test("ghosts shift, grow with typing inside, trim at their edges and go when deleted")
  func ghosts() {
    let source = "Keep this. Maybe cut this. Keep that."
    let range = (source as NSString).range(of: "Maybe cut this.")
    let state = WritingState(ghosts: [GhostSpan(id: "g", location: range.location, length: range.length)])
    func after(_ next: String) -> [GhostSpan] {
      state.mapped(through: computePatch(source, next), into: JSString(next)).ghosts
    }
    var next = "So keep this. Maybe cut this. Keep that."
    #expect((next as NSString).substring(with: after(next)[0].range) == "Maybe cut this.")
    next = "Keep this. Maybe cut all this. Keep that."
    #expect((next as NSString).substring(with: after(next)[0].range) == "Maybe cut all this.")
    next = "Keep this. Maybe cut this. Keep that."
    next = "Keep thcut this. Keep that."
    #expect((next as NSString).substring(with: after(next)[0].range) == "cut this.")
    #expect(after("Keep this.  Keep that.").isEmpty)
    #expect(WritingState.decode(#"{"version":1,"alternatives":[]}"#) == WritingState())
    #expect(WritingState.decode(state.encoded) == state)
  }

  @Test("a stored state that disagrees with its text is detached, and an unknown version is ignored")
  func validation() {
    var wrong = state()
    wrong.alternatives[0].location += 1
    #expect(wrong.validated(against: JSString(text)).alternatives[0].detached)
    #expect(state().validated(against: JSString(text)) == state())
    #expect(WritingState.decode(#"{"version":2,"alternatives":[]}"#) == nil)
    #expect(WritingState.decode(state().encoded) == state())
  }
}

@Suite("editing alternatives")
struct AlternativeEditingTests {
  private var counter = 0
  private let text = "Much of the tension in the tension."

  @Test("adding starts a passage with the original, appends to it after, and never nests")
  func adding() throws {
    var ids = 0
    let next = { ids += 1; return "id\(ids)" }
    let range = (text as NSString).range(of: "tension")
    var state = try #require(WritingState().adding("pressure", author: .human, scope: .word, at: range, in: text, newId: next))
    #expect(state.alternatives.count == 1)
    #expect(state.alternatives[0].candidates.map(\.text) == ["tension", "pressure"])
    #expect(state.alternatives[0].isOnOriginal)
    state = try #require(state.adding("struggle", author: .ai, scope: .word, at: range, in: text, newId: next))
    #expect(state.alternatives[0].candidates.map(\.text) == ["tension", "pressure", "struggle"])
    #expect(state.alternatives[0].candidates[2].author == .ai)
    #expect(state.adding("x", author: .human, scope: .word, at: NSRange(location: range.location + 2, length: 4), in: text, newId: next) == nil)
  }

  @Test("choosing replaces the passage and shifts the passages after it")
  func choosing() throws {
    var ids = 0
    let next = { ids += 1; return "id\(ids)" }
    let first = (text as NSString).range(of: "tension")
    let second = (text as NSString).range(of: "tension", options: .backwards)
    var state = try #require(WritingState().adding("pressure", author: .human, scope: .word, at: first, in: text, newId: next))
    state = try #require(state.adding("strain", author: .human, scope: .word, at: second, in: text, newId: next))
    let choice = try #require(state.choosing(state.alternatives[0].candidates[1].id, in: state.alternatives[0].id, markdown: text))
    let result = (text as NSString).replacingCharacters(in: choice.range, with: choice.text)
    #expect(result == "Much of the pressure in the tension.")
    let shown = choice.state.validated(against: JSString(result))
    #expect(shown == choice.state)
    #expect(!shown.alternatives[0].isOnOriginal)
    #expect(shown.alternatives[0].candidates[0].text == "tension")
    #expect((result as NSString).substring(with: shown.alternatives[1].range) == "tension")
  }

  @Test("choosing with an article changes both in one replacement and keeps later passages")
  func article() throws {
    var ids = 0
    let next = { ids += 1; return "id\(ids)" }
    let source = "Like a thumbtack, for example, and the tension."
    let word = (source as NSString).range(of: "thumbtack")
    let later = (source as NSString).range(of: "tension")
    var state = try #require(WritingState().adding("eraser", author: .human, scope: .word, at: word, in: source, newId: next))
    state = try #require(state.adding("pressure", author: .human, scope: .word, at: later, in: source, newId: next))
    let article = (range: NSRange(location: 5, length: 1), text: "an")
    let choice = try #require(state.choosing(
      state.alternatives[0].candidates[1].id, in: state.alternatives[0].id, markdown: source, article: article))
    let result = (source as NSString).replacingCharacters(in: choice.range, with: choice.text)
    #expect(result == "Like an eraser, for example, and the tension.")
    #expect(choice.range == NSRange(location: 5, length: NSMaxRange(word) - 5))
    #expect(choice.state.validated(against: JSString(result)) == choice.state)
    #expect((result as NSString).substring(with: choice.state.alternatives[0].range) == "eraser")
    #expect((result as NSString).substring(with: choice.state.alternatives[1].range) == "tension")
  }

  @Test("removing hides nothing that is showing and drops a passage left with its original")
  func removing() throws {
    var ids = 0
    let next = { ids += 1; return "id\(ids)" }
    let range = (text as NSString).range(of: "tension")
    let state = try #require(WritingState().adding("pressure", author: .ai, scope: .word, at: range, in: text, newId: next))
    let group = state.alternatives[0]
    #expect(state.removing(group.activeId, from: group.id) == nil)
    #expect(try #require(state.removing(group.candidates[1].id, from: group.id)).isEmpty)
  }
}

@Suite("ghosts")
struct GhostTests {
  @Test("readers get the text without ghosts, and ghosting joins touching ghosts")
  func reader() throws {
    let text = "Keep this. Maybe cut this. Keep that."
    var ids = 0
    let next = { ids += 1; return "g\(ids)" }
    let cut = (text as NSString).range(of: "Maybe cut this.")
    var state = try #require(WritingState().ghosting(cut, newId: next))
    #expect(state.readerMarkdown(text) == "Keep this. Keep that.")
    state = try #require(state.ghosting(NSRange(location: NSMaxRange(cut), length: 5), newId: next))
    #expect(state.ghosts.count == 1)
    #expect(state.ghosts[0].range == NSRange(location: cut.location, length: cut.length + 5))
    #expect(state.ghost(containing: cut.location + 3)?.id == state.ghosts[0].id)
    #expect(state.reviving(state.ghosts[0].id).ghosts.isEmpty)
    #expect(WritingState().readerMarkdown(text) == text)
  }
}
