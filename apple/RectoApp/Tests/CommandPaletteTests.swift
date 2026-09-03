import AppKit
import RectoEditor
import RectoStore
import SwiftUI
import Testing
@testable import Recto

@Suite("Command registry")
struct CommandRegistryTests {
    /// The native subset of `lib/keyboard/actions.ts`, by hand: id, section,
    /// label, mac hint as macOS glyphs. Reading the TypeScript at test time
    /// would tie the suite to the web checkout; this is the contract instead.
    private static let expected: [(String, CommandSection, String, String)] = [
        ("new-document", .documents, "New document", "⌘N"),
        ("mode-rich", .modes, "Switch to Rich text", "⌃⇧R"),
        ("mode-raw", .modes, "Switch to Raw Markdown", "⌃⇧M"),
        ("mode-vim", .modes, "Switch to Vim", "⌃⇧V"),
        ("undo", .history, "Undo", "⌘Z"),
        ("redo", .history, "Redo", "⌘⇧Z"),
        ("copy-markdown", .copyExport, "Copy as Markdown", "⌘⌥C"),
        ("find-replace", .view, "Find & replace", "⌘F"),
        ("toggle-status", .view, "Toggle word count / status bar", "⌃⇧S"),
        ("zoom-in", .view, "Increase text size", ""),
        ("zoom-out", .view, "Decrease text size", ""),
        ("zoom-reset", .view, "Reset text size", ""),
        ("toggle-spellcheck", .view, "Toggle spellcheck", ""),
        ("toggle-toolbar", .view, "Toggle formatting toolbar", ""),
        ("toggle-typewriter", .view, "Toggle typewriter scrolling", "⌃⇧T"),
        ("appearance-system", .theme, "Appearance: Match system", ""),
        ("appearance-light", .theme, "Appearance: Light (Paper)", ""),
        ("appearance-dark", .theme, "Appearance: Dark", ""),
        ("theme-twilight", .theme, "Theme: Twilight", ""),
    ]

    @Test("the registry is exactly the expected native subset, in the web's order")
    func matchesSnapshot() {
        let actual = CommandRegistry.actions.map { ($0.id, $0.section, $0.label, $0.shortcut) }
        #expect(actual.count == Self.expected.count)
        for (action, expected) in zip(actual, Self.expected) {
            #expect(action == expected, "\(action.0)")
        }
    }

    @Test("aliases are the web's")
    func aliases() {
        #expect(CommandRegistry.action("mode-raw")?.aliases == ["markdown", "source", "raw"])
        #expect(CommandRegistry.action("mode-vim")?.aliases == ["modal"])
        #expect(CommandRegistry.action("find-replace")?.aliases == ["search", "replace", "regex", "find"])
        #expect(CommandRegistry.action("appearance-dark")?.aliases == ["dark", "night", "twilight"])
        #expect(CommandRegistry.action("undo")?.aliases == [])
    }

    @Test("sections follow SECTION_ORDER and ids are unique")
    func orderAndUniqueness() {
        #expect(CommandSection.allCases.map(\.rawValue) == [
            "Documents", "Modes", "Panes", "Navigate", "History", "Review", "AI", "Copy/Export", "View", "Theme",
        ])
        let order = CommandRegistry.actions.map { CommandSection.allCases.firstIndex(of: $0.section)! }
        #expect(order == order.sorted())
        #expect(Set(CommandRegistry.actions.map(\.id)).count == CommandRegistry.actions.count)
    }
}

@Suite("Palette model")
@MainActor
struct PaletteModelTests {
    private final class Log {
        var ran: [String] = []
        var closed = 0
    }

    private func item(_ id: String, _ label: String, value: String? = nil) -> PaletteItem {
        PaletteItem(id: id, kind: .action(id), label: label, detail: nil, searchValue: value ?? label)
    }

    private func sections() -> [PaletteSection] {
        [
            PaletteSection(title: "Documents", items: [item("new", "New document", value: "New document create add Documents")]),
            PaletteSection(title: "Modes", items: [
                item("rich", "Switch to Rich text", value: "Switch to Rich text wysiwyg rich Modes"),
                item("raw", "Switch to Raw Markdown", value: "Switch to Raw Markdown markdown source raw Modes"),
            ]),
            PaletteSection(title: "View", items: [item("find", "Find & replace", value: "Find & replace search replace regex find View")]),
        ]
    }

