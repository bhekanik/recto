import RectoEditor
import SwiftUI

/// One button of the formatting toolbar — the web's `FormatAction`, with the
/// editor command the native writing controls run for it.
struct FormatToolbarAction: Identifiable, Equatable, Sendable {
    enum Glyph: Equatable {
        case symbol(String)
        /// lucide's Heading1/2/3 have no SF Symbol; a short bold label reads
        /// the same way.
        case text(String)
    }

    /// The web's `FormatCommand` id.
    let id: String
    let label: String
    let command: RectoEditorCommand
    let glyph: Glyph
}

extension FormatToolbarAction {
    /// Every button, inline marks then blocks: the palette's Format section
    /// and the Format menu list the same commands in the same order.
    nonisolated static var all: [FormatToolbarAction] {
        TopFormatToolbar.inlineActions + TopFormatToolbar.blockActions
    }

    /// Milkdown's commonmark and GFM keymaps (`Mod-b`, `Mod-Alt-1`, …), the
    /// chords the web editor answers. Link has none: ⌘K is the palette. Code
    /// block has none: Milkdown's ⌥⌘C is the web's app-level Copy as Markdown.
    nonisolated var shortcut: (key: Character, modifiers: EventModifiers)? {
        switch id {
        case "bold": ("b", .command)
        case "italic": ("i", .command)
        case "code": ("e", .command)
        case "strike": ("x", [.command, .option])
        case "h1": ("1", [.command, .option])
        case "h2": ("2", [.command, .option])
        case "h3": ("3", [.command, .option])
        case "quote": ("b", [.command, .shift])
        case "bulletList": ("8", [.command, .option])
        case "orderedList": ("7", [.command, .option])
        default: nil
        }
    }

    /// The chord as the palette prints it: `⌥⌘X`.
    nonisolated var shortcutGlyphs: String {
        guard let (key, modifiers) = shortcut else { return "" }
        var glyphs = ""
        if modifiers.contains(.control) { glyphs += "⌃" }
        if modifiers.contains(.option) { glyphs += "⌥" }
        if modifiers.contains(.shift) { glyphs += "⇧" }
        if modifiers.contains(.command) { glyphs += "⌘" }
        return glyphs + String(key).uppercased()
    }
}

/// What the toolbar's buttons do, supplied by the host that owns the editor.
struct FormatToolbarActions {
    var undo: () -> Void
    var redo: () -> Void
    var format: (RectoEditorCommand) -> Void
}

/// The persistent formatting bar above the writing sheet, after the web's
/// `TopFormatToolbar`: undo · redo | inline marks | block transforms, in the
/// web's order with the web's labels as tooltips.
struct TopFormatToolbar: View {
    let theme: RectoEditorTheme
    let presentation: Presentation
    let actions: FormatToolbarActions

    /// `INLINE_ACTIONS` in `components/format-actions.ts`. Link has no
    /// destination yet; the host asks for one.
    nonisolated static let inlineActions: [FormatToolbarAction] = [
        FormatToolbarAction(id: "bold", label: "Bold", command: .bold, glyph: .symbol("bold")),
        FormatToolbarAction(id: "italic", label: "Italic", command: .italic, glyph: .symbol("italic")),
        FormatToolbarAction(id: "strike", label: "Strikethrough", command: .strikethrough,
                            glyph: .symbol("strikethrough")),
        FormatToolbarAction(id: "code", label: "Inline code", command: .inlineCode,
                            glyph: .symbol("chevron.left.forwardslash.chevron.right")),
        FormatToolbarAction(id: "link", label: "Link", command: .link(destination: ""), glyph: .symbol("link")),
    ]

    /// `BLOCK_ACTIONS` in `components/format-actions.ts`.
    nonisolated static let blockActions: [FormatToolbarAction] = [
        FormatToolbarAction(id: "h1", label: "Heading 1", command: .heading(level: 1), glyph: .text("H1")),
        FormatToolbarAction(id: "h2", label: "Heading 2", command: .heading(level: 2), glyph: .text("H2")),
        FormatToolbarAction(id: "h3", label: "Heading 3", command: .heading(level: 3), glyph: .text("H3")),
        FormatToolbarAction(id: "quote", label: "Quote", command: .blockquote, glyph: .symbol("text.quote")),
        FormatToolbarAction(id: "bulletList", label: "Bullet list", command: .bulletList,
                            glyph: .symbol("list.bullet")),
        FormatToolbarAction(id: "orderedList", label: "Numbered list", command: .orderedList,
                            glyph: .symbol("list.number")),
        FormatToolbarAction(id: "codeBlock", label: "Code block", command: .codeBlock(language: ""),
                            glyph: .symbol("curlybraces")),
    ]

    /// Preview has nothing to format, so the bar dims and goes inert there,
    /// like the web's. Raw formats too: the commands edit Markdown source.
    static func isEnabled(in presentation: Presentation) -> Bool {
        presentation.isEditable
    }

    private var isEnabled: Bool { Self.isEnabled(in: presentation) }

    var body: some View {
        HStack(spacing: 2) {
            button(label: "Undo", command: "undo", glyph: .symbol("arrow.uturn.backward"), action: actions.undo)
            button(label: "Redo", command: "redo", glyph: .symbol("arrow.uturn.forward"), action: actions.redo)
            divider
            ForEach(Self.inlineActions, content: formatButton)
            divider
            ForEach(Self.blockActions, content: formatButton)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        // No fill of its own: the host's backdrop (the atmosphere, or the flat
        // sheet) shows through, so the bar is part of the page, not a band.
        .opacity(isEnabled ? 1 : 0.4)
        .disabled(!isEnabled)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Formatting")
    }

    private func formatButton(_ action: FormatToolbarAction) -> some View {
        button(label: action.label, command: "format-\(action.id)", glyph: action.glyph) {
            actions.format(action.command)
        }
    }

    private func button(
        label: String, command: String, glyph: FormatToolbarAction.Glyph, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Group {
                switch glyph {
                case let .symbol(name):
                    Image(systemName: name)
                        .font(.system(size: 12.5, weight: .regular))
                case let .text(text):
                    Text(text)
                        .font(.system(size: 11, weight: .semibold))
                }
            }
            .frame(width: 28, height: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(QuietToolbarButtonStyle(theme: theme))
        // The web's `onPointerDown preventDefault`: the editor keeps focus and
        // its selection while a button is pressed.
        .focusable(false)
        .help(CommandRegistry.help(label, command: command))
        .accessibilityLabel(label)
    }

    private var divider: some View {
        Color(nsColor: theme.line)
            .frame(width: 1, height: 14)
            .padding(.horizontal, 6)
            .accessibilityHidden(true)
    }
}

/// Glyphs rest at the tertiary ink and come forward under the pointer, on a
/// soft wash rather than a border.
struct QuietToolbarButtonStyle: ButtonStyle {
    let theme: RectoEditorTheme

    func makeBody(configuration: Configuration) -> some View {
        QuietToolbarButton(configuration: configuration, theme: theme)
    }

    private struct QuietToolbarButton: View {
        let configuration: ButtonStyleConfiguration
        let theme: RectoEditorTheme
        @State private var isHovered = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .foregroundStyle(Color(nsColor: isHovered && isEnabled ? theme.ink : theme.ink3))
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color(nsColor: theme.ink.withAlphaComponent(
                            configuration.isPressed ? 0.12 : isHovered && isEnabled ? 0.06 : 0)))
                )
                .onHover { isHovered = $0 }
                .animation(.easeOut(duration: 0.12), value: isHovered)
        }
    }
}
