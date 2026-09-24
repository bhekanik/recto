import AppKit
import RectoCore
import RectoEditor
import RectoStore
import RectoSync
import SwiftUI
import Testing
@testable import Recto
@testable import RectoAuth

/// Open the app and type; reach the list, the text and every command without
/// the pointer.
@Suite("Keyboard navigation", .serialized)
@MainActor
struct KeyboardNavigationTests {
    private func signedInLibrary(documents: Int, key: Bool = true) async throws -> (RectoApplicationModel, NSWindow) {
        _ = NSApplication.shared
        let store = try RectoStore.inMemory()
        let origin = try await SyncEngine.resolveOrigin(store: store)
        let sync = SyncEngine(store: store, transport: OfflineTransport(), origin: origin)
        let registry = DocumentSessionRegistry(store: store, sync: sync, origin: origin)
        let library = DocumentLibrary(store: store, sync: sync, origin: origin)
        let auth = RectoAuth(store: store)
        auth.attach(sync: sync)
        auth.attach(sessions: registry)
        let model = RectoApplicationModel(components: .init(
            store: store, auth: auth, sync: sync, registry: registry, library: library))
        await model.start()
        auth.convexAuthProvider.activeSessionID = { "session-keyboard" }
        auth.convexAuthProvider.cachedLogin = { true }
        await auth.restoreSessionForTesting(userId: "keyboard")
        await sync.stop()
        for _ in 0..<documents { await model.createDocument() }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: RectoCloudRootView(model: model))
        if key { window.makeKeyAndOrderFront(nil) } else { window.orderFront(nil) }
        return (model, window)
    }

    private func editor(in window: NSWindow, notSameAs previous: NSTextView? = nil) async -> NSTextView? {
        for _ in 0..<300 {
            if let view = EditorHostRegistry.shared.controller(in: window)?.seam?.nsTextView,
               view !== previous, view.window === window { return view }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return nil
    }

    private func settle() async {
        for _ in 0..<5 {
            try? await Task.sleep(for: .milliseconds(20))
            await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
        }
    }

    private func until(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<150 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    @Test("the library opens with the keyboard in the text")
    func opensInTheText() async throws {
        let (_, window) = try await signedInLibrary(documents: 2)
        defer { window.orderOut(nil) }
        let text = try #require(await editor(in: window))
        #expect(await until { window.firstResponder === text }, "\(String(describing: window.firstResponder))")
        await settle()
        #expect(window.firstResponder === text, "nothing takes it back once the window settles")
    }

    @Test("the text keeps the keyboard when the window becomes key after it opened")
    func keyLater() async throws {
        // A launch: the window is on screen before the app is active, and
        // takes key status only when activation arrives.
        let (_, window) = try await signedInLibrary(documents: 2, key: false)
        defer { window.orderOut(nil) }
        let text = try #require(await editor(in: window))
        await settle()
        window.makeKeyAndOrderFront(nil)
        await settle()
        #expect(window.firstResponder === text, "\(String(describing: window.firstResponder))")
    }

    @Test("Go to document list, browse with the list focused, then back to the text")
    func listAndBack() async throws {
        let (model, window) = try await signedInLibrary(documents: 2)
        defer { window.orderOut(nil) }
        let first = try #require(await editor(in: window))
        #expect(await until { window.firstResponder === first })

        model.request(.focusDocuments)
        #expect(await until { window.firstResponder is NSTableView },
                "the list has the keyboard: \(String(describing: window.firstResponder))")
        #expect((window.firstResponder as? NSTableView)?.selectionHighlightStyle == NSTableView.SelectionHighlightStyle.none,
                "the row's accent wash is the selection, not the system's blue")

        // Browsing: another document opens in the pane, the list keeps the keyboard.
        let other = try #require(model.documents.first { $0.localId != model.selectedDocumentId })
        model.selectedDocumentId = other.localId
        let second = try #require(await editor(in: window, notSameAs: first))
        await settle()
        #expect(window.firstResponder is NSTableView, "arrowing through the list must not pull focus into the text")

        model.request(.focusEditor)
        #expect(await until { window.firstResponder === second })
    }

    @Test("Return in the list opens the highlighted document for writing")
    func returnInTheList() async throws {
        let (model, window) = try await signedInLibrary(documents: 2)
        defer { window.orderOut(nil) }
        let text = try #require(await editor(in: window))
        model.request(.focusDocuments)
        #expect(await until { window.firstResponder is NSTableView })

        let press = try #require(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, characters: "\r",
            charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        window.sendEvent(press)
        #expect(await until { window.firstResponder === text },
                "\(String(describing: window.firstResponder))")
    }

    @Test("Search documents puts the keyboard in the sidebar's search field")
    func searchField() async throws {
        let (model, window) = try await signedInLibrary(documents: 2)
        defer { window.orderOut(nil) }
        _ = try #require(await editor(in: window))
        model.request(.focusSearch)
        // A search field edits through the window's field editor.
        #expect(await until {
            ((window.firstResponder as? NSTextView)?.delegate as? NSSearchField) != nil
        }, "\(String(describing: window.firstResponder))")
    }

    @Test("a new document is ready to type in")
    func newDocumentTakesTheKeyboard() async throws {
        let (model, window) = try await signedInLibrary(documents: 1)
        defer { window.orderOut(nil) }
        let first = try #require(await editor(in: window))
        model.request(.focusDocuments)
        #expect(await until { window.firstResponder is NSTableView })

        await model.createDocument()
        let fresh = try #require(await editor(in: window, notSameAs: first))
        #expect(await until { window.firstResponder === fresh })
    }

    @Test("a file document's window opens with the keyboard in the text")
    func fileDocumentOpensInTheText() async throws {
        _ = NSApplication.shared
        var document = RectoDocument(markdown: "# Draft\n\nText.\n")
        let storage = RectoTextStorage(documentId: "keyboard-file", markdown: document.markdown)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: EditorHostView(
            document: Binding(get: { document }, set: { document = $0 }), storage: storage))
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil) }
        #expect(await until { storage.textView.nsTextView.map { window.firstResponder === $0 } ?? false })
    }

    @Test("no two menu items share a shortcut")
    func menuShortcutsAreUnique() throws {
        let menu = try #require(NSApp.mainMenu)
        var seen: [String: String] = [:]
        var clashes: [String] = []
        func walk(_ menu: NSMenu) {
            for item in menu.items {
                if let submenu = item.submenu { walk(submenu) }
                guard !item.keyEquivalent.isEmpty, !item.isAlternate else { continue }
                let flags = item.keyEquivalentModifierMask.intersection([.command, .option, .control, .shift])
                let key = "\(flags.rawValue)-\(item.keyEquivalent.lowercased())"
                if let other = seen[key] {
                    clashes.append("\(other) / \(item.title)")
                } else {
                    seen[key] = item.title
                }
            }
        }
        walk(menu)
        #expect(clashes.isEmpty, "\(clashes)")
        // The Format chords are on the menu, so they work in the text.
        #expect(seen.values.contains("Bold"))
        #expect(seen.values.contains("Heading 1"))
        // Every chord the palette advertises for a native command is real.
        let controlCommand = NSEvent.ModifierFlags([.control, .command]).rawValue
        #expect(seen["\(controlCommand)-1"] == "Go to document list")
        #expect(seen["\(controlCommand)-2"] == "Go to editor")
        #expect(seen["\(controlCommand)-s"] != nil, "the sidebar toggle")
    }
}

