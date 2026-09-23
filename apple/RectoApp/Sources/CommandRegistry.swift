/// The palette's sections, in the web's `SECTION_ORDER`. Sections with no
/// native action yet (Panes, Navigate, Review, AI) keep their slot so the
/// order matches when they fill in.
enum CommandSection: String, CaseIterable, Sendable {
    case documents = "Documents"
    case modes = "Modes"
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
        CommandAction(id: "go-to-heading", label: "Go to heading…", section: .navigate,
                      aliases: ["outline", "jump", "heading", "section", "toc"], shortcut: "⌃⇧O"),
        CommandAction(id: "toggle-outline", label: "Toggle outline panel", section: .navigate,
                      aliases: ["outline", "table of contents", "toc", "sidebar"], shortcut: ""),
        CommandAction(id: "undo", label: "Undo", section: .history, aliases: [], shortcut: "⌘Z"),
        CommandAction(id: "redo", label: "Redo", section: .history, aliases: [], shortcut: "⌘⇧Z"),
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
                      aliases: ["spelling", "squiggles"], shortcut: ""),
        CommandAction(id: "toggle-toolbar", label: "Toggle formatting toolbar", section: .view,
                      aliases: ["top toolbar", "format bar"], shortcut: ""),
        CommandAction(id: "toggle-typewriter", label: "Toggle typewriter scrolling", section: .view,
                      aliases: ["typewriter", "center line", "scroll", "focus"], shortcut: "⌃⇧T"),
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

    static func action(_ id: String) -> CommandAction? {
        actions.first { $0.id == id }
    }

    static func actions(in section: CommandSection) -> [CommandAction] {
        actions.filter { $0.section == section }
    }
}
