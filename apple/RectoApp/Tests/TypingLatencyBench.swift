import AppKit
import RectoAuth
import RectoCore
import RectoStore
import RectoSync
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

/// Milliseconds per keystroke with the real editor host mounted: the insert,
/// the SwiftUI update it causes and the display pass. A measurement, not a
/// test — it asserts nothing and runs only when `RECTO_BENCH_DOC` names a
/// Markdown file. `apple/scripts/bench-typing.sh` sets it up.
@Suite("Typing latency bench", .serialized)
@MainActor
struct TypingLatencyBench {
    private final class DocumentBox {
        var value: RectoDocument
        init(_ markdown: String) { value = RectoDocument(markdown: markdown) }
    }

    private actor BenchTransport: RectoTransport {
        enum Failure: Error { case unexpectedCall }
        func createDocument(title: String, documentUuid: String) async throws
            -> CreateDocumentResponse { throw Failure.unexpectedCall }
        func commitEdit(_ request: CommitEditRequest) async throws
            -> CommitEditResponse { throw Failure.unexpectedCall }
        func updateCurrentNodeId(
            documentId: String, currentNodeId: String, markdown: String, wordCount: Int,
            updatedAt: Double, expectedPointerRevision: Double?, title: String?
        ) async throws -> UpdateCurrentNodeResponse { throw Failure.unexpectedCall }
        func updateMarkdown(
            documentId: String, markdown: String, wordCount: Int, expectedUpdatedAt: Double,
            expectedHeadNodeId: String?, title: String?
        ) async throws -> UpdateMarkdownResponse { throw Failure.unexpectedCall }
        func appendNode(documentId: String, node: CommitEditRequest) async throws {
            throw Failure.unexpectedCall
        }
        func rename(documentId: String, title: String) async throws { throw Failure.unexpectedCall }
        func remove(documentId: String) async throws { throw Failure.unexpectedCall }
        func recordWritingStat(date: String, words: Int) async throws { throw Failure.unexpectedCall }
        func listNodes(documentId: String, sinceCreatedAt: Double?) async throws -> [RemoteNode] { [] }
        func getDocument(documentId: String) async throws -> RemoteDocument? { nil }
        func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error> {
            AsyncThrowingStream { $0.finish() }
        }
        func nodesStream(documentId: String, sinceCreatedAt: Double?)
            -> AsyncThrowingStream<[RemoteNode], any Error> {
            AsyncThrowingStream { $0.finish() }
        }
        func loginFromCache() async -> Bool { false }
    }

    @Test("cloud bench")
    func cloudBench() async throws {
        guard let path = Self.document else { return }
        let markdown = try String(contentsOfFile: path, encoding: .utf8)
        _ = NSApplication.shared
        let store = try RectoStore.inMemory()
        let origin = try await SyncEngine.resolveOrigin(store: store)
        let sync = SyncEngine(store: store, transport: BenchTransport(), origin: origin)
        let registry = DocumentSessionRegistry(store: store, sync: sync, origin: origin)
        let library = DocumentLibrary(store: store, sync: sync, origin: origin)
        let document = try await library.createDocument(title: "Bench")
        let suite = "com.bhekani.recto.tests.bench"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let settings = StudioSettings(defaults: defaults, systemAppearance: { .dark })
        let host = NSHostingView(rootView: CloudDocumentView(
            localId: document.localId, registry: registry, settings: settings
        ).defaultAppStorage(defaults))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        var chrome: EditorHostController?
        for _ in 0..<300 where chrome?.seam?.nsTextView == nil {
            try await Task.sleep(for: .milliseconds(10))
            chrome = EditorHostRegistry.shared.controller(in: window)
        }
        let textView = try #require(chrome?.seam?.nsTextView)
        #expect(window.makeFirstResponder(textView))
        textView.insertText(markdown, replacementRange: NSRange(location: 0, length: 0))
        for _ in 0..<50 { await drain() }
        try await Task.sleep(for: .milliseconds(500))
        try await measure(textView, window, label: "CLOUD")
        window.orderOut(nil)
    }

    @Test("bench")
    func bench() async throws {
        guard let path = Self.document else { return }
        let markdown = try String(contentsOfFile: path, encoding: .utf8)
        _ = NSApplication.shared
        let document = DocumentBox(markdown)
        let storage = RectoTextStorage(documentId: "bench", markdown: markdown)
        let host = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document.value }, set: { document.value = $0 }),
            storage: storage))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        for _ in 0..<20 { await drain() }
        let textView = try #require(storage.textView.nsTextView)
        #expect(window.makeFirstResponder(textView))
        let middle = (textView.string as NSString).length / 2
        textView.setSelectedRange(NSRange(location: middle, length: 0))
        textView.scrollRangeToVisible(NSRange(location: middle, length: 0))
        for _ in 0..<5 { await drain() }
        try await measure(textView, window, label: "BENCH")
        window.orderOut(nil)
    }

    private func measure(_ textView: NSTextView, _ window: NSWindow, label: String) async throws {
        // RECTO_BENCH_FOCUS_BLUR=1: the same keystrokes with focus blur on.
        let blur = ProcessInfo.processInfo.environment["RECTO_BENCH_FOCUS_BLUR"] == "1"
        if let chrome = EditorHostRegistry.shared.controller(in: window), blur {
            chrome.settings.focusBlur = true
            chrome.applySettings()
        }
        defer {
            if blur, let chrome = EditorHostRegistry.shared.controller(in: window) {
                chrome.settings.focusBlur = false
                chrome.applySettings()
            }
        }
        let middle = (textView.string as NSString).length / 2
        textView.setSelectedRange(NSRange(location: middle, length: 0))
        textView.scrollRangeToVisible(NSRange(location: middle, length: 0))
        for _ in 0..<5 { await drain() }
        let keys = Int(ProcessInfo.processInfo.environment["RECTO_BENCH_KEYS"] ?? "") ?? 300
        var samples: [Double] = []
        let clock = ContinuousClock()
        let text = Array("The quick brown fox jumps over the lazy dog. ")
        for i in 0..<keys {
            let start = clock.now
            textView.insertText(String(text[i % text.count]), replacementRange: textView.selectedRange())
            await drain()
            window.displayIfNeeded()
            CATransaction.flush()
            samples.append((clock.now - start) / .milliseconds(1))
        }
        samples.sort()
        func q(_ p: Double) -> Double { samples[min(samples.count - 1, Int(Double(samples.count) * p))] }
        let line = label + String(format: " keys=%d p50=%.2fms p90=%.2fms p99=%.2fms max=%.2fms mean=%.2fms",
                          keys, q(0.5), q(0.9), q(0.99), samples.last ?? 0, samples.reduce(0, +) / Double(samples.count))
        print(line)
        if let out = ProcessInfo.processInfo.environment["RECTO_BENCH_OUT"], !out.isEmpty {
            let previous = (try? String(contentsOfFile: out, encoding: .utf8)) ?? ""
            try? (previous + line + "\n").write(toFile: out, atomically: true, encoding: .utf8)
        }
    }

    private static var document: String? {
        ProcessInfo.processInfo.environment["RECTO_BENCH_DOC"].flatMap { $0.isEmpty ? nil : $0 }
    }

    private func drain() async {
        await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
    }
}