    private func model(_ log: Log) -> PaletteModel {
        PaletteModel(sections: sections(), run: { log.ran.append($0.id) }, close: { log.closed += 1 })
    }

    @Test("an empty query shows everything, in section order")
    func emptyShowsAll() {
        let model = model(Log())
        #expect(model.visibleSections == sections())
        #expect(model.selectedItem?.id == "new")
        model.query = "   "
        #expect(model.visibleItems.count == 4)
    }

    @Test("matching is a case-insensitive substring over label, aliases and section")
    func substringMatch() {
        let model = model(Log())
        model.query = "WYSI"
        #expect(model.visibleItems.map(\.id) == ["rich"])
        model.query = "modes"
        #expect(model.visibleItems.map(\.id) == ["rich", "raw"], "the section name matches too")
        #expect(model.visibleSections.map(\.title) == ["Modes"])
        model.query = "regex"
        #expect(model.visibleItems.map(\.id) == ["find"])
        model.query = "r"
        #expect(model.visibleSections.map(\.title) == ["Documents", "Modes", "View"], "section order survives filtering")
    }

    @Test("no match leaves an empty list and no selection")
    func noMatches() {
        let log = Log()
        let model = model(log)
        model.query = "zzz"
        #expect(!model.hasMatches)
        #expect(model.selectedItem == nil)
        model.runSelected()
        #expect(log.ran.isEmpty)
        #expect(log.closed == 0)
    }

    @Test("a new query resets the selection to the first match")
    func queryResetsSelection() {
        let model = model(Log())
        model.moveSelection(by: 2)
        #expect(model.selectedItem?.id == "raw")
        model.query = "switch"
        #expect(model.selectedItem?.id == "rich")
    }

    @Test("arrow keys wrap at both ends like cmdk's loop")
    func selectionWraps() {
        let model = model(Log())
        model.moveSelection(by: -1)
        #expect(model.selectedItem?.id == "find")
        model.moveSelection(by: 1)
        #expect(model.selectedItem?.id == "new")
        model.moveSelection(by: 5)
        #expect(model.selectedItem?.id == "rich")
    }

    @Test("Return runs the selection and closes; a click runs that row")
    func runsThenCloses() {
        let log = Log()
        let model = model(log)
        model.moveSelection(by: 1)
        model.runSelected()
        #expect(log.ran == ["rich"])
        #expect(log.closed == 1)

        let find = model.visibleItems.first { $0.id == "find" }!
        model.select(find)
        #expect(model.selectedItem?.id == "find")
        model.run(find)
        #expect(log.ran == ["rich", "find"])
        #expect(log.closed == 2)

        model.cancel()
        #expect(log.ran.count == 2)
        #expect(log.closed == 3)
    }
}

@Suite("Command palette", .serialized)
@MainActor
struct CommandPaletteControllerTests {
    private static let scratchSuite = "com.bhekani.recto.tests.command-palette"
    private let scratch: UserDefaults
    private let pasteboard = NSPasteboard(name: NSPasteboard.Name("com.bhekani.recto.tests.command-palette"))

    init() throws {
        scratch = try #require(UserDefaults(suiteName: Self.scratchSuite))
        scratch.removePersistentDomain(forName: Self.scratchSuite)
    }

    private func settings(systemAppearance: StudioSettings.ResolvedAppearance = .dark) -> StudioSettings {
        StudioSettings(defaults: scratch, systemAppearance: { systemAppearance })
    }

    private func record(_ localId: String, _ title: String, words: Int) -> DocumentRecord {
        DocumentRecord(
            localId: localId, title: title, markdown: "", wordCount: words,
            localHeadNodeId: "head-\(localId)", updatedAt: 0, createdAt: 0
        )
    }

