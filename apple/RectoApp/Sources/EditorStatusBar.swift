import AppKit
import RectoCoreJS
import RectoEditor
import SwiftUI

/// The footer under the editor, after the web app's status bar: the mode
/// switcher on the left; the studio controls, word count, reading time and
/// sync state on the right, in the web's order, in the editor's palette.
///
/// Takes the window's word count rather than the text: the host's tracker
/// counts, and only the labels that show a number observe it.
struct EditorStatusBar<Trailing: View>: View {
    let presentation: Presentation
    let isEditable: Bool
    let wordCount: DocumentWordCount
    let settings: StudioSettings
    let theme: RectoEditorTheme
    /// The day's words and the streak. `nil` hides them (a file document's
    /// window before sign-in has no one to credit).
    var stats: WritingStatsModel? = nil
    /// Opens the goal settings; set by the host, which owns the window.
    var onOpenGoalConfig: () -> Void = {}
    /// The window's vim layer. Its mode line sits right of the ring while the
    /// lens is `.vim`; only this bar observes its status, so a mode change
    /// re-renders the footer and not the host.
    var vimController: RectoVimController? = nil
    /// The window's lint result, for the count beside the lint toggle.
    var lint: ProseLint? = nil
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
            // The spacer gives way first; then, in a narrow pane, the right
            // side drops what matters least rather than forcing the pane wider
            // than its split (which pushed the text out of its column).
            ViewThatFits(in: .horizontal) {
                trailingControls(.full)
                trailingControls(.withoutProgress)
                trailingControls(.essentials)
            }
            .layoutPriority(1)
        }
        .font(.system(size: 11.5))
        .padding(.horizontal, 12)
        .frame(height: 28)
        // No fill, a faint hairline: the host's backdrop shows through, so the
        // bar belongs to the page instead of sitting under it as a surface.
        .overlay(alignment: .top) {
            Color(nsColor: theme.line.withAlphaComponent(0.55)).frame(height: 1)
        }
    }
}

extension EditorStatusBar {
    /// How much of the right side fits, widest first.
    enum Density {
        case full
        case withoutProgress
        case essentials
    }

    @ViewBuilder
    func trailingControls(_ density: Density) -> some View {
        let inline = !settings.compactStatusBar && density == .full
        HStack(spacing: 8) {
            if inline {
                StudioControls(settings: settings, lint: lint, theme: theme)
            }
            if density == .full {
                WritingProgress(
                    settings: settings, wordCount: wordCount, stats: stats, theme: theme,
                    onOpenConfig: onOpenGoalConfig)
            }
            if inline, let zen {
                StatusDivider(theme: theme)
                ZenButton(zen: zen, theme: theme, action: onToggleZen)
            }
            if density != .essentials {
                StatusDivider(theme: theme)
                WordCountLabel(count: wordCount, ink: theme.ink3)
            }
            if Trailing.self != EmptyView.self {
                if density != .essentials { StatusDot(theme: theme) }
                trailing()
            }
            // The display controls behind one button, zen last, where a
            // pointer heading for the corner finds them.
            if !inline {
                StatusDivider(theme: theme)
                DisplaySettingsButton(settings: settings, lint: lint, theme: theme)
                if let zen {
                    ZenButton(zen: zen, theme: theme, action: onToggleZen)
                }
            }
        }
        .fixedSize()
    }
}

