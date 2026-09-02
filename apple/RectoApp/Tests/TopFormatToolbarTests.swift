import AppKit
import RectoEditor
import SwiftUI
import Testing
@testable import Recto

@Suite("Formatting toolbar", .serialized)
@MainActor
struct TopFormatToolbarTests {
    private static let scratchSuite = "com.bhekani.recto.tests.format-toolbar"
    private let scratch: UserDefaults

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    @Test("the buttons are the web's INLINE_ACTIONS and BLOCK_ACTIONS, in order")
    func mirrorsWebActions() {
        #expect(TopFormatToolbar.inlineActions.map(\.id) == ["bold", "italic", "strike", "code", "link"])
        #expect(TopFormatToolbar.inlineActions.map(\.label) == [
            "Bold", "Italic", "Strikethrough", "Inline code", "Link",
        ])
        #expect(TopFormatToolbar.blockActions.map(\.id) == [
            "h1", "h2", "h3", "quote", "bulletList", "orderedList", "codeBlock",
        ])
        #expect(TopFormatToolbar.blockActions.map(\.label) == [
            "Heading 1", "Heading 2", "Heading 3", "Quote", "Bullet list", "Numbered list", "Code block",
        ])
        #expect(TopFormatToolbar.blockActions.map(\.command) == [
            .heading(level: 1), .heading(level: 2), .heading(level: 3), .blockquote,
            .bulletList, .orderedList, .codeBlock(language: ""),
        ])
    }

    @Test("every SF Symbol the toolbar names exists")
    func symbolsResolve() {
        for action in TopFormatToolbar.inlineActions + TopFormatToolbar.blockActions {
            guard case let .symbol(name) = action.glyph else { continue }
            #expect(NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil, "\(name)")
        }
    }

    @Test("the bar is live wherever the text is editable", arguments: Presentation.allCases)
    func enabledWhenEditable(presentation: Presentation) {
        #expect(TopFormatToolbar.isEnabled(in: presentation) == presentation.isEditable)
        #expect(TopFormatToolbar.isEnabled(in: .raw))
        #expect(!TopFormatToolbar.isEnabled(in: .preview))
    }

    /// The substring each button must leave in "hello" once it has run — the
    /// exact Markdown is the writing controls' own contract, tested there.
    private static let expectedMarkers: [String: String] = [
        "bold": "**hello**", "italic": "_hello_", "strike": "~~hello~~", "code": "`hello`",
        "h1": "# hello", "h2": "## hello", "h3": "### hello", "quote": "> hello",
        "bulletList": "- hello", "orderedList": "1. hello", "codeBlock": "```",
    ]

    @Test("each button runs its command through the writing controls and hands focus back",
          arguments: (TopFormatToolbar.inlineActions + TopFormatToolbar.blockActions).filter { $0.id != "link" },
          [Presentation.rich, .raw])
    func buttonsDispatch(action: FormatToolbarAction, presentation: Presentation) async throws {
        let mounted = try await mount("hello", presentation: presentation, id: "toolbar-\(action.id)-\(presentation.rawValue)")
        defer { mounted.window.close() }
        let textView = mounted.textView
        #expect(mounted.window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: 0, length: 5))

        mounted.chrome.formatToolbarActions.format(action.command)

        let marker = try #require(Self.expectedMarkers[action.id])
        #expect(mounted.storage.markdown.contains(marker), "\(action.id) produced \(mounted.storage.markdown)")
        #expect(mounted.storage.markdown != "hello")
        #expect(mounted.window.firstResponder === textView, "the editor keeps focus after a toolbar press")
    }

    @Test("bold on a selection edits the document and leaves the selection on the word")
    func boldKeepsSelection() async throws {
        let mounted = try await mount("hello world", presentation: .rich, id: "toolbar-bold-selection")
        defer { mounted.window.close() }
        let textView = mounted.textView
        #expect(mounted.window.makeFirstResponder(textView))
        textView.setSelectedRange(NSRange(location: 0, length: 5))

        mounted.chrome.formatToolbarActions.format(.bold)

        #expect(mounted.storage.markdown == "**hello** world")
        #expect(textView.string == "**hello** world")
        #expect(textView.selectedRange() == NSRange(location: 2, length: 5))
        #expect(mounted.window.firstResponder === textView)
    }

    @Test("in preview the buttons are inert")
    func inertInPreview() async throws {
        let mounted = try await mount("hello", presentation: .preview, id: "toolbar-inert-preview")
        defer { mounted.window.close() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 5))
        for action in TopFormatToolbar.inlineActions + TopFormatToolbar.blockActions {
            mounted.chrome.formatToolbarActions.format(action.command)
        }
        #expect(mounted.storage.markdown == "hello")
    }

    @Test("link asks for a destination instead of editing")
    func linkAsksFirst() async throws {
        let mounted = try await mount("hello", presentation: .rich, id: "toolbar-link")
        defer { mounted.window.close() }
        mounted.textView.setSelectedRange(NSRange(location: 0, length: 5))
        mounted.chrome.formatToolbarActions.format(.link(destination: ""))
        #expect(mounted.storage.markdown == "hello")
    }

    @Test("undo and redo go to the host's history")
    func undoRedoReachHost() async throws {
        var log: [String] = []
        let chrome = EditorHostController(settings: StudioSettings(defaults: scratch, systemAppearance: { .dark }))
        chrome.undo = { log.append("undo") }
        chrome.redo = { log.append("redo") }
        chrome.formatToolbarActions.undo()
        chrome.formatToolbarActions.redo()
        #expect(log == ["undo", "redo"])
    }

    @Test("spellcheck and typewriter settings reach the live text view")
    func settingsReachTextView() async throws {
        let mounted = try await mount("hello", presentation: .rich, id: "toolbar-settings")
        defer { mounted.window.close() }
        let textView = mounted.textView
        #expect(textView.isContinuousSpellCheckingEnabled)
        #expect(!mounted.chrome.typewriter.isEnabled)

        mounted.settings.toggleSpellcheck()
        mounted.settings.toggleTypewriter()
        mounted.chrome.applySettings()
        #expect(!textView.isContinuousSpellCheckingEnabled)
        #expect(!textView.isGrammarCheckingEnabled)
        #expect(mounted.chrome.typewriter.isEnabled)

        mounted.settings.toggleSpellcheck()
        mounted.chrome.applySettings()
        #expect(textView.isContinuousSpellCheckingEnabled)
    }

    // MARK: - Harness

    private struct Mounted {
        let settings: StudioSettings
        let chrome: EditorHostController
        let storage: RectoTextStorage
        let textView: NSTextView
        let window: NSWindow
    }

    private struct Host: View {
        let settings: StudioSettings
        let chrome: EditorHostController
        let storage: RectoTextStorage
        let presentation: Presentation

        var body: some View {
            let styler = settings.styler(presentation: presentation)
            VStack(spacing: 0) {
                TopFormatToolbar(theme: styler.theme, presentation: presentation, actions: chrome.formatToolbarActions)
                RectoEditorView(
                    storage: storage,
                    styler: styler,
                    onAttach: chrome.attach,
                    writingController: chrome.writingController
                )
                .frame(width: 720, height: 400)
            }
        }
    }

    private func mount(_ markdown: String, presentation: Presentation, id: String) async throws -> Mounted {
        _ = NSApplication.shared
        let settings = StudioSettings(defaults: scratch, systemAppearance: { .dark })
        let chrome = EditorHostController(settings: settings)
        let storage = RectoTextStorage(documentId: id, markdown: markdown)
        let host = NSHostingView(rootView: Host(
            settings: settings, chrome: chrome, storage: storage, presentation: presentation
        ))
        let window = NSWindow(contentViewController: NSViewController())
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        #expect(chrome.seam?.nsTextView === textView, "onAttach handed the seam to the host controller")
        return Mounted(settings: settings, chrome: chrome, storage: storage, textView: textView, window: window)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }
}
