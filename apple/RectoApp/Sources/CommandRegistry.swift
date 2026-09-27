/// The palette's sections, in the web's `SECTION_ORDER`, plus Format, which
/// is native only: the web formats from its toolbar and Milkdown's chords,
/// the Mac from the palette too.
enum CommandSection: String, CaseIterable, Sendable {
    case documents = "Documents"
    case modes = "Modes"
    case format = "Format"
    case panes = "Panes"
    case navigate = "Navigate"
    case history = "History"
    case review = "Review"
    case ai = "AI"
    case copyExport = "Copy/Export"
    case view = "View"
    case theme = "Theme"
}

/// One entry of `lib/keyboard/actions.ts`: same id, label, aliases and
/// section; the shortcut is the web's mac hint written with macOS glyphs
/// (`Ctrl+⇧+R` → `⌃⇧R`), empty when the web has none.
struct CommandAction: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let section: CommandSection
    let aliases: [String]
    let shortcut: String
}

/// The native subset of the web's `ACTIONS`: every action the Mac app can
/// carry out today, nothing stubbed. Add an entry when the capability lands,
/// with the web's id and label verbatim.
enum CommandRegistry {
    static let actions: [CommandAction] = [
        CommandAction(id: "new-document", label: "New document", section: .documents,
                      aliases: ["create", "add"], shortcut: "⌘N"),
        CommandAction(id: "open-in-web", label: "Open in web app", section: .documents,
                      aliases: ["browser", "website"], shortcut: ""),
        CommandAction(id: "mode-rich", label: "Switch to Rich text", section: .modes,
                      aliases: ["wysiwyg", "rich"], shortcut: "⌃⇧R"),
        CommandAction(id: "mode-raw", label: "Switch to Raw Markdown", section: .modes,
                      aliases: ["markdown", "source", "raw"], shortcut: "⌃⇧M"),
        CommandAction(id: "mode-vim", label: "Switch to Vim", section: .modes,
                      aliases: ["modal"], shortcut: "⌃⇧V"),
        CommandAction(id: "mode-preview", label: "Switch to Preview", section: .modes,
                      aliases: ["read", "rendered", "pv"], shortcut: "⌃⇧P"),
        CommandAction(id: "cycle-next", label: "Cycle mode forward", section: .modes,
                      aliases: [], shortcut: "⌃⇧]"),
        CommandAction(id: "cycle-prev", label: "Cycle mode backward", section: .modes,
                      aliases: [], shortcut: "⌃⇧["),
    ] + formatActions + [
        CommandAction(id: "split-v", label: "Split pane — vertical", section: .panes,
                      aliases: ["column", "right"], shortcut: "⌘\\"),
        CommandAction(id: "split-h", label: "Split pane — horizontal", section: .panes,
                      aliases: ["row", "below"], shortcut: "⌘⇧\\"),
        CommandAction(id: "close-pane", label: "Close pane", section: .panes,
                      aliases: [], shortcut: "⌃⇧W"),
        CommandAction(id: "focus-next", label: "Focus next pane", section: .panes,
                      aliases: [], shortcut: "⌃⇧→"),
        CommandAction(id: "focus-prev", label: "Focus previous pane", section: .panes,
                      aliases: [], shortcut: "⌃⇧←"),
        CommandAction(id: "go-to-heading", label: "Go to heading…", section: .navigate,
                      aliases: ["outline", "jump", "heading", "section", "toc"], shortcut: "⌃⇧O"),
        CommandAction(id: "toggle-outline", label: "Toggle outline panel", section: .navigate,
                      aliases: ["outline", "table of contents", "toc", "sidebar"], shortcut: ""),
        CommandAction(id: "checkpoint", label: "Create version / checkpoint", section: .history,
                      aliases: ["tag", "save", "snapshot"], shortcut: "⌘S"),
        CommandAction(id: "undo-tree", label: "Open undo-tree visualizer", section: .history,
                      aliases: ["branches"], shortcut: "⌃⇧U"),
        CommandAction(id: "version-history", label: "Open version history", section: .history,
                      aliases: ["versions"], shortcut: "⌃⇧H"),
        CommandAction(id: "undo", label: "Undo", section: .history, aliases: [], shortcut: "⌘Z"),
        CommandAction(id: "redo", label: "Redo", section: .history, aliases: [], shortcut: "⌘⇧Z"),
        CommandAction(id: "manage-sharing", label: "Manage sharing…", section: .review,
                      aliases: ["share", "invite", "collaborate", "reviewer", "comment access"], shortcut: ""),
        CommandAction(id: "review-surface", label: "Review suggestions…", section: .review,
                      aliases: ["review", "suggestions", "branches", "accept", "reject", "changes", "feedback"], shortcut: ""),
        CommandAction(id: "toggle-comments", label: "Toggle comments panel", section: .review,
                      aliases: ["comments", "notes", "feedback", "annotations", "review"], shortcut: ""),
        CommandAction(id: "add-comment", label: "Add comment on selection", section: .review,
                      aliases: ["comment", "annotate", "note", "leave a comment"], shortcut: ""),
        CommandAction(id: "add-flag", label: "Flag this spot…", section: .review,
                      aliases: ["flag", "tk", "placeholder", "missing", "note", "later", "todo"], shortcut: "⌘⇧X"),
        CommandAction(id: "toggle-notes", label: "Toggle notes panel", section: .review,
                      aliases: ["notes", "flags", "missing", "todo", "tk"], shortcut: "⌃⇧N"),
        CommandAction(id: "toggle-notes-pin", label: "Pin notes panel open", section: .review,
                      aliases: ["pin", "keep open", "revision", "notes", "flags"], shortcut: ""),
        CommandAction(id: "ai-transform", label: "Transform selection with AI…", section: .ai,
                      aliases: ["rewrite", "tighten", "expand", "fix grammar", "edit", "ai"], shortcut: "⌃⇧I"),
        CommandAction(id: "ai-critique", label: "AI review (comments)…", section: .ai,
                      aliases: ["review", "feedback", "ai review", "comments", "critique", "notes", "ai"], shortcut: "⌃⇧J"),
        CommandAction(id: "ai-related", label: "Related passages from past drafts…", section: .ai,
                      aliases: ["rag", "search drafts", "related", "similar", "ai"], shortcut: "⌃⇧K"),
        CommandAction(id: "ai-reindex", label: "Re-index this draft for search", section: .ai,
                      aliases: ["embed", "index", "reindex", "rag", "ai"], shortcut: ""),
        CommandAction(id: "toggle-ai", label: "Toggle AI features", section: .ai,
                      aliases: ["enable ai", "disable ai", "ai off", "ai on"], shortcut: ""),
        CommandAction(id: "toggle-transform-mode", label: "Toggle AI transform mode (pending/replace)", section: .ai,
                      aliases: ["transform mode", "pending", "replace", "confirm", "ai"], shortcut: ""),
        CommandAction(id: "copy-rich", label: "Copy as rich text", section: .copyExport,
                      aliases: ["html", "clipboard"], shortcut: "⌘⇧C"),
        CommandAction(id: "copy-markdown", label: "Copy as Markdown", section: .copyExport,
                      aliases: ["source"], shortcut: "⌘⌥C"),
        CommandAction(id: "export-md", label: "Export as .md", section: .copyExport,
                      aliases: ["download markdown"], shortcut: "⌃⇧E"),
        CommandAction(id: "export-html", label: "Export as rich text (.html)", section: .copyExport,
                      aliases: ["download html"], shortcut: "⌃⇧E"),
        CommandAction(id: "export-docx", label: "Export as Word (.docx)", section: .copyExport,
                      aliases: ["download docx", "word"], shortcut: "⌃⇧E"),
        CommandAction(id: "find-replace", label: "Find & replace", section: .view,
                      aliases: ["search", "replace", "regex", "find"], shortcut: "⌘F"),
        CommandAction(id: "toggle-status", label: "Toggle word count / status bar", section: .view,
                      aliases: [], shortcut: "⌃⇧S"),
        CommandAction(id: "toggle-focus", label: "Toggle zen mode", section: .view,
                      aliases: ["focus", "distraction-free", "zen", "fullscreen"], shortcut: "⌃⇧F"),
        CommandAction(id: "toggle-font", label: "Toggle body font (sans / serif)", section: .view,
                      aliases: ["serif", "sans", "typeface", "font"], shortcut: ""),
        CommandAction(id: "zoom-in", label: "Increase text size", section: .view,
                      aliases: ["zoom in", "bigger text", "larger"], shortcut: ""),
        CommandAction(id: "zoom-out", label: "Decrease text size", section: .view,
                      aliases: ["zoom out", "smaller text"], shortcut: ""),
        CommandAction(id: "zoom-reset", label: "Reset text size", section: .view,
                      aliases: ["zoom 100", "default size"], shortcut: ""),
        CommandAction(id: "toggle-spellcheck", label: "Toggle spellcheck", section: .view,
                      aliases: ["spelling", "squiggles"], shortcut: "⌘;"),
        CommandAction(id: "toggle-lint-passive", label: "Lint: toggle passive voice", section: .view,
                      aliases: ["passive", "lint", "prose"], shortcut: ""),
        CommandAction(id: "toggle-lint-readability", label: "Lint: toggle readability", section: .view,
                      aliases: ["readability", "hard to read", "lint", "prose"], shortcut: ""),
        CommandAction(id: "toggle-lint-adverb", label: "Lint: toggle adverbs", section: .view,
                      aliases: ["adverb", "lint", "prose"], shortcut: ""),
        CommandAction(id: "toggle-lint-weasel", label: "Lint: toggle weasel words", section: .view,
                      aliases: ["weasel", "lint", "prose"], shortcut: ""),
        CommandAction(id: "toggle-smart-paste", label: "Toggle smart paste (HTML → Markdown)", section: .view,
                      aliases: ["paste", "clean paste", "word", "google docs"], shortcut: ""),
        CommandAction(id: "toggle-toolbar", label: "Toggle formatting toolbar", section: .view,
                      aliases: ["top toolbar", "format bar"], shortcut: ""),
        CommandAction(id: "toggle-typewriter", label: "Toggle typewriter scrolling", section: .view,
                      aliases: ["typewriter", "center line", "scroll", "focus"], shortcut: "⌃⇧T"),
        CommandAction(id: "toggle-focus-dim", label: "Toggle focus dimming", section: .view,
                      aliases: ["dim", "focus text", "highlight current", "spotlight"], shortcut: "⌃⇧D"),
        CommandAction(id: "toggle-focus-blur", label: "Toggle focus blur", section: .view,
                      aliases: ["blur", "typewriter", "focus", "current line", "zen"], shortcut: "⌃⇧B"),
        CommandAction(id: "toggle-quiet-chrome", label: "Toggle quiet chrome while typing", section: .view,
                      aliases: ["fade", "hide toolbar", "distraction", "quiet"], shortcut: ""),
        CommandAction(id: "cycle-dim-scope", label: "Focus scope: sentence / paragraph", section: .view,
                      aliases: ["sentence", "paragraph", "scope", "dim scope"], shortcut: ""),
        CommandAction(id: "toggle-email-preview", label: "Toggle email/inbox preview", section: .view,
                      aliases: ["email", "newsletter", "inbox", "preheader", "subject"], shortcut: ""),
        CommandAction(id: "set-goal", label: "Set word goal…", section: .view,
                      aliases: ["target", "goal", "words", "ulysses", "scrivener", "streak"], shortcut: ""),
        CommandAction(id: "toggle-goal-style", label: "Toggle goal display (ring / bar)", section: .view,
                      aliases: ["ring", "bar", "goal style", "progress"], shortcut: ""),
        CommandAction(id: "toggle-goal-scope", label: "Toggle goal scope (document / daily)", section: .view,
                      aliases: ["daily goal", "document goal", "goal scope"], shortcut: ""),
        CommandAction(id: "appearance-system", label: "Appearance: Match system", section: .theme,
                      aliases: ["auto", "light", "dark", "system", "os", "prefers-color-scheme"], shortcut: ""),
        CommandAction(id: "appearance-light", label: "Appearance: Light (Paper)", section: .theme,
                      aliases: ["light", "paper", "day", "white", "bright"], shortcut: ""),
        CommandAction(id: "appearance-dark", label: "Appearance: Dark", section: .theme,
                      aliases: ["dark", "night", "twilight"], shortcut: ""),
        CommandAction(id: "theme-twilight", label: "Theme: Twilight", section: .theme,
                      aliases: ["indigo", "periwinkle", "calm", "appearance", "palette", "colour"], shortcut: ""),
        CommandAction(id: "theme-aurora", label: "Theme: Aurora", section: .theme,
                      aliases: ["teal", "aqua", "mint", "appearance", "palette", "colour"], shortcut: ""),
        CommandAction(id: "theme-dawn", label: "Theme: Dawn", section: .theme,
                      aliases: ["rose", "lavender", "appearance", "palette", "colour"], shortcut: ""),
        CommandAction(id: "theme-moonlit", label: "Theme: Moonlit", section: .theme,
                      aliases: ["silver", "cyan", "minimal", "appearance", "palette", "colour"], shortcut: ""),
    ]

