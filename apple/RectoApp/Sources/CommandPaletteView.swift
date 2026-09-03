import RectoEditor
import SwiftUI

/// The web's `CommandPalette`: scrim, a card at most 512 pt wide sitting
/// `min(18vh, 7rem)` from the top, a search field, and the sectioned list.
struct CommandPaletteView: View {
    @Bindable var model: PaletteModel
    let theme: RectoEditorTheme
    @FocusState private var searchFocused: Bool

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .top) {
                // The web's `recto-scrim`.
                Color.black.opacity(0.45)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: model.cancel)
                    .accessibilityLabel("Close command palette")
                card
                    .frame(maxWidth: CommandPaletteController.maxWidth)
                    .padding(.horizontal, 16)
                    .padding(.top, min(proxy.size.height * 0.18, 112))
            }
        }
        .ignoresSafeArea()
        .onAppear { searchFocused = true }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Command palette")
    }

    private var card: some View {
        VStack(spacing: 0) {
            TextField(CommandPaletteController.placeholder, text: $model.query)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(Color(nsColor: theme.ink))
                .frame(height: 56)
                .padding(.horizontal, 16)
                .focused($searchFocused)
                .onSubmit(model.runSelected)
                .onKeyPress(.upArrow) {
                    model.moveSelection(by: -1)
                    return .handled
                }
                .onKeyPress(.downArrow) {
                    model.moveSelection(by: 1)
                    return .handled
                }
                .onKeyPress(.escape) {
                    model.cancel()
                    return .handled
                }
            Color(nsColor: theme.line).frame(height: 1)
            list
        }
        .background(Color(nsColor: theme.raised))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: theme.line), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 24, y: 8)
    }

    private var list: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.hasMatches {
                        ForEach(model.visibleSections, id: \.title) { section in
                            Text(section.title.uppercased())
                                .font(.system(size: 11, weight: .medium))
                                .tracking(0.9)
                                .foregroundStyle(Color(nsColor: theme.ink3))
                                .padding(.horizontal, 8)
                                .padding(.top, 12)
                                .padding(.bottom, 4)
                            ForEach(section.items, content: row)
                        }
                    } else {
                        Text("No matches.")
                            .font(.system(size: 13))
                            .foregroundStyle(Color(nsColor: theme.ink3))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    }
                }
                .padding(4)
            }
            .frame(maxHeight: 352)
            .onChange(of: model.selectedIndex) {
                guard let id = model.selectedItem?.id else { return }
                scroller.scrollTo(id)
            }
        }
    }

    private func row(_ item: PaletteItem) -> some View {
        let selected = model.selectedItem == item
        return HStack(spacing: 8) {
            Text(item.label)
                .lineLimit(1)
                .foregroundStyle(Color(nsColor: selected ? theme.ink : theme.ink2))
            Spacer(minLength: 8)
            switch item.detail {
            case let .shortcut(hint):
                KeyCap(text: hint, theme: theme)
            case let .text(text):
                Text(text)
                    .foregroundStyle(Color(nsColor: theme.ink3))
            case nil:
                EmptyView()
            }
        }
        .font(.system(size: 13))
        .padding(8)
        .background(
            selected ? Color(nsColor: theme.accent.withAlphaComponent(0.15)) : .clear,
            in: RoundedRectangle(cornerRadius: 6)
        )
        .overlay(alignment: .leading) {
            if selected {
                Color(nsColor: theme.accent)
                    .frame(width: 2)
                    .padding(.vertical, 7)
                    .clipShape(RoundedRectangle(cornerRadius: 1))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.run(item) }
        .id(item.id)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The web's `recto-kbd`.
private struct KeyCap: View {
    let text: String
    let theme: RectoEditorTheme

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .tracking(0.2)
            .foregroundStyle(Color(nsColor: theme.ink3))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color(nsColor: theme.canvas), in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color(nsColor: theme.line), lineWidth: 1))
    }
}
