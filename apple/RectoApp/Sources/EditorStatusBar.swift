import AppKit
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
    /// The window's vim layer. Its mode line sits right of the ring while the
    /// lens is `.vim`; only this bar observes its status, so a mode change
    /// re-renders the footer and not the host.
    var vimController: RectoVimController? = nil
    /// The window's zen state, for the zen button. `nil` hides the button.
    var zen: ZenMode? = nil
    /// Toggles zen for this bar's own window. The host owns the window, and
    /// `NSApp.keyWindow` is nil whenever the app is not frontmost.
    var onToggleZen: () -> Void = {}
    /// The writer picked a lens, by button or by its shortcut.
    let onSelect: (Presentation) -> Void
    @ViewBuilder let trailing: () -> Trailing

    var showsVimStatus: Bool { presentation == .vim && vimController != nil }

    var body: some View {
        HStack(spacing: 8) {
            ModeSwitcher(active: presentation, isEditable: isEditable, theme: theme, onSelect: onSelect)
            if showsVimStatus, let vimController {
                VimStatusView(status: vimController.status, theme: theme)
            }
            Spacer(minLength: 0)
            // The right side keeps its natural width; the mode ring gives way
            // first, dropping its labels, as the web's does below `sm`.
            HStack(spacing: 8) {
                StudioControls(settings: settings, theme: theme)
                if let zen {
                    StatusDivider(theme: theme)
                    ZenButton(zen: zen, theme: theme, action: onToggleZen)
                }
                StatusDivider(theme: theme)
                WordCountLabel(storage: storage, ink: theme.ink3, counter: wordCounter)
                if Trailing.self != EmptyView.self {
                    StatusDot(theme: theme)
                    trailing()
                }
            }
            .fixedSize()
            .layoutPriority(1)
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
        vimController: RectoVimController? = nil,
        zen: ZenMode? = nil,
        onToggleZen: @escaping () -> Void = {},
        onSelect: @escaping (Presentation) -> Void
    ) {
        self.init(
            presentation: presentation,
            isEditable: isEditable,
            storage: storage,
            settings: settings,
            theme: theme,
            wordCounter: wordCounter,
            vimController: vimController,
            zen: zen,
            onToggleZen: onToggleZen,
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
            labelButton(
                settings.themeLabel,
                symbol: "paintpalette",
                help: settings.canCyclePalette
                    ? "Palette: \(settings.themeLabel) — click to cycle"
                    : "Palette: Paper — the other palettes need a dark appearance",
                accessibility: "Palette: \(settings.themeLabel). Click to change palette",
                action: settings.cyclePalette
            )
            .disabled(!settings.canCyclePalette)
            .opacity(settings.canCyclePalette ? 1 : 0.6)

            StatusDivider(theme: theme)

            Button(action: settings.toggleReadingFont) {
                Text(settings.readingFont == .serif ? "Serif" : "Sans")
                    .font(.custom(
                        settings.readingFont == .serif ? RectoFonts.proseFamily : RectoFonts.sansFamily,
                        size: 12))
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .foregroundStyle(Color(nsColor: theme.ink3))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .help("Body font: \(settings.readingFont == .serif ? "Serif" : "Sans") — click to switch")
            .accessibilityLabel("Toggle body font")

            StatusDivider(theme: theme)

            HStack(spacing: 2) {
                iconButton("minus", help: "Smaller text", accessibility: "Decrease text size", action: settings.zoomOut)
                    .disabled(!settings.canZoomOut)
                Button(action: settings.zoomReset) {
                    Text(verbatim: "\(settings.zoomPercent)%")
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
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
                    .lineLimit(1)
                    .fixedSize()
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

/// The web's zen button (lucide `SquareDashed`).
private struct ZenButton: View {
    let zen: ZenMode
    let theme: RectoEditorTheme
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "square.dashed")
                .font(.system(size: 12))
                .frame(width: 24, height: 24)
                .foregroundStyle(Color(nsColor: zen.isOn ? theme.accent : theme.ink3))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help("Zen mode (hide everything but the page)")
        .accessibilityLabel("Toggle zen mode")
        .accessibilityAddTraits(zen.isOn ? .isSelected : [])
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

    /// "1,000 words" measured in the monospaced-digit face the label renders
    /// in — the proportional face is narrower, so a floor measured there let
    /// 999 → 1,000 still shove the reading time and the sync slot.
    private static let wordCountMinWidth: CGFloat = {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
        ]
        return ("1,000 words" as NSString).size(withAttributes: attributes).width
    }()

    var body: some View {
        let markdown = storage.markdown
        return HStack(spacing: 8) {
            if let count {
                Text("^[\(count) word](inflect: true)")
                    .frame(minWidth: Self.wordCountMinWidth, alignment: .trailing)
                Text(verbatim: "·")
                Text(ReadingTime.format(minutes: ReadingTime.minutes(wordCount: count)))
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

    private var ring: [Presentation] { PresentationPreference.ring }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            buttons(labelled: true)
            buttons(labelled: false)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Editor mode")
    }

    private func buttons(labelled: Bool) -> some View {
        HStack(spacing: 2) {
            ForEach(ring, id: \.self) { mode in
                Button {
                    onSelect(mode)
                } label: {
                    Label(mode.label, systemImage: mode.symbol)
                        .labelStyle(.adaptive(labelled))
                        .lineLimit(1)
                        .fixedSize()
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
        case .preview: KeyboardShortcut("p", modifiers: [.control, .shift])
        }
    }

    /// Tooltip. Names the chord.
    var help: String {
        switch self {
        case .rich: "Rich text (⌃⇧R)"
        case .raw: "Raw Markdown (⌃⇧M)"
        case .vim: "Vim (⌃⇧V)"
        case .preview: "Preview (⌃⇧P)"
        }
    }
}

/// Title and icon, or the icon alone when the bar is too narrow for titles.
private struct AdaptiveLabelStyle: LabelStyle {
    let showsTitle: Bool

    func makeBody(configuration: Configuration) -> some View {
        if showsTitle {
            Label(configuration)
        } else {
            configuration.icon
        }
    }
}

private extension LabelStyle where Self == AdaptiveLabelStyle {
    static func adaptive(_ showsTitle: Bool) -> AdaptiveLabelStyle {
        AdaptiveLabelStyle(showsTitle: showsTitle)
    }
}
