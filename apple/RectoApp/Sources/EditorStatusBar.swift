import RectoCoreJS
import RectoEditor
import SwiftUI

/// Counts prose words in a markdown string. Injected so a test can watch how
/// often the label recounts; the app uses `WordCount.count`.
typealias WordCounter = @Sendable (String) -> Int

/// The footer under the editor, after the web app's status bar: the mode
/// switcher on the left; the studio controls, word count, reading time and
/// sync state on the right, in the web's order, in the editor's palette.
///
/// Takes the storage rather than its markdown so that only `WordCountLabel`
/// observes the text: the host's body, and with it the editor's update pass,
/// stays out of the keystroke path.
struct EditorStatusBar<Trailing: View>: View {
    let presentation: Presentation
    let isEditable: Bool
    let storage: RectoTextStorage
    let settings: StudioSettings
    let theme: RectoEditorTheme
    var wordCounter: WordCounter = WordCount.count
    /// The writer picked a lens, by button or by its shortcut.
    let onSelect: (Presentation) -> Void
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 8) {
            ModeSwitcher(active: presentation, isEditable: isEditable, theme: theme, onSelect: onSelect)
            Spacer(minLength: 0)
            StudioControls(settings: settings, theme: theme)
            StatusDivider(theme: theme)
            WordCountLabel(storage: storage, ink: theme.ink3, counter: wordCounter)
            if Trailing.self != EmptyView.self {
                StatusDot(theme: theme)
                trailing()
            }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(Color(nsColor: theme.raised))
        .overlay(alignment: .top) {
            Color(nsColor: theme.line).frame(height: 1)
        }
    }
}

extension EditorStatusBar where Trailing == EmptyView {
    init(
        presentation: Presentation,
        isEditable: Bool,
        storage: RectoTextStorage,
        settings: StudioSettings,
        theme: RectoEditorTheme,
        wordCounter: @escaping WordCounter = WordCount.count,
        onSelect: @escaping (Presentation) -> Void
    ) {
        self.init(
            presentation: presentation,
            isEditable: isEditable,
            storage: storage,
            settings: settings,
            theme: theme,
            wordCounter: wordCounter,
            onSelect: onSelect,
            trailing: EmptyView.init
        )
    }
}

/// The web's right-hand controls, minus what is not native yet: appearance,
/// palette, text zoom, spellcheck, typewriter. Body font, the prose linter,
/// focus dimming, zen and goals slot in here when they land; all of them stay
/// reachable from the command palette on the web, which is the contract.
private struct StudioControls: View {
    let settings: StudioSettings
    let theme: RectoEditorTheme

    var body: some View {
        HStack(spacing: 8) {
            labelButton(
                settings.appearance.label,
                symbol: settings.appearance.symbol,
                help: "Appearance: \(settings.appearance.label) — click to cycle",
                accessibility: "Appearance: \(settings.appearance.label). Click to change appearance",
                action: settings.cycleAppearance
            )
            // Twilight is the only dark palette so far and Paper the only light
            // one, so there is nothing to cycle to yet; the control reports the
            // palette in force the way the web does when it is disabled.
            labelButton(
                settings.themeLabel,
                symbol: "paintpalette",
                help: settings.resolvedAppearance == .dark
                    ? "Palette: Twilight — no other dark palette yet"
                    : "Palette: Paper — the other palettes need a dark appearance",
                accessibility: "Palette: \(settings.themeLabel)",
                action: {}
            )
            .disabled(true)
            .opacity(0.6)

            StatusDivider(theme: theme)

            HStack(spacing: 2) {
                iconButton("minus", help: "Smaller text", accessibility: "Decrease text size", action: settings.zoomOut)
                    .disabled(!settings.canZoomOut)
                Button(action: settings.zoomReset) {
                    Text(verbatim: "\(settings.zoomPercent)%")
                        .monospacedDigit()
                        .frame(minWidth: 30)
                        .foregroundStyle(Color(nsColor: theme.ink3))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .focusable(false)
                .help("Reset text size")
                .accessibilityLabel("Reset text size")
                iconButton("plus", help: "Bigger text", accessibility: "Increase text size", action: settings.zoomIn)
                    .disabled(!settings.canZoomIn)
            }

            StatusDivider(theme: theme)

            iconButton(
                "textformat.abc.dottedunderline",
                help: "Spellcheck: \(settings.spellcheck ? "On" : "Off")",
                accessibility: "Toggle spellcheck",
                isOn: settings.spellcheck,
                action: settings.toggleSpellcheck
            )

            StatusDivider(theme: theme)

            iconButton(
                "arrow.up.and.down.text.horizontal",
                help: "Typewriter scrolling: \(settings.typewriter ? "On" : "Off")",
                accessibility: "Toggle typewriter scrolling",
                isOn: settings.typewriter,
                action: settings.toggleTypewriter
            )
        }
    }

    private func labelButton(
        _ title: String,
        symbol: String,
        help: String,
        accessibility: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .foregroundStyle(Color(nsColor: theme.accent))
                Text(title)
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .foregroundStyle(Color(nsColor: theme.ink3))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help(help)
        .accessibilityLabel(accessibility)
    }

    private func iconButton(
        _ symbol: String,
        help: String,
        accessibility: String,
        isOn: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12))
                .frame(width: 24, height: 24)
                .foregroundStyle(Color(nsColor: isOn ? theme.accent : theme.ink3))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help(help)
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// The web's `h-3.5 w-px bg-line` separator.
private struct StatusDivider: View {
    let theme: RectoEditorTheme

