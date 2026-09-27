import AppKit
import RectoCoreJS
import RectoEditor
import RectoStore
import RectoSync
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
        ("open-in-web", .documents, "Open in web app", ""),
        ("mode-rich", .modes, "Switch to Rich text", "⌃⇧R"),
        ("mode-raw", .modes, "Switch to Raw Markdown", "⌃⇧M"),
        ("mode-vim", .modes, "Switch to Vim", "⌃⇧V"),
        ("mode-preview", .modes, "Switch to Preview", "⌃⇧P"),
        ("cycle-next", .modes, "Cycle mode forward", "⌃⇧]"),
        ("cycle-prev", .modes, "Cycle mode backward", "⌃⇧["),
        ("format-bold", .format, "Bold", "⌘B"),
        ("format-italic", .format, "Italic", "⌘I"),
        ("format-strike", .format, "Strikethrough", "⌥⌘X"),
        ("format-code", .format, "Inline code", "⌘E"),
        ("format-link", .format, "Link", ""),
        ("format-h1", .format, "Heading 1", "⌥⌘1"),
        ("format-h2", .format, "Heading 2", "⌥⌘2"),
        ("format-h3", .format, "Heading 3", "⌥⌘3"),
        ("format-quote", .format, "Quote", "⇧⌘B"),
        ("format-bulletList", .format, "Bullet list", "⌥⌘8"),
        ("format-orderedList", .format, "Numbered list", "⌥⌘7"),
        ("format-codeBlock", .format, "Code block", ""),
        ("split-v", .panes, "Split pane — vertical", "⌘\\"),
        ("split-h", .panes, "Split pane — horizontal", "⌘⇧\\"),
        ("close-pane", .panes, "Close pane", "⌃⇧W"),
        ("focus-next", .panes, "Focus next pane", "⌃⇧→"),
        ("focus-prev", .panes, "Focus previous pane", "⌃⇧←"),
        ("go-to-heading", .navigate, "Go to heading…", "⌃⇧O"),
        ("toggle-outline", .navigate, "Toggle outline panel", ""),
        ("checkpoint", .history, "Create version / checkpoint", "⌘S"),
        ("undo-tree", .history, "Open undo-tree visualizer", "⌃⇧U"),
        ("version-history", .history, "Open version history", "⌃⇧H"),
        ("undo", .history, "Undo", "⌘Z"),
        ("redo", .history, "Redo", "⌘⇧Z"),
        ("manage-sharing", .review, "Manage sharing…", ""),
        ("review-surface", .review, "Review suggestions…", ""),
        ("toggle-comments", .review, "Toggle comments panel", ""),
        ("add-comment", .review, "Add comment on selection", ""),
        ("add-flag", .review, "Flag this spot…", "⌘⇧X"),
        ("toggle-notes", .review, "Toggle notes panel", "⌃⇧N"),
        ("toggle-notes-pin", .review, "Pin notes panel open", ""),
        ("ai-transform", .ai, "Transform selection with AI…", "⌃⇧I"),
        ("ai-critique", .ai, "AI review (comments)…", "⌃⇧J"),
        ("ai-related", .ai, "Related passages from past drafts…", "⌃⇧K"),
        ("ai-reindex", .ai, "Re-index this draft for search", ""),
        ("toggle-ai", .ai, "Toggle AI features", ""),
        ("toggle-transform-mode", .ai, "Toggle AI transform mode (pending/replace)", ""),
        ("copy-rich", .copyExport, "Copy as rich text", "⌘⇧C"),
        ("copy-markdown", .copyExport, "Copy as Markdown", "⌘⌥C"),
        ("export-md", .copyExport, "Export as .md", "⌃⇧E"),
        ("export-html", .copyExport, "Export as rich text (.html)", "⌃⇧E"),
        ("export-docx", .copyExport, "Export as Word (.docx)", "⌃⇧E"),
        ("find-replace", .view, "Find & replace", "⌘F"),
        ("toggle-status", .view, "Toggle word count / status bar", "⌃⇧S"),
        ("toggle-focus", .view, "Toggle zen mode", "⌃⇧F"),
        ("toggle-font", .view, "Toggle body font (sans / serif)", ""),
        ("zoom-in", .view, "Increase text size", ""),
        ("zoom-out", .view, "Decrease text size", ""),
        ("zoom-reset", .view, "Reset text size", ""),
        ("toggle-spellcheck", .view, "Toggle spellcheck", "⌘;"),
        ("toggle-lint-passive", .view, "Lint: toggle passive voice", ""),
        ("toggle-lint-readability", .view, "Lint: toggle readability", ""),
        ("toggle-lint-adverb", .view, "Lint: toggle adverbs", ""),
        ("toggle-lint-weasel", .view, "Lint: toggle weasel words", ""),
        ("toggle-smart-paste", .view, "Toggle smart paste (HTML → Markdown)", ""),
        ("toggle-toolbar", .view, "Toggle formatting toolbar", ""),
        ("toggle-typewriter", .view, "Toggle typewriter scrolling", "⌃⇧T"),
        ("toggle-focus-dim", .view, "Toggle focus dimming", "⌃⇧D"),
        ("toggle-focus-blur", .view, "Toggle focus blur", "⌃⇧B"),
        ("toggle-quiet-chrome", .view, "Toggle quiet chrome while typing", ""),
        ("cycle-dim-scope", .view, "Focus scope: sentence / paragraph", ""),
        ("toggle-email-preview", .view, "Toggle email/inbox preview", ""),
        ("set-goal", .view, "Set word goal…", ""),
        ("toggle-goal-style", .view, "Toggle goal display (ring / bar)", ""),
        ("toggle-goal-scope", .view, "Toggle goal scope (document / daily)", ""),
        ("appearance-system", .theme, "Appearance: Match system", ""),
        ("appearance-light", .theme, "Appearance: Light (Paper)", ""),
        ("appearance-dark", .theme, "Appearance: Dark", ""),
        ("theme-twilight", .theme, "Theme: Twilight", ""),
        ("theme-aurora", .theme, "Theme: Aurora", ""),
        ("theme-dawn", .theme, "Theme: Dawn", ""),
        ("theme-moonlit", .theme, "Theme: Moonlit", ""),
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
        #expect(CommandRegistry.action("open-in-web")?.aliases == ["browser", "website"])
        #expect(CommandRegistry.action("go-to-heading")?.aliases == ["outline", "jump", "heading", "section", "toc"])
        #expect(CommandRegistry.action("toggle-outline")?.aliases == ["outline", "table of contents", "toc", "sidebar"])
        #expect(CommandRegistry.action("copy-rich")?.aliases == ["html", "clipboard"])
        #expect(CommandRegistry.action("export-md")?.aliases == ["download markdown"])
        #expect(CommandRegistry.action("export-html")?.aliases == ["download html"])
        #expect(CommandRegistry.action("export-docx")?.aliases == ["download docx", "word"])
    }

    @Test("sections follow SECTION_ORDER and ids are unique")
    func orderAndUniqueness() {
        #expect(CommandSection.allCases.map(\.rawValue) == [
            "Documents", "Modes", "Format", "Panes", "Navigate", "History", "Review", "AI", "Copy/Export", "View",
            "Theme",
        ])
        let order = CommandRegistry.allActions.map { CommandSection.allCases.firstIndex(of: $0.section)! }
        #expect(order == order.sorted())
        #expect(Set(CommandRegistry.allActions.map(\.id)).count == CommandRegistry.allActions.count)
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

    @Test("signed out, Documents holds New document and Settings")
    func signedOutDocuments() {
        let sections = CommandPaletteController.sections(settings: settings(), library: PaletteLibrary())
        #expect(sections.first?.title == "Documents")
        #expect(sections.first?.items.map(\.id) == ["new-document", "open-settings"])
        #expect(sections.first?.items.first?.detail == .shortcut("⌘N"))
    }

    @Test("signed in, the library's documents follow New document with their word counts")
    func signedInDocuments() {
        let library = PaletteLibrary(isSignedIn: true, documents: [
            record("a", "Notes", words: 1_234), record("b", "Draft", words: 7),
        ])
        let documents = CommandPaletteController.sections(settings: settings(), library: library).first
        #expect(documents?.items.map(\.label) == [
            "New document", "Go to document list", "Search documents", "Toggle sidebar", "Settings…", "Sign out",
            "Notes", "Draft",
        ])
        #expect(documents?.items[6].kind == .document(localId: "a"))
        #expect(documents?.items[6].detail == .text("1,234 w"))
        #expect(documents?.items[6].searchValue == "document Notes")
    }

    @Test("Open in web app appears in Documents only when the handoff is available")
    func openInWebGatedByHandoff() {
        let available = PaletteLibrary(isSignedIn: true, documents: [
            record("a", "Notes", words: 1),
        ], canOpenInWeb: true)
        let shown = CommandPaletteController.sections(settings: settings(), library: available).first
        let native = ["go-to-documents", "search-documents", "toggle-sidebar", "open-settings", "sign-out"]
        #expect(shown?.items.map(\.id) == ["new-document", "open-in-web"] + native + ["document-a"])

        // An unsigned build, or a document with no convex id yet: the command
        // is absent rather than offered dead, so nothing lies about why.
        let unavailable = PaletteLibrary(isSignedIn: true, documents: [
            record("a", "Notes", words: 1),
        ], canOpenInWeb: false)
        let hidden = CommandPaletteController.sections(settings: settings(), library: unavailable).first
        #expect(hidden?.items.map(\.id) == ["new-document"] + native + ["document-a"])
    }

    @Test("sections come in SECTION_ORDER and empty ones are skipped")
    func sectionOrder() {
        let titles = CommandPaletteController.sections(settings: settings(), library: PaletteLibrary()).map(\.title)
        #expect(titles == ["Documents", "Modes", "Navigate", "History", "AI", "Copy/Export", "View", "Theme"])
    }

    @Test("the dark palette hides while the appearance resolves to light")
    func themeSectionFollowsAppearance() {
        let dark = CommandPaletteController.sections(settings: settings(systemAppearance: .dark), library: PaletteLibrary())
        #expect(dark.last?.items.map(\.id) == [
            "appearance-system", "appearance-light", "appearance-dark",
            "theme-twilight", "theme-aurora", "theme-dawn", "theme-moonlit",
        ])
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
        for action in CommandRegistry.allActions {
            #expect(controller.perform(action.id, editor: nil, library: library), "\(action.id)")
        }
        #expect(created == 1)
        #expect(!controller.perform("open-in-mac-app", editor: nil, library: library), "a web-only action has no native form")
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
        controller.perform("toggle-font", editor: nil, library: PaletteLibrary())
        #expect(settings.readingFont == .sans)
        controller.perform("theme-dawn", editor: nil, library: PaletteLibrary())
        #expect(settings.palette == .dawn)
        controller.perform("toggle-lint-adverb", editor: nil, library: PaletteLibrary())
        #expect(!settings.lintCategories.contains(.adverb))
        #expect(settings.lintCategories == [.passive, .readability, .weasel])
        controller.perform("toggle-focus-dim", editor: nil, library: PaletteLibrary())
        #expect(settings.focusDim)
        controller.perform("cycle-dim-scope", editor: nil, library: PaletteLibrary())
        #expect(settings.focusDimScope == .paragraph)
        controller.perform("toggle-smart-paste", editor: nil, library: PaletteLibrary())
        #expect(!settings.smartPaste)
        #expect(!settings.styler(presentation: .rich).convertsPastedHTML, "the toggle reaches the engine")
        controller.perform("toggle-email-preview", editor: nil, library: PaletteLibrary())
        #expect(settings.previewVariant == .email)
        controller.perform("toggle-goal-style", editor: nil, library: PaletteLibrary())
        #expect(settings.goalStyle == .bar)
        controller.perform("toggle-goal-scope", editor: nil, library: PaletteLibrary())
        #expect(settings.goalScope == .daily)
    }

    @Test("set-goal opens the goal panel over the editor's own window")
    func setGoalOpensPanel() async throws {
        let mounted = try await mount("# Goal\n", id: "palette-set-goal")
        defer { mounted.window.close() }
        let goals = GoalConfigController(settings: mounted.settings)
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard, goals: goals
        )
        #expect(controller.perform("set-goal", editor: mounted.chrome, library: PaletteLibrary()))
        try await waitUntil("the goal panel to open") { goals.isShown }
        goals.close()
        #expect(!goals.isShown)
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
        controller.perform("mode-preview", editor: editor, library: PaletteLibrary())
        mounted.chrome.currentPresentation = { .preview }
        controller.perform("cycle-next", editor: editor, library: PaletteLibrary())
        controller.perform("cycle-prev", editor: editor, library: PaletteLibrary())
        #expect(log == [
            "undo", "redo", "mode:raw", "mode:vim", "mode:rich", "mode:preview", "mode:rich", "mode:vim",
        ], "mode switches go to this window's lens, not a global")
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

    // MARK: - P3: navigate and export

    /// A stand-in for the generic call surface: `export-docx`'s palette
    /// gating only needs an `any RectoAPI` to exist; nothing on it is called.
    private actor UnusedAPI: RectoAPI {
        private func unused() -> RemoteCallError {
            RemoteCallError(code: nil, message: "the tests never call this")
        }

        func query<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
            throw unused()
        }

        func subscribe<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue])
            -> AsyncThrowingStream<T, any Error>
        {
            AsyncThrowingStream { $0.finish(throwing: unused()) }
        }

        func mutation<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
            throw unused()
        }

        func action<T: Decodable & Sendable>(_ name: String, args: [String: ConvexValue]) async throws -> T {
            throw unused()
        }
    }

    @Test("toggle-outline flips the setting both document hosts read")
    func toggleOutline() {
        let settings = settings()
        let controller = CommandPaletteController(
            settings: settings, editors: EditorHostRegistry(), pasteboard: pasteboard
        )
        #expect(!settings.showOutline)
        #expect(controller.perform("toggle-outline", editor: nil, library: PaletteLibrary()))
        #expect(settings.showOutline)
        controller.perform("toggle-outline", editor: nil, library: PaletteLibrary())
        #expect(!settings.showOutline)
    }

    /// The web's `export-docx` action renders the server's own markdown, so
    /// the palette offers it only where there is a server document to export —
    /// the same "absent rather than offered dead" posture as `open-in-web`.
    @Test("Export as Word appears only for a synced document with a convex id")
    func exportDocxGatedByCloudDocument() {
        let editor = EditorHostController(settings: settings())
        func copyExportIds() -> [String]? {
            CommandPaletteController.sections(settings: settings(), library: PaletteLibrary(), editor: editor)
                .first { $0.title == "Copy/Export" }?.items.map(\.id)
        }
        #expect(copyExportIds()?.contains("export-docx") == false, "a file document is local")
        editor.cloud = CloudDocumentContext(api: UnusedAPI(), convexId: nil)
        #expect(copyExportIds()?.contains("export-docx") == false, "no convex id until the first sync")
        editor.cloud = CloudDocumentContext(api: UnusedAPI(), convexId: "kd57")
        #expect(copyExportIds()?.contains("export-docx") == true)
        #expect(
            copyExportIds() == ["copy-rich", "copy-markdown", "export-md", "export-html", "export-docx"],
            "the web's Copy/Export order")
    }

    @Test("go-to-heading reopens the palette listing only headings, and a chosen heading moves the caret")
    func goToHeading() async throws {
        let mounted = try await mount("# One\n\n## Two\n\n### Three\n", id: "palette-go-to-heading")
        defer { mounted.window.close() }
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard
        )
        #expect(controller.perform("go-to-heading", editor: mounted.chrome, library: PaletteLibrary()))
        try await waitUntil("the headings palette to open") { controller.isOpen }
        let model = try #require(controller.model)
        #expect(model.visibleSections.map(\.title) == ["Headings"])
        #expect(model.visibleItems.map(\.label) == ["One", "Two", "Three"])
        #expect(model.visibleItems.map(\.detail) == [.text("H1"), .text("H2"), .text("H3")])

        model.moveSelection(by: 1)
        model.runSelected()
        #expect(!controller.isOpen, "running a heading closes the palette")
        try await waitUntil("the caret to move to “## Two”") {
            mounted.textView.selectedRange().location == 7
        }
        #expect(mounted.textView.selectedRange().location == 7, "UTF-16 offset of “## Two”")
    }

    @Test("a heading after frontmatter and an emoji lands on its own line")
    func goToHeadingAfterFrontmatter() async throws {
        // Offsets are UTF-16 into the whole source, frontmatter included, since
        // the editor's string is the source; an astral character before the
        // heading catches a port counting Characters instead.
        let markdown = "---\ntitle: Draft 😀\n---\n\nIntro 😀\n\n## Target\n"
        let mounted = try await mount(markdown, id: "palette-go-frontmatter")
        defer { mounted.window.close() }
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard
        )
        #expect(controller.perform("go-to-heading", editor: mounted.chrome, library: PaletteLibrary()))
        try await waitUntil("the headings palette to open") { controller.isOpen }
        let model = try #require(controller.model)
        #expect(model.visibleItems.map(\.label) == ["Target"])
        model.runSelected()
        let expected = (markdown as NSString).range(of: "## Target").location
        try await waitUntil("the caret to reach the heading") {
            mounted.textView.selectedRange().location == expected
        }
        #expect(mounted.textView.selectedRange().location == expected)
    }

    @Test("go-to-heading with no headings opens nothing; an empty heading keeps its row")
    func goToHeadingWithoutHeadings() async throws {
        let empty = try await mount("no headings here", id: "palette-go-empty")
        defer { empty.window.close() }
        let controller = CommandPaletteController(
            settings: empty.settings, editors: empty.registry, pasteboard: pasteboard
        )
        #expect(controller.perform("go-to-heading", editor: empty.chrome, library: PaletteLibrary()))
        try await Task.sleep(for: .milliseconds(400))
        #expect(!controller.isOpen, "an empty outline has nothing to jump to")

        let untitled = try await mount("# One\n\n##\n", id: "palette-go-untitled")
        defer { untitled.window.close() }
        let other = CommandPaletteController(
            settings: untitled.settings, editors: untitled.registry, pasteboard: pasteboard
        )
        #expect(other.perform("go-to-heading", editor: untitled.chrome, library: PaletteLibrary()))
        try await waitUntil("the headings palette to open") { other.isOpen }
        #expect(other.model?.visibleItems.map(\.label) == ["One", "(untitled heading)"])
    }

    @Test("copy-rich puts the rendered HTML and the Markdown source on the pasteboard")
    func copyRich() async throws {
        let mounted = try await mount("# Title\n\nbody", id: "palette-copy-rich")
        defer { mounted.window.close() }
        let controller = CommandPaletteController(
            settings: mounted.settings, editors: mounted.registry, pasteboard: pasteboard
        )
        #expect(controller.perform("copy-rich", editor: mounted.chrome, library: PaletteLibrary()))
        try await waitUntil("the HTML render to land") { self.pasteboard.string(forType: .html) != nil }
        #expect(pasteboard.string(forType: .html) == "<h1>Title</h1>\n<p>body</p>")
        #expect(pasteboard.string(forType: .string) == "# Title\n\nbody", "the Markdown source rides along")
    }

    // MARK: - Harness

    /// Polls the main queue until `condition` holds; the heading finder and
    /// copy-rich reach the JS core off the main thread, so a single
    /// `drainMainQueue` is not a wait long enough to see them land.
    private func waitUntil(_ description: String, _ condition: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            await drainMainQueue()
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("timed out waiting for \(description)")
    }

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
