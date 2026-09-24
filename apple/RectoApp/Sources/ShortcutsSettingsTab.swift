import SwiftUI

/// Settings › Shortcuts: every command that has a chord, by section, with a
/// filter. Everything, chord or not, is also in ⌘K.
struct ShortcutsSettingsTab: View {
    @State private var query = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("Every command is in the palette:")
                    .foregroundStyle(.secondary)
                Keycap(chord: "⌘K")
                Spacer()
                TextField("Filter", text: $query, prompt: Text("Filter shortcuts"))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 180)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)

            Form {
                ForEach(sections, id: \.section) { group in
                    Section(group.section.rawValue) {
                        ForEach(group.actions) { action in
                            LabeledContent(action.label) {
                                Keycap(chord: CommandRegistry.shortcut(for: action.id))
                            }
                        }
                    }
                }
                if sections.isEmpty {
                    Text("No shortcut matches “\(query)”.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .formStyle(.grouped)
        }
        .frame(width: settingsTabWidth, height: 520)
    }

    private var sections: [(section: CommandSection, actions: [CommandAction])] {
        Self.sections(matching: query)
    }

    static func sections(matching query: String) -> [(section: CommandSection, actions: [CommandAction])] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return CommandSection.allCases.compactMap { section in
            let actions = CommandRegistry.actions(in: section)
                .filter { !CommandRegistry.shortcut(for: $0.id).isEmpty }
                .filter { needle.isEmpty || $0.label.lowercased().contains(needle)
                    || $0.aliases.contains { $0.lowercased().contains(needle) } }
            return actions.isEmpty ? nil : (section, actions)
        }
    }
}

/// A chord as keycaps: "⌃⇧B" → ⌃ ⇧ B, each on its own key.
struct Keycap: View {
    let chord: String

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(chord.enumerated()), id: \.offset) { _, key in
                Text(String(key))
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .frame(minWidth: 18, minHeight: 18)
                    .padding(.horizontal, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(.quaternary))
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.separator))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(chord)
    }
}