    /// Mac-only commands: what the web does with a click or has no need of —
    /// the sidebar, Settings, the status bar's native toggles — so the whole
    /// app is reachable from the keyboard. Shortcuts are the menu's chords.
    static let nativeActions: [CommandAction] = [
        CommandAction(id: "go-to-documents", label: "Go to document list", section: .documents,
                      aliases: ["sidebar", "library", "files", "notes", "focus"], shortcut: "⌃⌘1"),
        CommandAction(id: "go-to-editor", label: "Go to editor", section: .documents,
                      aliases: ["text", "page", "write", "focus", "type"], shortcut: "⌃⌘2"),
        CommandAction(id: "search-documents", label: "Search documents", section: .documents,
                      aliases: ["find", "filter", "library", "sidebar"], shortcut: "⇧⌘F"),
        CommandAction(id: "toggle-sidebar", label: "Toggle sidebar", section: .documents,
                      aliases: ["library", "document list", "hide", "show"], shortcut: "⌃⌘S"),
        CommandAction(id: "open-settings", label: "Settings…", section: .documents,
                      aliases: ["preferences", "markdown files", "default app"], shortcut: "⌘,"),
        CommandAction(id: "sign-out", label: "Sign out", section: .documents,
                      aliases: ["log out", "account", "switch account"], shortcut: ""),
        CommandAction(id: "toggle-lint", label: "Toggle prose linter", section: .view,
                      aliases: ["lint", "prose", "suggestions", "style"], shortcut: ""),
        CommandAction(id: "toggle-compact-status", label: "Toggle compact status bar", section: .view,
                      aliases: ["status bar", "display", "aa", "controls", "clutter"], shortcut: ""),
        CommandAction(id: "toggle-sheet", label: "Toggle page sheet", section: .view,
                      aliases: ["page", "paper", "atmosphere", "flat", "background"], shortcut: ""),
    ]

