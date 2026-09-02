import AppKit
import RectoCoreJS
import RectoEditor
import SwiftUI
import Synchronization
import Testing
@testable import Recto

@Suite("Editor status bar", .serialized)
@MainActor
struct EditorStatusBarTests {
    private struct Host: View {
        let storage: RectoTextStorage
        let counter: WordCounter

        var body: some View {
            EditorStatusBar(
                presentation: .rich,
                isEditable: true,
                storage: storage,
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

        let host = NSHostingView(rootView: Host(storage: storage, counter: counter))
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

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }
}
