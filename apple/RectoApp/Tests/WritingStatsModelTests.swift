import Foundation
import RectoCoreJS
import RectoStore
import RectoSync
import Testing
@testable import Recto

/// The day's words and the streak: the `useWritingStats` side of the goal
/// widget, with the store, the server and the streak injected so nothing here
/// touches the developer's own stats.
@Suite("Writing stats", .serialized)
@MainActor
struct WritingStatsModelTests {
    private struct Entry: Equatable {
        let date: String
        let words: Int
    }

    @MainActor
    private final class FakeStore {
        var rows: [WritingStatRecord]
        var recorded: [Entry] = []
        init(_ rows: [WritingStatRecord]) { self.rows = rows }
    }

    private let today = WritingStatsModel.localDateKey()

    private func row(_ date: String, _ words: Int) -> WritingStatRecord {
        WritingStatRecord(date: date, words: words, updatedAt: 0, dirty: false)
    }

    /// A model over a fake store. The streak counts written days, enough to
    /// see which days the model handed over.
    private func model(_ rows: [WritingStatRecord], now: @escaping () -> Date = { Date() }) -> (WritingStatsModel, FakeStore) {
        let store = FakeStore(rows)
        let model = WritingStatsModel(now: now, streak: { days, _ in days.filter { $0.words > 0 }.count })
        model.install(
            read: { @MainActor in store.rows },
            record: { @MainActor date, words in
                store.recorded.append(Entry(date: date, words: words))
                if let index = store.rows.firstIndex(where: { $0.date == date }) {
                    store.rows[index].words = max(store.rows[index].words, words)
                } else {
                    store.rows.append(WritingStatRecord(date: date, words: words, updatedAt: 0, dirty: true))
                }
            }
        )
        return (model, store)
    }

    @Test("localDateKey is the local YYYY-MM-DD")
    func localDateKey() {
        var components = DateComponents()
        components.year = 2026
        components.month = 1
        components.day = 5
        #expect(WritingStatsModel.localDateKey(now: Calendar.current.date(from: components)!) == "2026-01-05")
    }

    @Test("today's words are the high-water of the record and the live count")
    func todayWordsAreHighWater() async throws {
        let (model, _) = model([row(today, 400)])
        try await waitUntil { model.persistedTodayWords == 400 }
        #expect(model.todayWords(liveDocumentWords: 300) == 400)
        #expect(model.todayWords(liveDocumentWords: 900) == 900)
    }

    @Test("days written on other devices merge in by the larger number")
    func remoteDaysMerge() async throws {
        let (model, _) = model([row("2026-01-01", 10), row(today, 100)])
        try await waitUntil { model.persistedTodayWords == 100 }
        let (stream, continuation) = AsyncThrowingStream<[RemoteWritingStat], any Error>.makeStream()
        model.followRemote(stream)
        continuation.yield([
            RemoteWritingStat(date: today, words: 250),
            RemoteWritingStat(date: "2026-01-02", words: 30),
        ])
        try await waitUntil { model.persistedTodayWords == 250 && model.streakDays == 3 }

        model.stopFollowingRemote()
        try await waitUntil { model.persistedTodayWords == 100 && model.streakDays == 2 }
        continuation.finish()
    }

    @Test("a flush records the day's high-water, only upward, then re-reads")
    func flushWritesHighWater() async throws {
        let (model, store) = model([row(today, 500)])
        try await waitUntil { model.persistedTodayWords == 500 }

        model.noteLiveWords(200)
        model.flush()
        try await Task.sleep(for: .milliseconds(50))
        #expect(store.recorded.isEmpty, "nothing below the recorded total is written")

        model.noteLiveWords(800)
        model.flush()
        try await waitUntil { model.persistedTodayWords == 800 }
        #expect(store.recorded == [Entry(date: today, words: 800)])
    }

    @Test("midnight flushes the old day and starts the new one at zero")
    func midnightRollsOver() async throws {
        var clock = Calendar.current.date(from: DateComponents(year: 2026, month: 3, day: 1, hour: 23, minute: 59))!
        let (model, store) = model([], now: { clock })
        model.noteLiveWords(300)
        clock = clock.addingTimeInterval(120)
        model.noteLiveWords(310)
        try await waitUntil { store.recorded.contains(Entry(date: "2026-03-01", words: 300)) }
        #expect(model.todayWords(liveDocumentWords: 0) == 0)
    }

    @Test("the shared core's streak matches the web's cases")
    func streakMatchesWeb() async throws {
        let core = try await SharedRectoCore.core()
        let today = "2026-06-17"
        func days(_ pairs: (String, Int)...) -> [WritingDay] {
            pairs.map { WritingDay(date: $0.0, words: $0.1) }
        }
        #expect(try await core.streak([], today: today) == 0)
        #expect(try await core.streak(days(("2026-06-17", 120)), today: today) == 1)
        #expect(try await core.streak(days(("2026-06-15", 200), ("2026-06-16", 200), ("2026-06-17", 200)), today: today) == 3)
        #expect(try await core.streak(days(("2026-06-15", 200), ("2026-06-16", 200)), today: today) == 2)
        #expect(try await core.streak(days(("2026-06-14", 200), ("2026-06-17", 200)), today: today) == 1)
        #expect(try await core.streak(days(("2026-06-15", 200), ("2026-06-16", 0), ("2026-06-17", 200)), today: today) == 1)
        #expect(try await core.streak(days(("2025-12-31", 200), ("2026-01-01", 200)), today: "2026-01-01") == 2)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: Duration = .seconds(2)) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            guard ContinuousClock.now < deadline else {
                Issue.record("timed out")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
