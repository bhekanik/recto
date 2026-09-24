import SwiftUI

/// Settings › Window: the chrome around the page, and how Preview frames it.
struct WindowSettingsTab: View {
    @Bindable var settings: StudioSettings

    var body: some View {
        Form {
            Section {
                toggle("Formatting toolbar", caption: "Bold, headings, lists and links above the page.",
                       symbol: "textformat", isOn: $settings.showToolbar, command: "toggle-toolbar")
                toggle("Status bar", caption: "Mode, word count, reading time and save state below the page.",
                       symbol: "rectangle.bottomthird.inset.filled", isOn: $settings.showStatusBar,
                       command: "toggle-status")
                toggle("Compact status bar", caption: "Keep display controls behind one button in the status bar.",
                       symbol: "slider.horizontal.3", isOn: $settings.compactStatusBar,
                       command: "toggle-compact-status")
                toggle("Outline", caption: "The document’s headings in a panel beside the page.",
                       symbol: "list.bullet.indent", isOn: $settings.showOutline, command: "toggle-outline")
            } header: {
                Text("Around the page")
            }

            Section {
                toggle("Quiet chrome while typing", caption: "Fade the toolbar and status bar as you type; move the pointer to bring them back.",
                       symbol: "eye.slash", isOn: $settings.quietChrome, command: "toggle-quiet-chrome")
            } header: {
                Text("While you write")
            }

            Section {
                toggle("Preview as an email", caption: "Show Preview inside an inbox, to see a newsletter as readers will.",
                       symbol: "envelope", isOn: emailPreview, command: "toggle-email-preview")
            } header: {
                Text("Preview")
            }
        }
        .settingsForm()
    }

    private var emailPreview: Binding<Bool> {
        Binding(
            get: { settings.previewVariant == .email },
            set: { settings.previewVariant = $0 ? .email : .rendered })
    }

    private func toggle(_ title: String, caption: String, symbol: String, isOn: Binding<Bool>,
                        command: String) -> some View {
        Toggle(isOn: isOn) {
            SettingLabel(title: title, caption: caption, symbol: symbol, tint: .blue)
        }
        .help(CommandRegistry.help(title, command: command))
    }
}
