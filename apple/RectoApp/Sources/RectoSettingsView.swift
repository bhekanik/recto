import SwiftUI

/// The Settings window (⌘,): every studio setting in one place, a tab per
/// job, each option with a line saying what it does. The status bar's Display
/// panel and ⌘K stay the quick way in; this is where a writer looks around.
struct RectoSettingsView: View {
    let settings: StudioSettings
    @AppStorage("settings.tab") private var tab = SettingsTab.general

    var body: some View {
        TabView(selection: $tab) {
            GeneralSettingsTab(settings: settings)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(SettingsTab.general)
            AppearanceSettingsTab(settings: settings)
                .tabItem { Label("Appearance", systemImage: "paintpalette") }
                .tag(SettingsTab.appearance)
            WritingSettingsTab(settings: settings)
                .tabItem { Label("Writing", systemImage: "pencil.line") }
                .tag(SettingsTab.writing)
            WindowSettingsTab(settings: settings)
                .tabItem { Label("Window", systemImage: "macwindow") }
                .tag(SettingsTab.window)
            ShortcutsSettingsTab()
                .tabItem { Label("Shortcuts", systemImage: "command") }
                .tag(SettingsTab.shortcuts)
        }
    }
}

enum SettingsTab: String {
    case general, appearance, writing, window, shortcuts
}

/// One width for every tab, so switching tabs only ever changes the height.
let settingsTabWidth: CGFloat = 640

/// A setting's label: a tinted symbol, the name, and one line on what it does.
/// Inside a grouped `Form` the second text renders as the row's subtitle.
struct SettingLabel: View {
    let title: String
    var caption: String?
    let symbol: String
    let tint: Color

    var body: some View {
        Label {
            Text(title)
            if let caption {
                Text(caption)
            }
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 20)
        }
    }
}

extension View {
    /// A tab's grouped form, sized to its content so the window fits each tab.
    func settingsForm() -> some View {
        formStyle(.grouped)
            .scrollDisabled(true)
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: settingsTabWidth)
    }
}
