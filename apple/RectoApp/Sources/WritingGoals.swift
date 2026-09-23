import Foundation

/// Direction of a word goal — `GoalKind` in `lib/stats/streak.ts`.
enum GoalKind: String, CaseIterable, Sendable {
    case atLeast = "at-least"
    case about
    case atMost = "at-most"

    /// The `goal-popover.tsx` labels, in its order.
    var label: String {
        switch self {
        case .atLeast: "At least"
        case .about: "About"
        case .atMost: "At most"
        }
    }
}

/// Which goal the status-bar widget tracks — `GoalScope` in
/// `settings-schema.ts`.
enum GoalScope: String, CaseIterable, Sendable {
    case document, daily

    /// The `goal-popover.tsx` labels.
    var label: String {
        self == .document ? "Document" : "Daily"
    }

    var next: GoalScope { self == .document ? .daily : .document }
}

/// Goal widget shape — `GoalStyle` in `settings-schema.ts`.
enum GoalStyle: String, CaseIterable, Sendable {
    case ring, bar

    /// The `goal-popover.tsx` labels.
    var label: String {
        self == .ring ? "Ring" : "Bar"
    }

    var next: GoalStyle { self == .ring ? .bar : .ring }
}

/// Progress toward a goal — `GoalProgress` in `lib/stats/streak.ts`. Swift
/// port rather than a JS call because the widget reads it on every count.
struct GoalProgress: Equatable, Sendable {
    /// Clamped 0…1 for the ring/bar fill.
    let ratio: Double
    /// Goal satisfied?
    let met: Bool
    /// Words to go (>= 0); 0 once met.
    let remaining: Int
}

enum WritingGoals {
    /// "about" goals count as met within this fractional band of the target
    /// (±10%), the web's `ABOUT_BAND`.
    static let aboutBand = 0.1

    /// `clampGoalTarget` in `settings-schema.ts`: a goal target is a
    /// non-negative integer, 0 meaning no goal.
    static func clampTarget(_ value: Double) -> Int {
        guard value.isFinite else { return 0 }
        return Int(max(0, value.rounded()))
    }

    /// `goalProgress` in `lib/stats/streak.ts`, ported exactly: ratio and
    /// remaining are the same for every kind; only the `met` rule differs.
    static func progress(words: Int, target: Int, kind: GoalKind) -> GoalProgress {
        guard target > 0 else {
            return GoalProgress(ratio: 0, met: false, remaining: 0)
        }
        let ratio = min(1, max(0, Double(words) / Double(target)))
        let remaining = max(target - words, 0)
        let met: Bool
        switch kind {
        case .atLeast:
            met = words >= target
        case .about:
            met = abs(Double(words) - Double(target)) <= Double(target) * aboutBand
        case .atMost:
            met = words <= target
        }
        return GoalProgress(ratio: ratio, met: met, remaining: remaining)
    }
}