extension EditorStatusBar where Trailing == EmptyView {
    init(
        presentation: Presentation,
        isEditable: Bool,
        wordCount: DocumentWordCount,
        settings: StudioSettings,
        theme: RectoEditorTheme,
        stats: WritingStatsModel? = nil,
        onOpenGoalConfig: @escaping () -> Void = {},
        vimController: RectoVimController? = nil,
        lint: ProseLint? = nil,
        zen: ZenMode? = nil,
        onToggleZen: @escaping () -> Void = {},
        onSelect: @escaping (Presentation) -> Void
    ) {
        self.init(
            presentation: presentation,
            isEditable: isEditable,
            wordCount: wordCount,
            settings: settings,
            theme: theme,
            stats: stats,
            onOpenGoalConfig: onOpenGoalConfig,
            vimController: vimController,
            lint: lint,
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
    let lint: ProseLint?
    let theme: RectoEditorTheme

    var body: some View {
        HStack(spacing: 8) {
            // Icons only: both are set once and then left alone, so their
            // names are tooltips rather than words competing with the count.
            iconButton(
                settings.appearance.symbol,
                help: "Appearance: \(settings.appearance.label) — click to cycle",
                accessibility: "Appearance: \(settings.appearance.label). Click to change appearance",
                action: settings.cycleAppearance
            )
            iconButton(
                "paintpalette",
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
                iconButton("minus", help: CommandRegistry.help("Smaller text", command: "zoom-out"),
                           accessibility: "Decrease text size", action: settings.zoomOut)
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
                .help(CommandRegistry.help("Reset text size", command: "zoom-reset"))
                .accessibilityLabel("Reset text size")
                iconButton("plus", help: CommandRegistry.help("Bigger text", command: "zoom-in"),
                           accessibility: "Increase text size", action: settings.zoomIn)
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

            iconButton(
                "text.viewfinder",
                help: "Prose linter: \(settings.lint ? "On" : "Off")",
                accessibility: "Toggle prose linter",
                isOn: settings.lint,
                action: settings.toggleLint
            )
            if settings.lint, let count = lint?.count, count > 0 {
                Text(verbatim: count.formatted())
                    .monospacedDigit()
                    .foregroundStyle(Color(nsColor: theme.ink3))
                    .help("\(count.formatted()) prose \(count == 1 ? "suggestion" : "suggestions")")
            }

            StatusDivider(theme: theme)

            iconButton(
                "arrow.up.and.down.text.horizontal",
                help: CommandRegistry.help(
                    "Typewriter scrolling: \(settings.typewriter ? "On" : "Off")", command: "toggle-typewriter"),
                accessibility: "Toggle typewriter scrolling",
                isOn: settings.typewriter,
                action: settings.toggleTypewriter
            )
            iconButton(
                "highlighter",
                help: CommandRegistry.help(
                    "Focus dimming: \(settings.focusDim ? "On" : "Off")", command: "toggle-focus-dim"),
                accessibility: "Toggle focus dimming",
                isOn: settings.focusDim,
                action: settings.toggleFocusDim
            )
            if settings.focusDim {
                Button(action: settings.cycleFocusDimScope) {
                    Text(settings.focusDimScope == .sentence ? "sentence" : "paragraph")
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 6)
                        .frame(height: 22)
                        .foregroundStyle(Color(nsColor: theme.ink3))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .focusable(false)
                .help("Focus scope: \(settings.focusDimScope == .sentence ? "Sentence" : "Paragraph") — click to switch")
                .accessibilityLabel("Cycle focus dim scope")
            }
        }
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

/// Session words, the streak and the goal widget, in the web's order and with
/// its rules: each shows only when it has something to say, never nags, and
/// the goal widget appears only once a goal is set (the palette's `set-goal`
/// reaches the settings either way).
private struct WritingProgress: View {
    let settings: StudioSettings
    let wordCount: DocumentWordCount
    let stats: WritingStatsModel?
    let theme: RectoEditorTheme
    let onOpenConfig: () -> Void

    private var target: Int {
        settings.goalScope == .daily ? settings.dailyGoalTarget : settings.wordGoalTarget
    }

    private var goalWords: Int {
        let live = wordCount.value ?? 0
        guard settings.goalScope == .daily else { return live }
        return stats?.todayWords(liveDocumentWords: live) ?? live
    }

    /// The web's `goalLabel`.
    private var goalLabel: String {
        let prefix = settings.goalScope == .daily ? "Daily goal" : "Goal"
        return "\(prefix): \(goalWords.formatted()) / \(target.formatted()) words"
    }

    var body: some View {
        let session = wordCount.sessionWords
        let streak = stats?.streakDays ?? 0
        if session > 0 || streak > 0 {
            StatusDivider(theme: theme)
            HStack(spacing: 8) {
                if session > 0 {
                    Text(verbatim: "+\(session.formatted())")
                        .help("\(session.formatted()) words written this session")
                }
                if streak > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "flame")
                            .foregroundStyle(Color(nsColor: theme.accent))
                        Text(verbatim: String(streak))
                    }
                    .help("\(streak)-day writing streak")
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(streak)-day writing streak")
                }
            }
            .monospacedDigit()
            .foregroundStyle(Color(nsColor: theme.ink3))
        }
        if target > 0 {
            StatusDivider(theme: theme)
            Button(action: onOpenConfig) {
                GoalIndicator(
                    style: settings.goalStyle,
                    progress: WritingGoals.progress(words: goalWords, target: target, kind: settings.wordGoalKind),
                    theme: theme
                )
                .frame(height: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .help(goalLabel)
            .accessibilityLabel(goalLabel)
        }
    }
}

/// The web's `GoalIndicator`: a 14 pt ring or a thin bar, accent while
/// underway and the second accent once met.
private struct GoalIndicator: View {
    let style: GoalStyle
    let progress: GoalProgress
    let theme: RectoEditorTheme

    private var fill: Color {
        Color(nsColor: progress.met ? theme.accent2 : theme.accent)
    }

    var body: some View {
        switch style {
        case .ring:
            ZStack {
                Circle().stroke(Color(nsColor: theme.line), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: progress.ratio)
                    .stroke(fill, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 14, height: 14)
        case .bar:
            Capsule()
                .fill(Color(nsColor: theme.line))
                .frame(width: 40, height: 5)
                .overlay(alignment: .leading) {
                    Capsule().fill(fill).frame(width: 40 * progress.ratio, height: 5)
                }
        }
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
        .help(CommandRegistry.help("Zen mode (hide everything but the page)", command: "toggle-focus"))
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

/// The window's word count and reading time. Only this label observes the
/// count, so a new number re-renders the footer's trailing figures, not the
/// bar.
private struct WordCountLabel: View {
    let count: DocumentWordCount
    let ink: NSColor

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
        HStack(spacing: 8) {
            if let value = count.value {
                Text("^[\(value) word](inflect: true)")
                    .frame(minWidth: Self.wordCountMinWidth, alignment: .trailing)
                Text(verbatim: "·")
                Text(ReadingTime.format(minutes: ReadingTime.minutes(wordCount: value)))
            }
        }
        .monospacedDigit()
        .foregroundStyle(Color(nsColor: ink))
        .help(CommandRegistry.help("Estimated reading time. Hide the bar", command: "toggle-status"))
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
        // Icons, with the mode's name and chord in the tooltip (design §4.1):
        // the lens is chosen rarely and read constantly, so the active wash
        // says enough.
        buttons(labelled: false)
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
        case .rich: CommandRegistry.help(label, command: "mode-rich")
        case .raw: CommandRegistry.help(label, command: "mode-raw")
        case .vim: CommandRegistry.help(label, command: "mode-vim")
        case .preview: CommandRegistry.help(label, command: "mode-preview")
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
