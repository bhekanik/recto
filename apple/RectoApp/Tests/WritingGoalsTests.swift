import Testing
@testable import Recto

/// `goalProgress` in `lib/stats/streak.ts`, ported to `WritingGoals.progress` —
/// these are the `goalProgress` cases from `streak.test.ts`, mirrored exactly.
@Suite("Word goals")
struct WritingGoalsTests {
    @Test("at-least: below target → not met, correct ratio/remaining")
    func atLeastBelow() {
        let progress = WritingGoals.progress(words: 850, target: 1000, kind: .atLeast)
        #expect(progress == GoalProgress(ratio: 0.85, met: false, remaining: 150))
    }

    @Test("at-least: at/over target → met, ratio 1, remaining 0")
    func atLeastAtOrOver() {
        #expect(WritingGoals.progress(words: 1000, target: 1000, kind: .atLeast)
            == GoalProgress(ratio: 1, met: true, remaining: 0))
        #expect(WritingGoals.progress(words: 1500, target: 1000, kind: .atLeast)
            == GoalProgress(ratio: 1, met: true, remaining: 0))
    }

    @Test("at-most: under target → met")
    func atMostUnder() {
        #expect(WritingGoals.progress(words: 400, target: 500, kind: .atMost)
            == GoalProgress(ratio: 0.8, met: true, remaining: 100))
    }

    @Test("at-most: over target → not met, ratio 1, remaining 0")
    func atMostOver() {
        #expect(WritingGoals.progress(words: 600, target: 500, kind: .atMost)
            == GoalProgress(ratio: 1, met: false, remaining: 0))
    }

    @Test("about: within ±10% band → met")
    func aboutWithinBand() {
        #expect(WritingGoals.progress(words: 950, target: 1000, kind: .about).met)
        #expect(WritingGoals.progress(words: 1100, target: 1000, kind: .about).met)
    }

    @Test("about: outside band → not met")
    func aboutOutsideBand() {
        #expect(!WritingGoals.progress(words: 800, target: 1000, kind: .about).met)
        #expect(!WritingGoals.progress(words: 1200, target: 1000, kind: .about).met)
    }

    @Test("target <= 0 → no goal")
    func noGoal() {
        #expect(WritingGoals.progress(words: 500, target: 0, kind: .atLeast)
            == GoalProgress(ratio: 0, met: false, remaining: 0))
        #expect(WritingGoals.progress(words: 500, target: -10, kind: .atLeast)
            == GoalProgress(ratio: 0, met: false, remaining: 0))
    }

    /// `clampGoalTarget` in `settings-schema.ts`: non-negative integer, 0 = no
    /// goal; NaN and infinities collapse to 0 rather than trapping.
    @Test("targets clamp to non-negative integers", arguments: [
        (0.0, 0), (12.4, 12), (12.5, 13), (-50.0, 0),
        (Double.nan, 0), (Double.infinity, 0),
    ])
    func targetClamping(value: Double, expected: Int) {
        #expect(WritingGoals.clampTarget(value) == expected)
    }

    /// The popover's labels and the toggles' cycles, in the web's order.
    @Test("labels and cycles match the web")
    func labelsAndCycles() {
        #expect(GoalKind.allCases.map(\.label) == ["At least", "About", "At most"])
        #expect(GoalScope.allCases.map(\.label) == ["Document", "Daily"])
        #expect(GoalStyle.allCases.map(\.label) == ["Ring", "Bar"])
        var style = GoalStyle.ring
        style = style.next
        #expect(style == .bar)
        var scope = GoalScope.document
        scope = scope.next
        #expect(scope == .daily)
        // The raw values are the web's strings, which is what persists.
        #expect(GoalKind.atLeast.rawValue == "at-least")
        #expect(GoalKind.atMost.rawValue == "at-most")
    }
}