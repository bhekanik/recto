import Foundation
import Testing

@testable import RectoHistory

struct StreakCases: Decodable {
  struct StreakCase: Decodable {
    struct Stat: Decodable {
      let date: String
      let words: Int
    }
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
      #expect(currentStreak(stats, today: testCase.today) == testCase.streak, "\(testCase.today)")
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
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Africa/Johannesburg")!
    #expect(previousDateKey("2026-08-01", calendar: calendar) == "2026-07-31")
    #expect(previousDateKey("2026-01-01", calendar: calendar) == "2025-12-31")
    #expect(previousDateKey("2028-03-01", calendar: calendar) == "2028-02-29")
  }
}
