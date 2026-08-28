import Foundation
import Synchronization
import Testing

@testable import RectoHistory

/// Node ids are random in both implementations, so parity is checked against a
/// deterministic "n1, n2, …" sequence on the Swift side and against the fixture's
/// commit sequence numbers on the web side.
private final class SequentialIDs: Sendable {
  private let counter = Mutex(0)
  func next() -> String {
    counter.withLock { value in
      value += 1
      return "n\(value)"
    }
  }
}

struct GroupingCases: Decodable {
  struct Step: Decodable {
    let markdown: String
    let selection: NodeSelection?
    let structural: Bool
    let now: Double
    let kind: String
  }
  struct Commit: Decodable {
    let sequence: Int
    let patch: String
    let snapshot: String?
    let selection: NodeSelection?
    let markdown: String
  }
  let steps: [Step]
  let commits: [Commit]
}

@Suite("grouping parity with lib/history/grouping.ts")
struct GroupingTests {
  @Test("replaying the web's keystroke script produces the same node boundaries")
  func replayScript() throws {
    let fixture: GroupingCases = try Fixtures.load("grouping-cases")

    // Node ids are random on both sides, so the fixture records parents by the
    // sequence in which they were minted; the port mints "n1", "n2", … and the
    // expectations are rewritten through the same mapping.
    let ids = SequentialIDs()
    var controller = GroupingController(
      rootNodeId: "root", rootMarkdown: "", mintNodeId: ids.next)

    var produced: [GroupCommit] = []
    for step in fixture.steps {
      switch step.kind {
      case "record":
        produced += controller.record(
          markdown: step.markdown, selection: step.selection, structural: step.structural,
          now: step.now)
      case "tick":
        if let commit = controller.tick() { produced.append(commit) }
      default:
        if let commit = controller.flush() { produced.append(commit) }
      }
    }

    #expect(produced.count == fixture.commits.count)
    for (index, expected) in fixture.commits.enumerated() {
      let actual = produced[index]
      let expectedParent = expected.sequence == 1 ? "root" : "n\(expected.sequence - 1)"
      #expect(actual.nodeId == "n\(expected.sequence)")
      #expect(actual.parentNodeId == expectedParent)
      #expect(actual.patch == expected.patch)
      #expect(actual.snapshot == expected.snapshot)
      #expect(actual.selection == expected.selection)
      #expect(actual.markdown == expected.markdown)
    }
  }

  @Test("a selection-only move never commits a node")
  func selectionOnly() {
    var controller = GroupingController(rootNodeId: "root", rootMarkdown: "hello")
    #expect(controller.record(markdown: "hello", selection: NodeSelection(anchor: 1, head: 1), now: 0).isEmpty)
    #expect(controller.hasPendingDraft == false)
    #expect(controller.flush() == nil)
  }

  @Test("a >500ms pause closes the previous node")
  func idleBoundary() {
    let ids = SequentialIDs()
    var controller = GroupingController(
      rootNodeId: "root", rootMarkdown: "",
      mintNodeId: ids.next)
    #expect(controller.record(markdown: "a", selection: nil, now: 0).isEmpty)
    #expect(controller.record(markdown: "ab", selection: nil, now: 100).isEmpty)
    let afterPause = controller.record(markdown: "abc", selection: nil, now: 700)
    #expect(afterPause.count == 1)
    #expect(afterPause[0].markdown == "ab")
  }

  @Test("the idle deadline is 500ms after the last change")
  func idleDeadline() {
    var controller = GroupingController(rootNodeId: "root", rootMarkdown: "")
    #expect(controller.idleDeadline == nil)
    _ = controller.record(markdown: "a", selection: nil, now: 1_000)
    #expect(controller.idleDeadline == 1_500)
    _ = controller.flush()
    #expect(controller.idleDeadline == nil)
  }

  @Test("an edit that jumps to another region breaks the group")
  func adjacencyBreak() {
    let ids = SequentialIDs()
    var controller = GroupingController(
      rootNodeId: "root", rootMarkdown: "hello world",
      mintNodeId: ids.next)
    #expect(controller.record(markdown: "hello worldX", selection: nil, now: 0).isEmpty)
    let jumped = controller.record(markdown: "Yhello worldX", selection: nil, now: 10)
    #expect(jumped.count == 1)
    #expect(jumped[0].markdown == "hello worldX")
  }

  @Test("a structural edit closes the open node and becomes its own")
  func structuralIsOwnNode() {
    let ids = SequentialIDs()
    var controller = GroupingController(
      rootNodeId: "root", rootMarkdown: "",
      mintNodeId: ids.next)
    _ = controller.record(markdown: "typing", selection: nil, now: 0)
    let commits = controller.record(
      markdown: "typing\n\n## pasted\n", selection: nil, structural: true, now: 10)
    #expect(commits.count == 2)
    #expect(commits[0].markdown == "typing")
    #expect(commits[1].markdown == "typing\n\n## pasted\n")
    #expect(commits[1].parentNodeId == commits[0].nodeId)
    #expect(controller.hasPendingDraft == false)
  }

  @Test("setCurrent repositions without committing and resumes the snapshot cadence")
  func setCurrentResumes() {
    let ids = SequentialIDs()
    var controller = GroupingController(
      rootNodeId: "root", rootMarkdown: "",
      mintNodeId: ids.next)
    _ = controller.record(markdown: "draft", selection: nil, now: 0)
    controller.setCurrent(nodeId: "other", markdown: "elsewhere", depthSinceSnapshot: snapshotEveryN - 1)
    #expect(controller.currentNodeId == "other")
    #expect(controller.hasPendingDraft == false)

    let commits = controller.record(
      markdown: "elsewhere!", selection: nil, structural: true, now: 5)
    #expect(commits.count == 1)
    #expect(commits[0].snapshot == "elsewhere!")
  }

  @Test("a restored draft is the visible text and commits against the persisted head")
  func restorePendingDraft() {
    let ids = SequentialIDs()
    var controller = GroupingController(
      rootNodeId: "head", rootMarkdown: "committed text", mintNodeId: ids.next)
    controller.restorePendingDraft(
      markdown: "committed text plus unsaved", selection: NodeSelection(anchor: 3, head: 3),
      now: 1_000)

    #expect(controller.draft == "committed text plus unsaved")
    #expect(controller.hasPendingDraft)
    #expect(controller.draftSelectionValue == NodeSelection(anchor: 3, head: 3))
    #expect(controller.idleDeadline == 1_500)

    // The recovered text commits as ONE node whose patch is relative to the
    // persisted head, not as if the user had retyped the whole document.
    let flushed = controller.flush()
    let commit = try! #require(flushed)
    #expect(commit.parentNodeId == "head")
    #expect(commit.markdown == "committed text plus unsaved")
    #expect(commit.patch == computePatch("committed text", "committed text plus unsaved").encoded)
  }

  @Test("restoring a draft equal to the head is a no-op")
  func restoreNoopDraft() {
    var controller = GroupingController(rootNodeId: "head", rootMarkdown: "same")
    controller.restorePendingDraft(markdown: "same", selection: nil, now: 10)
    #expect(controller.hasPendingDraft == false)
    #expect(controller.flush() == nil)
  }
}