@Suite("Shortcut hints")
@MainActor
struct ShortcutHintTests {
    /// "⌘⇧Z" and "⇧⌘Z" are one chord: modifiers as a set, then the key.
    private static func normalized(_ glyphs: String) -> String {
        let modifiers = "⌃⌥⇧⌘".filter { glyphs.contains($0) }
        let key = glyphs.filter { !"⌃⌥⇧⌘".contains($0) }.uppercased()
        return modifiers + key
    }

    private static func menuChords() -> [String: String] {
        var chords: [String: String] = [:]
        func walk(_ menu: NSMenu) {
            for item in menu.items {
                if let submenu = item.submenu { walk(submenu) }
                guard !item.keyEquivalent.isEmpty else { continue }
                let flags = item.keyEquivalentModifierMask
                var glyphs = ""
                if flags.contains(.control) { glyphs += "⌃" }
                if flags.contains(.option) { glyphs += "⌥" }
                // AppKit stores ⇧⌘Z as "Z" with the shift flag, or as "Z" alone.
                if flags.contains(.shift) || item.keyEquivalent != item.keyEquivalent.lowercased() { glyphs += "⇧" }
                if flags.contains(.command) { glyphs += "⌘" }
                let key: String = switch item.keyEquivalent {
                case String(UnicodeScalar(NSRightArrowFunctionKey)!): "→"
                case String(UnicodeScalar(NSLeftArrowFunctionKey)!): "←"
                default: item.keyEquivalent
                }
                chords[normalized(glyphs + key)] = item.title
            }
        }
        if let menu = NSApp.mainMenu { walk(menu) }
        return chords
    }

