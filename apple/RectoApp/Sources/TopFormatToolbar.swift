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
            button(label: "Undo", glyph: .symbol("arrow.uturn.backward"), action: actions.undo)
            button(label: "Redo", glyph: .symbol("arrow.uturn.forward"), action: actions.redo)
            divider
            ForEach(Self.inlineActions, content: formatButton)
            divider
            ForEach(Self.blockActions, content: formatButton)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(Color(nsColor: theme.canvas))
        .overlay(alignment: .bottom) {
            Color(nsColor: theme.line).frame(height: 1)
        }
        .opacity(isEnabled ? 1 : 0.4)
        .disabled(!isEnabled)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Formatting")
    }

    private func formatButton(_ action: FormatToolbarAction) -> some View {
        button(label: action.label, glyph: action.glyph) { actions.format(action.command) }
    }

    private func button(label: String, glyph: FormatToolbarAction.Glyph, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Group {
                switch glyph {
                case let .symbol(name):
                    Image(systemName: name)
                        .font(.system(size: 14, weight: .medium))
                case let .text(text):
                    Text(text)
                        .font(.system(size: 12, weight: .bold))
                }
            }
            .frame(width: 32, height: 32)
            .foregroundStyle(Color(nsColor: theme.ink2))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The web's `onPointerDown preventDefault`: the editor keeps focus and
        // its selection while a button is pressed.
        .focusable(false)
        .help(label)
        .accessibilityLabel(label)
    }

    private var divider: some View {
        Color(nsColor: theme.line)
            .frame(width: 1, height: 20)
            .padding(.horizontal, 4)
            .accessibilityHidden(true)
    }
}