    @Test("signed out, Documents holds only New document")
    func signedOutDocuments() {
        let sections = CommandPaletteController.sections(settings: settings(), library: PaletteLibrary())
        #expect(sections.first?.title == "Documents")
        #expect(sections.first?.items.map(\.id) == ["new-document"])
        #expect(sections.first?.items.first?.detail == .shortcut("⌘N"))
    }

    @Test("signed in, the library's documents follow New document with their word counts")
    func signedInDocuments() {
        let library = PaletteLibrary(isSignedIn: true, documents: [
            record("a", "Notes", words: 1_234), record("b", "Draft", words: 7),
        ])
        let documents = CommandPaletteController.sections(settings: settings(), library: library).first
        #expect(documents?.items.map(\.label) == ["New document", "Notes", "Draft"])
        #expect(documents?.items[1].kind == .document(localId: "a"))
        #expect(documents?.items[1].detail == .text("1,234 w"))
        #expect(documents?.items[1].searchValue == "document Notes")
    }

    @Test("sections come in SECTION_ORDER and empty ones are skipped")
    func sectionOrder() {
        let titles = CommandPaletteController.sections(settings: settings(), library: PaletteLibrary()).map(\.title)
        #expect(titles == ["Documents", "Modes", "History", "Copy/Export", "View", "Theme"])
    }

    @Test("the dark palette hides while the appearance resolves to light")
    func themeSectionFollowsAppearance() {
        let dark = CommandPaletteController.sections(settings: settings(systemAppearance: .dark), library: PaletteLibrary())
        #expect(dark.last?.items.map(\.id) == ["appearance-system", "appearance-light", "appearance-dark", "theme-twilight"])
        let light = CommandPaletteController.sections(settings: settings(systemAppearance: .light), library: PaletteLibrary())
        #expect(light.last?.items.map(\.id) == ["appearance-system", "appearance-light", "appearance-dark"])
    }

    @Test("every registered action has a native implementation")
    func everyActionRuns() {
        let controller = CommandPaletteController(
            settings: settings(), editors: EditorHostRegistry(), pasteboard: pasteboard
        )
        var created = 0
        let library = PaletteLibrary(isSignedIn: true, create: { created += 1 })
        for action in CommandRegistry.actions {
            #expect(controller.perform(action.id, editor: nil, library: library), "\(action.id)")
        }
        #expect(created == 1)
        #expect(!controller.perform("split-v", editor: nil, library: library))
    }

    @Test("settings actions land where the status bar reads them")
    func settingsActions() {
        let settings = settings()
        let controller = CommandPaletteController(
            settings: settings, editors: EditorHostRegistry(), pasteboard: pasteboard
        )
        controller.perform("zoom-in", editor: nil, library: PaletteLibrary())
        #expect(settings.readingScale == 1.1)
        controller.perform("toggle-status", editor: nil, library: PaletteLibrary())
        #expect(!settings.showStatusBar)
        controller.perform("appearance-light", editor: nil, library: PaletteLibrary())
        #expect(settings.appearance == .light)
        controller.perform("toggle-typewriter", editor: nil, library: PaletteLibrary())
        #expect(settings.typewriter)
    }

    @Test("editor actions reach the editor in the window ⌘K was pressed in")
    func editorActions() async throws {
        let mounted = try await mount("# Title\n\nbody", id: "palette-editor")
        defer { mounted.window.close() }
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard
        )
        var log: [String] = []
        mounted.chrome.undo = { log.append("undo") }
        mounted.chrome.redo = { log.append("redo") }
        mounted.chrome.choosePresentation = { log.append("mode:\($0.rawValue)") }
        let editor = mounted.registry.controller(in: mounted.window)
        #expect(editor === mounted.chrome)
        #expect(mounted.registry.controller(in: nil) == nil)