    @Test("every chord a hint shows is one the menus answer")
    func hintsAreReal() {
        let chords = Self.menuChords()
        #expect(!chords.isEmpty, "the test host has the app's menus")
        // ⌘K opens the palette the hints are shown in; ⌘F is the find bar's
        // own key, answered by the text view.
        let answeredElsewhere: Set<String> = ["find-replace"]
        var missing: [String] = []
        for action in CommandRegistry.allActions where !answeredElsewhere.contains(action.id) {
            let chord = CommandRegistry.shortcut(for: action.id)
            guard !chord.isEmpty else { continue }
            if chords[Self.normalized(chord)] == nil { missing.append("\(action.id) \(chord)") }
        }
        #expect(missing.isEmpty, "\(missing)")
    }

    @Test("⌃⇧E opens the palette on the export commands")
    func exportChooser() {
        let name = "com.bhekani.recto.tests.shortcut-hints"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let settings = StudioSettings(defaults: defaults, systemAppearance: { .dark })
        let editor = EditorHostController(settings: settings)
        let model = PaletteModel(
            sections: CommandPaletteController.sections(settings: settings, library: PaletteLibrary(), editor: editor),
            run: { _ in }, close: {})
        model.query = "Export as"
        #expect(model.visibleItems.map(\.id) == ["export-md", "export-html"],
                "Word export needs a synced document, so this editor has two")
    }

    @Test("tooltips name the chord")
    func tooltips() {
        #expect(CommandRegistry.help("Bold", command: "format-bold") == "Bold (⌘B)")
        #expect(CommandRegistry.help("Bigger text", command: "zoom-in") == "Bigger text (⌘=)")
        #expect(CommandRegistry.help("Link", command: "format-link") == "Link")
    }
}

@Suite("Palette covers the whole app")
@MainActor
struct PaletteCoverageTests {
    private func settings() -> StudioSettings {
        let name = "com.bhekani.recto.tests.palette-coverage"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return StudioSettings(defaults: defaults, systemAppearance: { .dark })
    }

    @Test("every toolbar button is a Format command with the web's chord")
    func formatSection() {
        let editor = EditorHostController(settings: settings())
        editor.currentPresentation = { .rich }
        let sections = CommandPaletteController.sections(settings: settings(), library: PaletteLibrary(), editor: editor)
        let format = sections.first { $0.title == "Format" }
        #expect(format?.items.map(\.id) == FormatToolbarAction.all.map { "format-\($0.id)" })
        #expect(format?.items.first?.detail == .shortcut("⌘B"))
        #expect(CommandRegistry.action("format-strike")?.shortcut == "⌥⌘X")
        #expect(CommandRegistry.action("format-quote")?.shortcut == "⇧⌘B")
        #expect(CommandRegistry.action("format-link")?.shortcut == "", "⌘K is the palette")
    }

    @Test("Format hides where there is nothing to format")
    func formatHiddenInPreview() {
        let editor = EditorHostController(settings: settings())
        editor.currentPresentation = { .preview }
        let preview = CommandPaletteController.sections(settings: settings(), library: PaletteLibrary(), editor: editor)
        #expect(!preview.contains { $0.title == "Format" })
        let none = CommandPaletteController.sections(settings: settings(), library: PaletteLibrary())
        #expect(!none.contains { $0.title == "Format" })
    }

    @Test("the status bar's and sidebar's controls are all commands")
    func statusBarAndSidebar() {
        // Each control in the status bar and sidebar, by the command that does
        // the same thing.
        for id in [
            "mode-rich", "mode-raw", "mode-vim", "mode-preview",
            "appearance-system", "appearance-light", "appearance-dark", "theme-twilight",
            "toggle-font", "zoom-in", "zoom-out", "zoom-reset", "toggle-spellcheck", "toggle-lint",
            "toggle-typewriter", "toggle-focus-dim", "cycle-dim-scope", "set-goal", "toggle-focus",
            "open-in-web", "toggle-quiet-chrome",
            "new-document", "sign-out", "go-to-documents", "go-to-editor", "toggle-sidebar",
        ] {
            #expect(CommandRegistry.action(id) != nil, "\(id)")
        }
    }

    @Test("the library's keyboard commands reach the library")
    func libraryHooks() async {
        let controller = CommandPaletteController(settings: settings(), editors: EditorHostRegistry())
        var log: [String] = []
        let library = PaletteLibrary(
            isSignedIn: true,
            focusDocuments: { log.append("documents") },
            toggleSidebar: { log.append("sidebar") },
            signOut: { log.append("sign-out") })
        #expect(controller.perform("toggle-sidebar", editor: nil, library: library))
        #expect(controller.perform("sign-out", editor: nil, library: library))
        #expect(controller.perform("go-to-documents", editor: nil, library: library))
        // Deferred past the palette's close.
        await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
        try? await Task.sleep(for: .milliseconds(20))
        #expect(log == ["sidebar", "sign-out", "documents"])
    }
}
