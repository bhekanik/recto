import Foundation
import Testing

@testable import RectoHistory

struct StreakCases: Decodable {
  struct StreakCase: Decodable {
    struct Stat: Decodable {
      let date: String
      let words: Int
    }
    let name: String
    let stats: [Stat]
    let today: String
    let streak: Int
  }
  struct GoalCase: Decodable {
    struct Progress: Decodable {
      let ratio: Double
      let met: Bool
      let remaining: Int
    }
    let words: Int
    let target: Int
    let kind: String
    let progress: Progress
  }
  let streaks: [StreakCase]
  let goals: [GoalCase]
}

@Suite("streak parity with lib/stats/streak.ts")
struct StreakTests {
  @Test("streak lengths match the web")
  func streaks() throws {
    let fixture: StreakCases = try Fixtures.load("streak-cases")
    for testCase in fixture.streaks {
      let stats = testCase.stats.map { DailyStat(date: $0.date, words: $0.words) }
      #expect(currentStreak(stats, today: testCase.today) == testCase.streak, "\(testCase.name)")
    }
  }

  @Test("goal progress matches the web")
  func goals() throws {
    let fixture: StreakCases = try Fixtures.load("streak-cases")
    for testCase in fixture.goals {
      let progress = goalProgress(
        words: testCase.words, target: testCase.target,
        kind: GoalKind(rawValue: testCase.kind)!)
      #expect(abs(progress.ratio - testCase.progress.ratio) < 1e-9)
      #expect(progress.met == testCase.progress.met)
      #expect(progress.remaining == testCase.progress.remaining)
    }
  }

  @Test("date keys step back across month, year and leap boundaries")
  func dateArithmetic() {
    #expect(previousDateKey("2026-08-01") == "2026-07-31")
    #expect(previousDateKey("2026-01-01") == "2025-12-31")
    #expect(previousDateKey("2028-03-01") == "2028-02-29")
    #expect(previousDateKey("2026-03-01") == "2026-02-28")
  }

  @Test("stepping a date key never consults a timezone")
  func timezoneIndependent() {
    // The bug this replaces: local midnight minus 86_400_000 ms lands on
    // 2018-11-03 in America/Sao_Paulo, skipping 2018-11-04 and breaking the
    // streak. `lib/stats/streak.ts` now does the same string arithmetic, so the
    // clients agree by construction.
    #expect(previousDateKey("2018-11-05") == "2018-11-04")
    #expect(previousDateKey("2026-11-02") == "2026-11-01")

    let stats = [
      DailyStat(date: "2018-11-04", words: 10),
      DailyStat(date: "2018-11-05", words: 10),
    ]
    #expect(currentStreak(stats, today: "2018-11-05") == 2)
  }
}

