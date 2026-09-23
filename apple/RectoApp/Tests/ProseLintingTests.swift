import AppKit
import RectoCoreJS
import RectoEditor
import SwiftUI
import Synchronization
import Testing
@testable import Recto

@Suite("Prose lint", .serialized)
@MainActor
struct ProseLintingTests {
    private struct Host: View {
        let storage: RectoTextStorage
        let settings: StudioSettings
        let decorations: RectoDecorationController
        let result: ProseLint
        let linter: LintTracker.Linter

        var body: some View {
            LintTracker(
                storage: storage, settings: settings, decorations: decorations,
                result: result, isLintable: true, linter: linter)
        }
    }

    @Test("findings reach the decorations and the count after the pause; off clears them")
    func lintsAfterPause() async throws {
        _ = NSApplication.shared
        let calls = Mutex<[[LintCategory]]>([])
        let linter: LintTracker.Linter = { markdown, categories in
            calls.withLock { $0.append(categories) }
            let word = (markdown as NSString).range(of: "very")
            return [LintIssue(from: word.location, to: NSMaxRange(word), category: "weasel", message: "weasel word", text: "very")]
        }
        let settings = StudioSettings(defaults: scratchDefaults(), systemAppearance: { .dark })
        settings.toggleLint()
        settings.toggleLintCategory(.passive)
        let storage = RectoTextStorage(documentId: "lint", markdown: "It is very good.")
        let decorations = RectoDecorationController()
        let result = ProseLint()
        let host = NSHostingView(rootView: Host(
            storage: storage, settings: settings, decorations: decorations, result: result, linter: linter))
        host.layoutSubtreeIfNeeded()

        await drainMainQueue()
        #expect(calls.withLock { $0.isEmpty }, "nothing runs before the 400 ms pause")
        try await Task.sleep(for: .milliseconds(600))
        await drainMainQueue()
        #expect(decorations.lintMarks == [.init(range: NSRange(location: 6, length: 4), category: "weasel", message: "weasel word")])
        #expect(result.count == 1)
        #expect(calls.withLock { $0.last } == [.readability, .adverb, .weasel], "only the enabled categories")

        settings.toggleLint()
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        await drainMainQueue()
        #expect(decorations.lintMarks.isEmpty)
        #expect(result.count == 0)
    }

    private func scratchDefaults() -> UserDefaults {
        let name = "com.bhekani.recto.tests.prose-lint"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    @Test("the shared core's linter skips code, as the web's does")
    func realLinterMasksCode() async throws {
        let issues = try await SharedRectoCore.core().lint(
            "```\nthe file is written by the build and is really very slow\n```\n\nThe cat sat.")
        #expect(issues.isEmpty)
    }
}
