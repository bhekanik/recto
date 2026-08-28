import Foundation

/// Pure streak/goal math — port of `lib/stats/streak.ts` (plan 002).
///
/// Streak semantics ("count only days you write — off-days don't break-shame"):
/// a streak is the run of consecutive *written* calendar days (words > 0)
/// counting back from `today`, except `today` itself may be unwritten — you have
/// not necessarily written yet today, so an unwritten today does not reset it.
public struct DailyStat: Equatable, Sendable {
  public var date: String  // local "YYYY-MM-DD"
  public var words: Int

  public init(date: String, words: Int) {
    self.date = date
    self.words = words
  }
}

/// Local "YYYY-MM-DD" for a date. Local time, not UTC — the web computes the key
/// client-side and the server stores whatever it is sent.
public func localDateKey(_ date: Date = Date(), calendar: Calendar = .current) -> String {
  let parts = calendar.dateComponents([.year, .month, .day], from: date)
  func pad(_ value: Int, _ width: Int) -> String {
    let digits = String(value)
    return String(repeating: "0", count: max(0, width - digits.count)) + digits
  }
  return "\(pad(parts.year ?? 1970, 4))-\(pad(parts.month ?? 1, 2))-\(pad(parts.day ?? 1, 2))"
}

private func daysInMonth(year: Int, month: Int) -> Int {
  if month == 2 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    return leap ? 29 : 28
  }
  return (month == 4 || month == 6 || month == 9 || month == 11) ? 30 : 31
}

/// The local date key one calendar day before `key`.
///
/// Pure string/integer arithmetic, with no `Date` and no `Calendar`: `key` is
/// already a local calendar date, so stepping it must not consult a clock or a
/// timezone. Going through a date and subtracting 24 h lands on the wrong
/// calendar day wherever DST makes the local day 23 hours long — in
/// America/Sao_Paulo, 2018-11-05 local midnight minus 24 h is 2018-11-03 23:00,
/// which reads back as 2018-11-03, skips 2018-11-04 and silently breaks a
/// streak. `lib/stats/streak.ts` does exactly this arithmetic, so the two
/// clients agree by construction rather than by fixture.
func previousDateKey(_ key: String) -> String {
  let parts = key.split(separator: "-").map { Int($0) ?? 0 }
  var year = parts.count > 0 ? parts[0] : 1970
  var month = parts.count > 1 ? parts[1] : 1
  var day = (parts.count > 2 ? parts[2] : 1) - 1
  if day < 1 {
    month -= 1
    if month < 1 {
      month = 12
      year -= 1
    }
    day = daysInMonth(year: year, month: month)
  }
  func pad2(_ value: Int) -> String { value < 10 ? "0\(value)" : String(value) }
  return "\(year)-\(pad2(month))-\(pad2(day))"
}

/// Current streak length counting back from `today`, counting only days with
/// words > 0.
public func currentStreak(_ stats: [DailyStat], today: String) -> Int {
  let written = Set(stats.filter { $0.words > 0 }.map(\.date))
  guard !written.isEmpty else { return 0 }

  var cursor = written.contains(today) ? today : previousDateKey(today)
  var streak = 0
  while written.contains(cursor) {
    streak += 1
    cursor = previousDateKey(cursor)
  }
  return streak
}

public enum GoalKind: String, Sendable, CaseIterable {
  case atLeast = "at-least"
  case about
  case atMost = "at-most"
}

public struct GoalProgress: Equatable, Sendable {
  public var ratio: Double  // clamped 0...1 for the ring/bar fill
  public var met: Bool
  public var remaining: Int  // words to go; 0 once met
}

/// "about" goals count as met within ±10% of the target.
private let aboutBand = 0.1

public func goalProgress(words: Int, target: Int, kind: GoalKind) -> GoalProgress {
  guard target > 0 else { return GoalProgress(ratio: 0, met: false, remaining: 0) }

  let ratio = min(1, max(0, Double(words) / Double(target)))
  let remaining = max(target - words, 0)
  let met: Bool
  switch kind {
  case .atLeast: met = words >= target
  case .about: met = abs(Double(words - target)) <= Double(target) * aboutBand
  case .atMost: met = words <= target
  }
  return GoalProgress(ratio: ratio, met: met, remaining: remaining)
}