    var body: some View {
        Color(nsColor: theme.line)
            .frame(width: 1, height: 14)
            .accessibilityHidden(true)
    }
}

/// The web's "·" between the trailing figures.
private struct StatusDot: View {
    let theme: RectoEditorTheme

    var body: some View {
        Text(verbatim: "·")
            .foregroundStyle(Color(nsColor: theme.line))
            .accessibilityHidden(true)
    }
}

/// The prose word count, kept off the typing path.
///
/// `WordCount.count` takes ~7 ms on an 85k-character document in Release and
/// the editor's whole per-keystroke budget is 8 ms, so the count never runs
/// synchronously with an edit. The first appearance counts at once so the bar
/// never shows empty; after that each change waits 200 ms and counts on a
/// utility-priority task. `task(id:)` cancels the pending wait on every
/// keystroke, so a typing burst costs the main thread nothing and produces one
/// count after the last key. The previous number stays up until the new one
/// lands.
private struct WordCountLabel: View {
    let storage: RectoTextStorage
    let ink: NSColor
    let counter: WordCounter
    @State private var count: Int?

    var body: some View {
        let markdown = storage.markdown
        return Group {
            if let count {
                Text("^[\(count) word](inflect: true) · \(ReadingTime.format(minutes: ReadingTime.minutes(wordCount: count)))")
            } else {
                Text(verbatim: "")
            }
        }
        .monospacedDigit()
        .foregroundStyle(Color(nsColor: ink))
        .help("Estimated reading time")
        .task(id: MarkdownBytes(markdown)) {
            if count == nil {
                count = counter(markdown)
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            let markdown = markdown
            let counter = counter
            let next = await Task.detached(priority: .utility) { counter(markdown) }.value
            guard !Task.isCancelled else { return }
            count = next
        }
    }
}

/// Equality by bytes, the way `RectoTextStorage` compares: an unchanged string
/// is a pointer check, a changed one a length check before any memcmp.
private struct MarkdownBytes: Equatable {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.value as NSString).isEqual(to: rhs.value)
    }
}

/// The web's `MODE_RING` as icon+label buttons; the active lens gets the
/// accent wash.
private struct ModeSwitcher: View {
    let active: Presentation
    let isEditable: Bool
    let theme: RectoEditorTheme
    let onSelect: (Presentation) -> Void

    /// Web order, minus what does not exist natively yet. Vim slots in between
    /// raw and preview when the RectoVim slice lands. Preview only appears for
    /// a read-only document, where it is the state rather than a choice.
    private var ring: [Presentation] {
        isEditable ? [.rich, .raw] : [.rich, .raw, .preview]
    }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(ring, id: \.self) { mode in
                Button {
                    onSelect(mode)
                } label: {
                    Label(mode.label, systemImage: mode.symbol)
                        .padding(.horizontal, 8)
                        .frame(height: 22)
                        .background(
                            mode == active ? accentWash : .clear,
                            in: RoundedRectangle(cornerRadius: 4)
                        )
                        .foregroundStyle(Color(nsColor: mode == active ? theme.ink : theme.ink3))
                }
                .buttonStyle(.plain)
                .disabled(!isEditable)
                // In-window, so the chord reaches this window's lens whichever
                // window is key; the View menu carries the same chords for
                // when the bar is hidden.
                .keyboardShortcut(mode.shortcut)
                .help(mode.help)
                .accessibilityLabel(mode.label)
                .accessibilityAddTraits(mode == active ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Editor mode")
    }

    /// The tokens' `accent-wash`: accent at 0.15 alpha. The theme has no slot
    /// for it yet.
    private var accentWash: Color {
        Color(nsColor: theme.accent.withAlphaComponent(0.15))
    }
}

private extension Presentation {
    /// `modeToLabel` in `lib/modes/types.ts`.
    var label: String {
        switch self {
        case .rich: "Rich text"
        case .raw: "Raw Markdown"
        case .vim: "Vim"
        case .preview: "Preview"
        }
    }

    /// SF Symbol standing in for the web's lucide icon.
    var symbol: String {
        switch self {
        case .rich: "textformat"
        case .raw: "chevron.left.forwardslash.chevron.right"
        case .vim: "keyboard"
        case .preview: "eye"
        }
    }

    /// Recto's mode chords are Ctrl+Shift everywhere (blueprint §2.1, web
    /// keymap `lib/keyboard/actions.ts`) so the bare letters stay free for Vim.
    var shortcut: KeyboardShortcut? {
        switch self {
        case .rich: KeyboardShortcut("r", modifiers: [.control, .shift])
        case .raw: KeyboardShortcut("m", modifiers: [.control, .shift])
        case .vim: KeyboardShortcut("v", modifiers: [.control, .shift])
        case .preview: nil
        }
    }

    /// Tooltip. Names the chord.
    var help: String {
        switch self {
        case .rich: "Rich text (⌃⇧R)"
        case .raw: "Raw Markdown (⌃⇧M)"
        case .vim: "Vim (⌃⇧V)"
        case .preview: "Preview"
        }
    }
}
