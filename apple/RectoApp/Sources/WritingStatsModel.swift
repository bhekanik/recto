import Foundation
import Observation
import RectoCoreJS
import RectoStore
import RectoSync

/// The writer's daily word totals and the streak over them: the native
/// `useWritingStats`. The day's total is a high-water mark (the store and
/// `writingStats.record` both keep the larger number), the live document
/// count counts toward it, and the flush is coarse (~30 s) so the write never
/// sits on the typing path.
///
/// Two sources, merged per day by the larger number, as the web reads its one:
/// this Mac's store, which works offline and whose rows the sync engine pushes,
/// and the server's `writingStats:list`, which carries the days written on
/// other devices. Without the second a streak kept on the web would read as
/// broken here.
@MainActor
@Observable
final class WritingStatsModel {
    static let shared = WritingStatsModel()

    /// Local calendar key "YYYY-MM-DD", the web's `localDateKey`.
    nonisolated static func localDateKey(now: Date = Date()) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The day's recorded high-water across both sources.
    private(set) var persistedTodayWords = 0
    /// The streak over every written day, `RectoCore.streak`.
    private(set) var streakDays = 0

    @ObservationIgnored private var read: (@Sendable () async throws -> [WritingStatRecord])?
    @ObservationIgnored private var record: (@Sendable (_ date: String, _ words: Int) async -> Void)?
    @ObservationIgnored private let streak: @Sendable ([WritingDay], String) async throws -> Int
    @ObservationIgnored private let now: () -> Date

    @ObservationIgnored private var localDays: [String: Int] = [:]
    @ObservationIgnored private var remoteDays: [String: Int] = [:]
    @ObservationIgnored private var todayKey: String
    /// The day's high-water awaiting its debounced flush.
    @ObservationIgnored private var pendingTodayWords = 0
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var reloadTask: Task<Void, Never>?
    @ObservationIgnored private var remoteTask: Task<Void, Never>?
    @ObservationIgnored private var streakTask: Task<Void, Never>?

    init(
        now: @escaping () -> Date = { Date() },
        streak: @escaping @Sendable ([WritingDay], String) async throws -> Int = { days, today in
            try await SharedRectoCore.core().streak(days, today: today)
        }
    ) {
        self.now = now
        self.streak = streak
        todayKey = WritingStatsModel.localDateKey(now: now())
    }

    /// Point the model at this Mac's store. Until then (early launch, a signed-out
    /// app, a test) the live count still drives `todayWords`; nothing persists.
    func install(
        read: @escaping @Sendable () async throws -> [WritingStatRecord],
        record: @escaping @Sendable (_ date: String, _ words: Int) async -> Void
    ) {
        self.read = read
        self.record = record
        reload()
    }

    /// Follow the server's totals while signed in. A Convex subscription ends
    /// for good on an auth error, so the app calls this again on every sign-in.
    func followRemote(_ days: AsyncThrowingStream<[RemoteWritingStat], any Error>) {
        remoteTask?.cancel()
        remoteTask = Task { [weak self] in
            do {
                for try await stats in days {
                    guard let self else { return }
                    self.remoteDays = Dictionary(
                        stats.map { ($0.date, Int($0.words)) }, uniquingKeysWith: max)
                    self.recompute()
                }
            } catch {
                // Signed out or offline: keep the last server answer and the
                // local days; the next sign-in subscribes again.
            }
        }
    }

    func stopFollowingRemote() {
        remoteTask?.cancel()
        remoteTask = nil
        remoteDays = [:]
        recompute()
    }

    /// The day's words for the daily goal, the web's `dailyWords`: the recorded
    /// high-water, or the live document count while it is higher.
    func todayWords(liveDocumentWords: Int) -> Int {
        max(persistedTodayWords, liveDocumentWords)
    }

    /// Re-read this Mac's days and recompute.
    func reload() {
        guard let read else { return }
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            let records = (try? await read()) ?? []
            guard let self, !Task.isCancelled else { return }
            self.localDays = Dictionary(
                records.map { ($0.date, $0.words) }, uniquingKeysWith: max)
            self.recompute()
        }
    }

    /// Fold a debounced document count into the day's high-water. Called by the
    /// window's word counter after its own debounce, never per keystroke.
    func noteLiveWords(_ words: Int) {
        rollDayIfNeeded()
        pendingTodayWords = max(pendingTodayWords, words)
        guard pendingTodayWords > persistedTodayWords else { return }
        flushTask?.cancel()
        // The web's ~30 s: a streak needs day granularity only.
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    /// Write the day's high-water now: a closing window, the app going inactive,
    /// or the debounce firing. A late or repeated flush is harmless; the store
    /// keeps the larger number.
    func flush() {
        flushTask?.cancel()
        flushTask = nil
        let words = pendingTodayWords
        guard let record, words > (localDays[todayKey] ?? 0) else { return }
        let key = todayKey
        Task { [weak self] in
            await record(key, words)
            self?.reload()
        }
    }

    /// Midnight can pass with a window open; the day starts over rather than
    /// crediting yesterday's words to today.
    private func rollDayIfNeeded() {
        let key = WritingStatsModel.localDateKey(now: now())
        guard key != todayKey else { return }
        flush()
        todayKey = key
        pendingTodayWords = 0
        recompute()
    }

    private func recompute() {
        let merged = localDays.merging(remoteDays, uniquingKeysWith: max)
        persistedTodayWords = merged[todayKey] ?? 0
        pendingTodayWords = max(pendingTodayWords, persistedTodayWords)
        let days = merged.map { WritingDay(date: $0.key, words: $0.value) }
        let today = todayKey
        let compute = streak
        streakTask?.cancel()
        streakTask = Task { [weak self] in
            let count = (try? await compute(days, today)) ?? 0
            guard let self, !Task.isCancelled else { return }
            if count != self.streakDays { self.streakDays = count }
        }
    }
}
