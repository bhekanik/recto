import RectoCoreJS
import RectoEditor
import RectoHistory
import SwiftUI

/// Settings › Writing: what checks the prose, what keeps the writer's place,
/// and how a compare reads.
struct WritingSettingsTab: View {
    @Bindable var settings: StudioSettings

    var body: some View {
        Form {
            Section {
                toggle("Spellcheck", caption: "Underline words the dictionary doesn’t know.",
                       symbol: "textformat.abc.dottedunderline", isOn: $settings.spellcheck,
                       command: "toggle-spellcheck")
                toggle("Smart paste", caption: "Turn text pasted from Word, Docs or the web into clean Markdown.",
                       symbol: "doc.on.clipboard", isOn: $settings.smartPaste,
                       command: "toggle-smart-paste")
                toggle("Prose linter", caption: "Mark passive voice, hard sentences, adverbs and weasel words.",
                       symbol: "text.magnifyingglass", isOn: $settings.lint, command: "toggle-lint")
                if settings.lint {
                    ForEach(LintCategory.allCases, id: \.self) { category in
                        Toggle(Self.lintLabel(category), isOn: lintCategory(category))
                            .padding(.leading, 28)
                            .controlSize(.small)
                    }
                }
            } header: {
                Text("Checking")
            }

            Section {
                toggle("Typewriter scrolling", caption: "Keep the line you’re writing in the middle of the window.",
                       symbol: "text.aligncenter", isOn: $settings.typewriter, command: "toggle-typewriter")
                toggle("Focus blur", caption: "Blur every other line, more the further away. Scrolls like a typewriter.",
                       symbol: "camera.filters", isOn: $settings.focusBlur, command: "toggle-focus-blur")
                toggle("Focus dimming", caption: "Fade everything but the sentence or paragraph you’re in.",
                       symbol: "circle.lefthalf.filled", isOn: $settings.focusDim, command: "toggle-focus-dim")
                if settings.focusDim {
                    Picker("Dim around the", selection: $settings.focusDimScope) {
                        Text("Sentence").tag(FocusDimScope.sentence)
                        Text("Paragraph").tag(FocusDimScope.paragraph)
                    }
                    .pickerStyle(.segmented)
                    .padding(.leading, 28)
                }
            } header: {
                Text("Focus")
            }

            Section {
                Picker(selection: $settings.diffGranularity) {
                    Text("Words").tag(DiffGranularity.word)
                    Text("Lines").tag(DiffGranularity.line)
                } label: {
                    SettingLabel(title: "Compare by", caption: "How History and Review split changes.",
                                 symbol: "arrow.left.arrow.right", tint: .green)
                }
                Picker(selection: $settings.diffLayout) {
                    Text("Inline").tag(StudioSettings.DiffLayout.inline)
                    Text("Side by side").tag(StudioSettings.DiffLayout.sideBySide)
                } label: {
                    SettingLabel(title: "Layout", symbol: "rectangle.split.2x1", tint: .green)
                }
            } header: {
                Text("Compare")
            }
        }
        .settingsForm()
    }

    private func toggle(_ title: String, caption: String, symbol: String, isOn: Binding<Bool>,
                        command: String) -> some View {
        Toggle(isOn: isOn) {
            SettingLabel(title: title, caption: caption, symbol: symbol, tint: .orange)
        }
        .help(CommandRegistry.help(title, command: command))
    }

    private func lintCategory(_ category: LintCategory) -> Binding<Bool> {
        Binding(
            get: { settings.lintCategories.contains(category) },
            set: { isOn in
                if isOn != settings.lintCategories.contains(category) { settings.toggleLintCategory(category) }
            })
    }

    static func lintLabel(_ category: LintCategory) -> String {
        switch category {
        case .passive: "Passive voice"
        case .readability: "Hard-to-read sentences"
        case .adverb: "Adverbs"
        case .weasel: "Weasel words"
        }
    }
}
