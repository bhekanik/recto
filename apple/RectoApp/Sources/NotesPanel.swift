import AppKit
import RectoCoreJS
import RectoEditor
import SwiftUI

/// The web's `components/flags/notes-panel.tsx`: the document's writing flags
/// beside the text, in document order. Go to puts the caret after a flag (and
/// closes the panel unless it is pinned); Resolve takes the flag out.
///
/// Like `OutlinePanel`, it takes the storage so only it observes the text, and
/// re-finds flags through the JS core after a pause in typing.
struct NotesPanel: View {
    let storage: RectoTextStorage
    let theme: RectoEditorTheme
    let settings: StudioSettings
    let goTo: (WritingFlag) -> Void
    let resolve: (WritingFlag) -> Void
    let close: () -> Void
    /// `RectoCore.findFlags`, injected for tests.
    var find: @Sendable (String) async throws -> [WritingFlag] = { markdown in
        try await SharedRectoCore.core().findFlags(markdown)
    }
    @State private var flags: [WritingFlag]?
    @State private var didFindFirst = false

    private static let width: CGFloat = 320
    private static let refreshDelay: Duration = .milliseconds(250)

    var body: some View {
        let markdown = storage.markdown
        VStack(spacing: 0) {
            header
            Color(nsColor: theme.line).frame(height: 1)
            list
        }
        .frame(width: Self.width)
        .background(Color(nsColor: theme.sheet))
        .overlay(alignment: .leading) { Color(nsColor: theme.line).frame(width: 1) }
        .task(id: NotesText(markdown)) {
            if didFindFirst {
                try? await Task.sleep(for: Self.refreshDelay)
                guard !Task.isCancelled else { return }
            }
            didFindFirst = true
            if let found = try? await find(markdown) { flags = found }
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Text("Notes")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color(nsColor: theme.ink2))
            if let count = flags?.count, count > 0 {
                Text(verbatim: "\(count)")
                    .font(.system(size: 13))
                    .foregroundStyle(Color(nsColor: theme.ink3))
            }
            Spacer()
            iconButton(
                settings.notesPinned ? "pin.slash" : "pin",
                help: settings.notesPinned ? "Unpin" : "Keep open while revising",
                label: settings.notesPinned ? "Unpin notes panel" : "Pin notes panel open",
                action: settings.toggleNotesPinned)
            iconButton("xmark", help: "Close notes", label: "Close notes", action: close)
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if let flags, !flags.isEmpty {
                    ForEach(flags, id: \.from) { flag in
                        row(flag)
                    }
                } else {
                    Text(flags == nil ? "" : "No flags. Press ⌘⇧X while writing to flag a spot and keep going.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color(nsColor: theme.ink3))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(16)
                }
            }
            .padding(8)
        }
    }

    private func row(_ flag: WritingFlag) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button {
                goTo(flag)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "flag.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Color(nsColor: theme.flagColor))
                    Text(flag.note.isEmpty ? "No note" : flag.note)
                        .italic(flag.note.isEmpty)
                        .foregroundStyle(Color(nsColor: flag.note.isEmpty ? theme.ink3 : theme.ink))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.system(size: 13))
                .padding(.vertical, 5)
                .padding(.leading, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .help("Go to this flag")
            .accessibilityLabel(flag.note.isEmpty ? "Go to flag" : "Go to flag: \(flag.note)")
            iconButton(
                "checkmark", help: "Resolve (remove the flag)",
                label: flag.note.isEmpty ? "Resolve flag" : "Resolve flag: \(flag.note)"
            ) { resolve(flag) }
        }
    }

    private func iconButton(_ symbol: String, help: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 24, height: 24)
                .foregroundStyle(Color(nsColor: theme.ink3))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help(help)
        .accessibilityLabel(label)
    }
}

/// Equality by bytes, as `OutlinePanel`'s: unchanged text is no new parse.
private struct NotesText: Equatable {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.value as NSString).isEqual(to: rhs.value)
    }
}
