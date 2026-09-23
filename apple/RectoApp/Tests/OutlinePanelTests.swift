import AppKit
import RectoCoreJS
import RectoEditor
import RectoStore
import SwiftUI
import Synchronization
import Testing

@testable import Recto

/// The panel's document parsing: once on appearance, then once per pause —
/// the outline is a whole-document JS-core call, so a keystroke costs nothing
/// until typing settles. Mirrors the status bar's word-count contract.
///
/// What a click does with the parsed headings (caret to the UTF-16 offset,
/// through the engine's scroll path) is pinned in the command-palette suite
/// against a mounted editor; the row itself is a button whose action is the
/// same `jump` closure the palette tests exercise.
@Suite("Outline panel", .serialized)
@MainActor
struct OutlinePanelTests {
    private struct Host: View {
        let storage: RectoTextStorage
        let settings: StudioSettings
        var parse: @Sendable (String) async throws -> [OutlineHeading]

        var body: some View {
            OutlinePanel(
                storage: storage,
                theme: .twilight,
                jump: { _ in },
                close: {},
                parse: parse
            )
            .frame(width: 320, height: 400)
        }
    }

    @Test("the first appearance parses at once; a burst parses once more after it settles")
    func typingBurstParsesOnce() async throws {
        _ = NSApplication.shared
        let calls = Mutex(0)
        let parse: @Sendable (String) async throws -> [OutlineHeading] = { markdown in
            calls.withLock { $0 += 1 }
            return Outline.parse(markdown)
        }
        let storage = RectoTextStorage(documentId: "outline-panel", markdown: "# One")
        let host = NSHostingView(rootView: Host(
            storage: storage,
            settings: StudioSettings(defaults: scratchDefaults(), systemAppearance: { .dark }),
            parse: parse
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        #expect(calls.withLock { $0 } == 1, "the first appearance parses at once")

        for keystroke in 0..<20 {
            storage.markdown = "# One\n\n## Two \(keystroke)"
            await drainMainQueue()
        }
        #expect(calls.withLock { $0 } == 1, "no parse runs while keys are still arriving")

        try await Task.sleep(for: .milliseconds(600))
        await drainMainQueue()
        let settled = calls.withLock { $0 }
        #expect(settled >= 1 && settled <= 2, "one parse after the burst settles, got \(settled)")
    }

    /// Empty, and emptied again on exit, so the test never reads or writes the
    /// developer's own studio settings.
    private func scratchDefaults() -> UserDefaults {
        let name = "com.bhekani.recto.tests.outline-panel"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}