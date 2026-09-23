import Observation
import RectoCoreJS
import RectoEditor
import SwiftUI

/// Counts prose words in a markdown string. Injected so a test can watch how
/// often the tracker recounts; the app uses `WordCount.count`.
typealias WordCounter = @Sendable (String) -> Int

/// One window's word count and the words written since it opened: what the
/// status bar shows, the goal widget measures and the day's total records.
/// Owned by the host rather than the status bar, so hiding the bar (or zen)
/// stops none of it.
@MainActor
@Observable
final class DocumentWordCount {
    /// `nil` until the first count lands.
    private(set) var value: Int?
    /// The first count seen, the web's per-document session baseline.
    private(set) var sessionBaseline: Int?

    /// The web's `sessionWords`: never negative, so deleting what was there
    /// before the session reads as zero, not a debt.
    var sessionWords: Int {
        guard let value, let sessionBaseline else { return 0 }
        return max(value - sessionBaseline, 0)
    }

    func update(_ count: Int) {
        if sessionBaseline == nil { sessionBaseline = count }
        value = count
    }
}

/// The counting, as a zero-size view the host keeps mounted.
///
/// `WordCount.count` takes ~7 ms on an 85k-character document in Release and
/// the editor's whole per-keystroke budget is 8 ms, so the count never runs
/// synchronously with an edit: once at appearance, then once per 200 ms pause,
/// off the main thread. Taking the storage (not its string) keeps the host's
/// body, and the editor's update pass with it, out of the keystroke path: only
/// this view observes the text.
struct WordCountTracker: View {
    let storage: RectoTextStorage
    let count: DocumentWordCount
    var counter: WordCounter = WordCount.count
    /// Runs after each count lands, e.g. to fold it into the day's total.
    var onCount: (Int) -> Void = { _ in }

    var body: some View {
        let markdown = storage.markdown
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: MarkdownBytes(markdown)) {
                if count.value == nil {
                    let first = counter(markdown)
                    count.update(first)
                    onCount(first)
                    return
                }
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                let markdown = markdown
                let counter = counter
                let next = await Task.detached(priority: .utility) { counter(markdown) }.value
                guard !Task.isCancelled else { return }
                count.update(next)
                onCount(next)
            }
    }
}

/// Equality by bytes, the way `RectoTextStorage` compares: an unchanged string
/// is a pointer check, a changed one a length check before any memcmp.
private struct MarkdownBytes: Equatable {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.value as NSString).isEqual(to: rhs.value)
    }
}
