import RectoEditor
import SwiftUI

/// The status bar's Display button: every look-and-feel control the bar used to
/// line up, in one panel, so the bar itself keeps only what a writer glances
/// at (mode, words, time, saved). Each control's command is in ⌘K too, and
/// the rows that have a chord show it.
struct DisplaySettingsButton: View {
    let settings: StudioSettings
    let lint: ProseLint?
    let theme: RectoEditorTheme
    @State private var isOpen = false

    var body: some View {
        Button { isOpen.toggle() } label: {
            // Sliders, not "Aa": the Rich text mode button already wears that.
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 12))
                .frame(width: 26, height: 22)
                .foregroundStyle(Color(nsColor: isOpen ? theme.ink : theme.ink3))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help("Display: appearance, font, size and writing aids")
        .accessibilityLabel("Display settings")
        .popover(isPresented: $isOpen, arrowEdge: .top) {
            DisplaySettingsPanel(settings: settings, lint: lint)
        }
    }
}

struct DisplaySettingsPanel: View {
    @Bindable var settings: StudioSettings
    let lint: ProseLint?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            section("Appearance") {
                Picker("Appearance", selection: $settings.appearance) {
                    ForEach(StudioSettings.Appearance.allCases, id: \.self) { appearance in
                        Label(appearance.label, systemImage: appearance.symbol).tag(appearance)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                PaletteSwatches(settings: settings)
            }
            section("Text") {
                Picker("Font", selection: $settings.readingFont) {
                    Text("Serif").font(.custom(RectoFonts.proseFamily, size: 13)).tag(ReadingFont.serif)
                    Text("Sans").font(.custom(RectoFonts.sansFamily, size: 13)).tag(ReadingFont.sans)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: .infinity)
                HStack(spacing: 8) {
                    Text("Size")
                    Spacer()
                    Button("Smaller", systemImage: "minus", action: settings.zoomOut)
                        .labelStyle(.iconOnly)
                        .disabled(!settings.canZoomOut)
                        .help(CommandRegistry.help("Smaller text", command: "zoom-out"))
                    Button("\(settings.zoomPercent)%", action: settings.zoomReset)
                        .monospacedDigit()
                        .frame(minWidth: 48)
                        .help(CommandRegistry.help("Reset text size", command: "zoom-reset"))
                    Button("Bigger", systemImage: "plus", action: settings.zoomIn)
                        .labelStyle(.iconOnly)
                        .disabled(!settings.canZoomIn)
                        .help(CommandRegistry.help("Bigger text", command: "zoom-in"))
                }
                .buttonStyle(.borderless)
            }
            section("Writing aids") {
                toggle("Spellcheck", isOn: $settings.spellcheck, command: "toggle-spellcheck")
                toggle(lintLabel, isOn: $settings.lint, command: "toggle-lint")
                toggle("Typewriter scrolling", isOn: $settings.typewriter, command: "toggle-typewriter")
                toggle("Focus blur", isOn: $settings.focusBlur, command: "toggle-focus-blur")
                toggle("Focus dimming", isOn: $settings.focusDim, command: "toggle-focus-dim")
                if settings.focusDim {
                    Picker("Dim around the", selection: $settings.focusDimScope) {
                        Text("Sentence").tag(FocusDimScope.sentence)
                        Text("Paragraph").tag(FocusDimScope.paragraph)
                    }
                    .pickerStyle(.segmented)
                    .padding(.leading, 2)
                }
            }
            section("Page") {
                toggle("Page sheet", isOn: $settings.showsSheet, command: "toggle-sheet")
                toggle("Quiet chrome while typing", isOn: $settings.quietChrome, command: "toggle-quiet-chrome")
                toggle("Compact status bar", isOn: $settings.compactStatusBar, command: "toggle-compact-status")
            }
        }
        .font(.system(size: 12))
        .padding(16)
        .frame(width: 280)
    }

    private var lintLabel: String {
        guard settings.lint, let count = lint?.count, count > 0 else { return "Prose linter" }
        return "Prose linter · \(count.formatted())"
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .kerning(0.6)
                .foregroundStyle(.secondary)
            content()
        }
    }

    /// A switch with its chord, when the command has one, as a menu shows it.
    private func toggle(_ title: String, isOn: Binding<Bool>, command: String) -> some View {
        Toggle(isOn: isOn) {
            HStack {
                Text(title)
                Spacer()
                let chord = CommandRegistry.shortcut(for: command)
                if !chord.isEmpty {
                    Text(chord).font(.system(size: 11)).foregroundStyle(.tertiary)
                }
            }
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
    }
}

/// The dark palettes as swatches: each one's sheet with its accent. Light is
/// always Paper, so the row rests disabled while the appearance is light.
struct PaletteSwatches: View {
    @Bindable var settings: StudioSettings

    var body: some View {
        HStack(spacing: 10) {
            ForEach(StudioSettings.Palette.allCases, id: \.self) { palette in
                let colors = palette.colors
                let isChosen = settings.palette == palette
                Button { settings.palette = palette } label: {
                    Circle()
                        .fill(Color(nsColor: colors.sheet))
                        .overlay(Circle().inset(by: 6).fill(Color(nsColor: colors.accent)))
                        .overlay(Circle().strokeBorder(
                            isChosen ? Color(nsColor: colors.accent) : Color.secondary.opacity(0.3),
                            lineWidth: isChosen ? 2 : 1))
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .help("Theme: \(palette.label)")
                .accessibilityLabel("Theme \(palette.label)")
                .accessibilityAddTraits(isChosen ? .isSelected : [])
            }
            Spacer()
            Text(settings.canCyclePalette ? settings.palette.label : "Paper")
                .foregroundStyle(.secondary)
        }
        .disabled(!settings.canCyclePalette)
        .opacity(settings.canCyclePalette ? 1 : 0.5)
    }
}
