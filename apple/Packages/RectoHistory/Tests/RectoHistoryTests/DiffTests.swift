import Foundation
import Testing

@testable import RectoHistory

struct DiffCases: Decodable {
  struct Run: Decodable {
    let type: String
    let text: String
  }
  struct Hunk: Decodable {
    let index: Int
    let runIndices: [Int]
  }
  struct Case: Decodable {
    let current: String
    let branch: String
    let granularity: String
    let runs: [Run]
    let hunks: [Hunk]
    let mergedNone: String
    let mergedAll: String
    let mergedEven: String
  }
  struct LineCase: Decodable {
    let current: String
    let branch: String
    let lines: [Run]
  }
  let source: String
  let cases: [Case]
  let lineCases: [LineCase]
}

@Suite("diff parity with jsdiff 9 and lib/history/diff.ts")
struct DiffTests {
  @Test("diffRuns matches the web at both granularities")
  func runsMatch() throws {
    let fixture: DiffCases = try Fixtures.load("diff-cases")
    #expect(!fixture.cases.isEmpty)
    for testCase in fixture.cases {
      let granularity = DiffGranularity(rawValue: testCase.granularity)!
      let runs = diffRuns(testCase.current, testCase.branch, granularity: granularity)
      #expect(
        runs.map(\.type.rawValue) == testCase.runs.map(\.type),
        "kinds for \(testCase.current.debugDescription) → \(testCase.branch.debugDescription) [\(testCase.granularity)]"
      )
      #expect(
        runs.map(\.text) == testCase.runs.map(\.text),
        "texts for \(testCase.current.debugDescription) → \(testCase.branch.debugDescription) [\(testCase.granularity)]"
      )
    }
  }

  @Test("hunk grouping and partial merges match the server's reconstruction")
  func hunksMatch() throws {
    let fixture: DiffCases = try Fixtures.load("diff-cases")
    for testCase in fixture.cases {
      let granularity = DiffGranularity(rawValue: testCase.granularity)!
      let runs = diffRuns(testCase.current, testCase.branch, granularity: granularity)
      let hunks = groupHunks(runs)
      #expect(hunks.map(\.index) == testCase.hunks.map(\.index))
      #expect(hunks.map(\.runIndices) == testCase.hunks.map(\.runIndices))
      #expect(applyAcceptedHunks(runs, []) == testCase.mergedNone)
      #expect(applyAcceptedHunks(runs, hunks.map(\.index)) == testCase.mergedAll)
      #expect(
        applyAcceptedHunks(runs, hunks.map(\.index).filter { $0 % 2 == 0 }) == testCase.mergedEven)
    }
  }

  @Test("accepting every hunk reproduces the branch text exactly")
  func acceptAllIsTheBranch() throws {
    let fixture: DiffCases = try Fixtures.load("diff-cases")
    for testCase in fixture.cases where testCase.granularity == "word" {
      let runs = diffRuns(testCase.current, testCase.branch)
      #expect(applyAcceptedHunks(runs, groupHunks(runs).map(\.index)) == testCase.branch)
      #expect(applyAcceptedHunks(runs, []) == testCase.current)
    }
  }

  @Test("the LCS line diff matches the web")
  func lineDiffMatches() throws {
    let fixture: DiffCases = try Fixtures.load("diff-cases")
    for testCase in fixture.lineCases {
      let lines = diffLines(testCase.current, testCase.branch)
      #expect(lines.map(\.type.rawValue) == testCase.lines.map(\.type))
      #expect(lines.map(\.text) == testCase.lines.map(\.text))
    }
  }

  @Test("tokenization keeps astral characters whole")
  func emojiTokens() {
    #expect(JSDiff.tokenizeWordsWithSpace("a 😀 b") == ["a", " ", "😀", " ", "b"])
    #expect(JSDiff.tokenizeWordsWithSpace("café naïve") == ["café", " ", "naïve"])
    #expect(JSDiff.tokenizeWordsWithSpace("x\r\ny") == ["x", "\r\n", "y"])
    #expect(JSDiff.tokenizeLines("a\r\nb\n") == ["a\r\n", "b\n"])
    #expect(JSDiff.tokenizeLines("") == [])
  }

  @Test("canonically equivalent but differently encoded text still diffs as changed")
  func noUnicodeNormalization() {
    // Swift's `==` says these are equal; JS `===` does not, and the web is the
    // authority for what counts as an edit.
    let precomposed = "café"
    let decomposed = "cafe\u{301}"
    #expect(precomposed == decomposed)
    let runs = diffRuns(precomposed, decomposed)
    #expect(runs.contains { $0.type != .same })
  }
}