        controller.perform("undo", editor: editor, library: PaletteLibrary())
        controller.perform("redo", editor: editor, library: PaletteLibrary())
        controller.perform("mode-raw", editor: editor, library: PaletteLibrary())
        controller.perform("mode-vim", editor: editor, library: PaletteLibrary())
        controller.perform("mode-rich", editor: editor, library: PaletteLibrary())
        #expect(log == ["undo", "redo", "mode:raw", "mode:vim", "mode:rich"], "mode switches go to this window's lens, not a global")
        controller.perform("copy-markdown", editor: editor, library: PaletteLibrary())
        #expect(pasteboard.string(forType: .string) == "# Title\n\nbody")
    }

    @Test("⌘K floats a key panel over the window and hands the keyboard back on close")
    func opensAndCloses() async throws {
        let mounted = try await mount("hello", id: "palette-window")
        defer { mounted.window.close() }
        let textView = mounted.textView
        #expect(mounted.window.makeFirstResponder(textView))
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard
        )

        controller.open(over: mounted.window, library: PaletteLibrary())
        let panel = try #require(controller.panelWindow)
        #expect(controller.isOpen)
        #expect(panel.parent === mounted.window)
        #expect(panel.isVisible)
        #expect(panel.canBecomeKey)
        #expect(mounted.window.firstResponder === textView, "the editor never gives up first responder")
        let content = try #require(mounted.window.contentView)
        let expected = mounted.window.convertToScreen(content.convert(content.bounds, to: nil))
        #expect(panel.frame == expected)

        controller.open(over: mounted.window, library: PaletteLibrary())
        #expect(controller.panelWindow === panel, "a second ⌘K keeps the one palette")

        controller.close()
        #expect(!controller.isOpen)
        #expect(!panel.isVisible)
        #expect(panel.parent == nil)
        #expect(mounted.window.firstResponder === textView)
        controller.close()
    }

    /// P2-3: when the palette closes because another window took the
    /// keyboard, that window keeps it; the parent gets it back only when the
    /// palette closed on its own or the app went away. Key status is not real
    /// in the test host (the app is not active), so the decision is driven
    /// through the resign-key entry point with a window that counts `makeKey`.
    @Test("closing because another window took key leaves that window key")
    func otherWindowKeepsKey() async throws {
        let mounted = try await mount("hello", id: "palette-other-window")
        defer { mounted.window.close() }
        let parent = mounted.window
        let other = NSWindow(contentViewController: NSViewController())
        other.isReleasedWhenClosed = false
        defer { other.close() }
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard
        )

        controller.open(over: parent, library: PaletteLibrary())
        parent.makeKeyCalls = 0
        controller.paletteDidResignKey(to: other)
        #expect(!controller.isOpen, "losing key is the dismissal")
        #expect(parent.makeKeyCalls == 0, "the parent must not take key back from the window the writer chose")

        controller.open(over: parent, library: PaletteLibrary())
        let panel = try #require(controller.panelWindow)
        parent.makeKeyCalls = 0
        controller.paletteDidResignKey(to: panel)
        #expect(!controller.isOpen)
        #expect(parent.makeKeyCalls == 1)

        controller.open(over: parent, library: PaletteLibrary())
        parent.makeKeyCalls = 0
        controller.paletteDidResignKey(to: nil)
        #expect(!controller.isOpen)
        #expect(parent.makeKeyCalls == 1, "the app deactivated: the parent is where it comes back to")

        controller.open(over: parent, library: PaletteLibrary())
        parent.makeKeyCalls = 0
        controller.close()
        #expect(parent.makeKeyCalls == 1, "Esc/Return/scrim hand the keyboard back")
    }

    /// P3: ⌘K in a popover or in Settings must not size the palette to that
    /// window; it goes over the editor's host, or over the library.
    @Test("the palette targets the editor's window, its popover's host, or the library")
    func surfaceWindow() async throws {
        let mounted = try await mount("hello", id: "palette-surface")
        defer { mounted.window.close() }
        let registry = mounted.registry
        #expect(registry.surfaceWindow(for: mounted.window) === mounted.window)

        let popover = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 100, height: 50), styleMask: [.borderless],
                               backing: .buffered, defer: false)
        popover.isReleasedWhenClosed = false
        mounted.window.addChildWindow(popover, ordered: .above)
        defer { mounted.window.removeChildWindow(popover); popover.close() }
        #expect(registry.surfaceWindow(for: popover) === mounted.window, "a popover's host holds the editor")

        let settingsWindow = NSWindow(contentViewController: NSViewController())
        settingsWindow.isReleasedWhenClosed = false
        defer { settingsWindow.close() }
        #expect(registry.surfaceWindow(for: settingsWindow) == nil, "no editor, no library: nowhere to go")
        #expect(registry.surfaceWindow(for: nil) == nil)

        let library = NSWindow(contentViewController: NSViewController())
        library.isReleasedWhenClosed = false
        library.setContentSize(NSSize(width: 400, height: 300))
        library.orderFront(nil)
        defer { library.close() }
        registry.libraryWindow = library
        #expect(registry.surfaceWindow(for: settingsWindow) === library)

        let controller = CommandPaletteController(settings: mounted.settings, editors: registry, pasteboard: pasteboard)
        controller.open(over: settingsWindow, library: PaletteLibrary())
        defer { controller.close() }
        #expect(controller.panelWindow?.parent === library, "over Settings the palette opens on the library")
    }

    /// P2-4: the mode chords live in the View menu, so they dispatch through
    /// the registry to whichever editor is in the key window — status bar or not.
    @Test("mode chords reach the key window's editor when the status bar is hidden")
    func modeChordsWithoutStatusBar() async throws {
        let mounted = try await mount("hello", id: "palette-mode-chords")
        defer { mounted.window.close() }
        mounted.settings.toggleStatusBar()
        #expect(!mounted.settings.showStatusBar)
        var chosen: [Presentation] = []
        mounted.chrome.choosePresentation = { chosen.append($0) }

        mounted.registry.choosePresentation(.raw, in: mounted.window)
        mounted.registry.choosePresentation(.vim, in: mounted.window)
        mounted.registry.choosePresentation(.rich, in: mounted.window)
        #expect(chosen == [.raw, .vim, .rich])

        let other = NSWindow(contentViewController: NSViewController())
        other.isReleasedWhenClosed = false
        defer { other.close() }
        mounted.registry.choosePresentation(.raw, in: other)
        mounted.registry.choosePresentation(.raw, in: nil)
        #expect(chosen == [.raw, .vim, .rich], "a window without an editor gets nothing")
    }

    @Test("closing the parent window closes the palette")
    func parentCloseClosesPalette() async throws {
        let mounted = try await mount("hello", id: "palette-parent-close")
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard
        )
        controller.open(over: mounted.window, library: PaletteLibrary())
        #expect(controller.isOpen)
        mounted.window.close()
        #expect(!controller.isOpen)
    }

    // MARK: - Harness

    private struct Mounted {
        let settings: StudioSettings
        let registry: EditorHostRegistry
        let chrome: EditorHostController
        let textView: NSTextView
        let window: KeySpyWindow
    }

    /// Counts `makeKey()`: in the test host no window is ever really key, so
    /// the call is the only evidence of who was handed the keyboard.
    private final class KeySpyWindow: NSWindow {
        var makeKeyCalls = 0

        override func makeKey() {
            makeKeyCalls += 1
            super.makeKey()
        }
    }

    private struct Host: View {
        let settings: StudioSettings
        let chrome: EditorHostController
        let storage: RectoTextStorage

        var body: some View {
            RectoEditorView(
                storage: storage,
                styler: settings.styler(presentation: .rich),
                onAttach: chrome.attach,
                writingController: chrome.writingController
            )
            .frame(width: 720, height: 400)
        }
    }

    private func mount(_ markdown: String, id: String) async throws -> Mounted {
        _ = NSApplication.shared
        let settings = settings()
        let registry = EditorHostRegistry()
        let chrome = EditorHostController(settings: settings, registry: registry)
        let storage = RectoTextStorage(documentId: id, markdown: markdown)
        let host = NSHostingView(rootView: Host(settings: settings, chrome: chrome, storage: storage))
        let window = KeySpyWindow(contentViewController: NSViewController())
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        host.layoutSubtreeIfNeeded()
        await drainMainQueue()
        let textView = try #require(storage.textView.nsTextView)
        return Mounted(settings: settings, registry: registry, chrome: chrome, textView: textView, window: window)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                continuation.resume()
            }
        }
    }
}