    /// The formatting toolbar's buttons, in its order, as `format-<id>`: the
    /// web's `FORMAT_ACTIONS`, with Milkdown's chords, which the web uses.
    static let formatActions: [CommandAction] = FormatToolbarAction.all
        .map { action in
            CommandAction(
                id: "format-\(action.id)", label: action.label, section: .format,
                aliases: ["format", "markdown"], shortcut: action.shortcutGlyphs)
        }

    /// The web's actions and the Mac's own, each section's web entries first.
    static let allActions: [CommandAction] = CommandSection.allCases.flatMap { section in
        (actions + nativeActions).filter { $0.section == section }
    }

    /// Chords the Mac's menus add where the web has none.
    static let nativeShortcuts: [String: String] = [
        "zoom-in": "⌘=", "zoom-out": "⌘-", "zoom-reset": "⌘0",
    ]

    /// The chord for a command, as the palette and tooltips print it, or "".
    static func shortcut(for id: String) -> String {
        let chord = action(id)?.shortcut ?? ""
        return chord.isEmpty ? nativeShortcuts[id] ?? "" : chord
    }

    /// A tooltip that teaches the chord: "Bold (⌘B)", or the text alone when
    /// the command has none.
    static func help(_ text: String, command id: String) -> String {
        let chord = shortcut(for: id)
        return chord.isEmpty ? text : "\(text) (\(chord))"
    }

    static func action(_ id: String) -> CommandAction? {
        allActions.first { $0.id == id }
    }

    static func actions(in section: CommandSection) -> [CommandAction] {
        allActions.filter { $0.section == section }
    }
}
