import RectoEditor
import SwiftUI

/// Settings › Appearance: a live page beside the controls that change it.
struct AppearanceSettingsTab: View {
    @Bindable var settings: StudioSettings

    init(settings: StudioSettings) {
        self.settings = settings
        // The preview and the cards draw in Recto's bundled faces.
        RectoFonts.register()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            PagePreview(settings: settings)
                .padding([.leading, .vertical], 20)
            Form {
                Section {
                    AppearanceCards(settings: settings)
                    LabeledContent {
                        PaletteSwatches(settings: settings)
                    } label: {
                        // Light is always Paper: the swatches rest dimmed and say so.
                        SettingLabel(title: "Dark theme", symbol: "moon.stars", tint: .indigo)
                    }
                } header: {
                    Text("Appearance")
                }

                Section {
                    Picker(selection: $settings.readingFont) {
                        Text("Serif").tag(ReadingFont.serif)
                        Text("Sans").tag(ReadingFont.sans)
                    } label: {
                        SettingLabel(title: "Font", symbol: "textformat", tint: .orange)
                    }
                    .pickerStyle(.segmented)
                    LabeledContent {
                        HStack(spacing: 10) {
                            Slider(value: readingScale,
                                   in: StudioSettings.readingScaleMin...StudioSettings.readingScaleMax)
                                .frame(width: 110)
                            Button("\(settings.zoomPercent)%", action: settings.zoomReset)
                                .buttonStyle(.borderless)
                                .monospacedDigit()
                                .frame(width: 44, alignment: .trailing)
                                .help(CommandRegistry.help("Reset text size", command: "zoom-reset"))
                        }
                    } label: {
                        SettingLabel(
                            title: "Text size",
                            caption: "Or ⌘= and ⌘- as you write.",
                            symbol: "textformat.size", tint: .orange)
                    }
                } header: {
                    Text("Text")
                }

                Section {
                    Toggle(isOn: $settings.showsSheet) {
                        SettingLabel(
                            title: "Page sheet",
                            caption: "Set the writing column on a sheet over a soft background.",
                            symbol: "doc.plaintext", tint: .teal)
                    }
                } header: {
                    Text("Page")
                }
            }
            .formStyle(.grouped)
            .scrollDisabled(true)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: settingsTabWidth)
    }

    private var readingScale: Binding<Double> {
        Binding(get: { settings.readingScale }, set: settings.setReadingScale)
    }
}

/// System, Light and Dark as small pages, the way the choice will look.
private struct AppearanceCards: View {
    @Bindable var settings: StudioSettings

    var body: some View {
        HStack(spacing: 14) {
            ForEach(StudioSettings.Appearance.allCases, id: \.self) { appearance in
                let isChosen = settings.appearance == appearance
                Button { settings.appearance = appearance } label: {
                    VStack(spacing: 6) {
                        card(appearance)
                            .frame(width: 76, height: 50)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .strokeBorder(isChosen ? Color.accentColor : Color.secondary.opacity(0.3),
                                                  lineWidth: isChosen ? 2.5 : 1))
                        Text(appearance.label)
                            .font(.callout)
                            .foregroundStyle(isChosen ? .primary : .secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Appearance \(appearance.label)")
                .accessibilityAddTraits(isChosen ? .isSelected : [])
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func card(_ appearance: StudioSettings.Appearance) -> some View {
        let dark = settings.palette.colors
        switch appearance {
        case .light: specimen(.paper)
        case .dark: specimen(dark)
        case .system:
            ZStack {
                specimen(.paper)
                specimen(dark).mask(DiagonalHalf())
            }
        }
    }

    private func specimen(_ theme: RectoEditorTheme) -> some View {
        ZStack {
            Color(nsColor: theme.sheet)
            Text("Aa")
                .font(.custom(RectoFonts.proseFamily, size: 20))
                .foregroundStyle(Color(nsColor: theme.ink))
        }
    }
}

/// The lower-right triangle, for the split System card.
private struct DiagonalHalf: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.closeSubpath()
        }
    }
}

/// A page in the current theme, font and size, redrawn as the controls move.
private struct PagePreview: View {
    let settings: StudioSettings

    var body: some View {
        let theme = settings.theme
        let serif = settings.readingFont == .serif
        let family = serif ? RectoFonts.proseFamily : RectoFonts.sansFamily
        let size = 13 * settings.readingScale
        VStack(alignment: .leading, spacing: size * 0.7) {
            Text("The second draft")
                .font(.custom(family, size: size * 1.55).weight(.semibold))
                .foregroundStyle(Color(nsColor: theme.ink))
            Text(paragraph(accent: theme.accent))
                .font(.custom(family, size: size))
                .foregroundStyle(Color(nsColor: theme.ink))
                .lineSpacing(size * 0.45)
            HStack(spacing: 0) {
                Text("Read it out loud")
                    .font(.custom(family, size: size))
                    .foregroundStyle(Color(nsColor: theme.ink))
                    .background(Color(nsColor: theme.selection))
                Rectangle()
                    .fill(Color(nsColor: theme.caret))
                    .frame(width: 2, height: size * 1.25)
            }
            Text("Everything else is patience.")
                .font(.custom(family, size: size))
                .foregroundStyle(Color(nsColor: theme.ink2))
            Spacer(minLength: 0)
        }
        .padding(22)
        .frame(width: 210, height: 300, alignment: .topLeading)
        .clipped()
        .background(Color(nsColor: theme.sheet))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(nsColor: theme.line), lineWidth: 1))
        .animation(.easeOut(duration: 0.2), value: settings.readingScale)
        .accessibilityHidden(true)
    }

    private func paragraph(accent: NSColor) -> AttributedString {
        var link = AttributedString("reader")
        link.foregroundColor = Color(nsColor: accent)
        link.underlineStyle = .single
        return AttributedString("The first draft is for you. The second is for the ")
            + link + AttributedString(": cut everything that only made sense to you.")
    }
}
