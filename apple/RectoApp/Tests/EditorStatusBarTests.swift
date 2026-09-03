import AppKit
import RectoCoreJS
import RectoEditor
import RectoStore
import SwiftUI
import Synchronization
import Testing
@testable import Recto

@Suite("Editor status bar", .serialized)
@MainActor
struct EditorStatusBarTests {
    private struct Host: View {
        let storage: RectoTextStorage
        let settings: StudioSettings
        let counter: WordCounter

        var body: some View {
            EditorStatusBar(
                presentation: .rich,
                isEditable: true,
                storage: storage,
                settings: settings,
                theme: .twilight,
                wordCounter: counter,
                onSelect: { _ in }
            )
        }
    }

    /// Counting a long document costs more than a keystroke may, so the label
    /// counts once on appearance and then once per pause, not once per edit.
    @Test("a typing burst on a 10k-word document counts at most twice")
    func typingBurstCountsOnce() async throws {
        _ = NSApplication.shared
        let calls = Mutex(0)
        let counter: WordCounter = { markdown in
            calls.withLock { $0 += 1 }
            return WordCount.count(markdown)
        }
        let paragraph = Array(repeating: "lorem ipsum dolor sit amet consectetur adipiscing elit", count: 8)
            .joined(separator: " ")
        let storage = RectoTextStorage(
            documentId: "status-bar",
            markdown: Array(repeating: paragraph, count: 160).joined(separator: "\n\n")
        )
        #expect(WordCount.count(storage.markdown) == 10_240)

        let host = NSHostingView(rootView: Host(
            storage: storage,
            settings: StudioSettings(defaults: scratchDefaults(), systemAppearance: { .dark }),
            counter: counter
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        #expect(calls.withLock { $0 } == 1, "the first appearance counts at once")

        for keystroke in 0..<20 {
            storage.markdown += " k\(keystroke)"
            await drainMainQueue()
        }
        #expect(calls.withLock { $0 } == 1, "no count runs while keys are still arriving")

        try await Task.sleep(for: .milliseconds(600))
        await drainMainQueue()
        let settled = calls.withLock { $0 }
        #expect(settled >= 1 && settled <= 2, "one count after the burst settles, got \(settled)")
    }

    @Test("sync labels match the web: Saving, Saved, Unsynced, Not synced")
    func syncLabelsMatchTheWeb() {
        #expect(SyncIndicator.label(state: .synced, pendingCount: 0) == "Saved")
        #expect(SyncIndicator.label(state: .pending, pendingCount: 0) == "Saving")
        #expect(SyncIndicator.label(state: .syncing, pendingCount: 0) == "Saving")
        #expect(SyncIndicator.label(state: .failed, pendingCount: 0) == "Unsynced")
        #expect(SyncIndicator.label(state: .diverged, pendingCount: 0) == "Not synced")
        #expect(SyncIndicator.label(state: .synced, pendingCount: 1) == "Saving")
        #expect(SyncIndicator.label(state: .diverged, pendingCount: 1) == "Saving")
        #expect(SyncIndicator.label(state: .failed, pendingCount: 1) == "Saving")
    }

    @Test("the sync indicator's rendered width is identical across every SyncState and pendingCount 0/1")
    func syncIndicatorWidthIsStable() {
        _ = NSApplication.shared
        let samples: [(SyncState, Int)] = [
            (.synced, 0), (.synced, 1),
            (.pending, 0), (.pending, 1),
            (.syncing, 0), (.syncing, 1),
            (.diverged, 0), (.diverged, 1),
            (.failed, 0), (.failed, 1),
        ]
        let widths = samples.map { measureSyncIndicator(state: $0.0, pendingCount: $0.1) }
        let first = widths[0]
        #expect(first > 0)
        for (index, width) in widths.enumerated() {
            #expect(
                abs(width - first) < 0.5,
                "sample \(index) was \(width), first was \(first)"
            )
        }
    }

    private func measureSyncIndicator(state: SyncState, pendingCount: Int) -> CGFloat {
        let host = NSHostingView(rootView: SyncIndicator(
            state: state,
            pendingCount: pendingCount,
            theme: .twilight
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.width
    }

    /// Empty, and emptied again on exit, so the test never reads or writes the
    /// developer's own studio settings.
    private func scratchDefaults() -> UserDefaults {
        let name = "com.bhekani.recto.tests.status-bar"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }
}
