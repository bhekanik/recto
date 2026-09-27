import AppKit
import RectoCoreJS
import RectoEditor
import SwiftUI

/// The web's `components/outline/outline-panel.tsx`: a trailing panel listing
/// the document's headings, indented by depth, with the level on the right.
/// Clicking one moves the caret to the heading and brings it on screen.
///
/// Takes the storage rather than its markdown so that only this panel observes
/// the text — the host's body, and with it the editor's update pass, stays out
/// of the keystroke path (the status bar's word count does the same). The
/// outline is re-parsed through the JS core after a pause: the whole-document
/// call is not a per-keystroke API, so each change waits 250 ms and one parse
/// runs after the last edit, with the first appearance parsed at once so the
/// panel never opens empty.
struct OutlinePanel: View {
    let storage: RectoTextStorage
    let theme: RectoEditorTheme
    /// The host's `EditorHostController`, which owns the jump.
    let jump: (OutlineHeading) -> Void
    /// The host's `toggle-outline` flip, so the panel's close button is the
    /// palette's own toggle and not a panel-local one.
    let close: () -> Void
    /// `RectoCore.parseOutline`, injected so a test can watch how often the
    /// document is parsed.
    var parse: @Sendable (String) async throws -> [OutlineHeading] = { markdown in
        try await SharedRectoCore.core().parseOutline(markdown)
    }
    /// `RectoCore.findFlags`, for the dot on headings with an open flag.
    var findFlags: @Sendable (String) async throws -> [WritingFlag] = { markdown in
        try await SharedRectoCore.core().findFlags(markdown)
    }
    @State private var headings: [OutlineHeading]?
    @State private var flagged: Set<Int> = []
    @State private var didParseFirst = false

    /// The web's `w-[min(20rem,100vw)]`.
    private static let width: CGFloat = 320
    /// One pause's worth of typing, then a parse on the JS core's own queue.
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
        .task(id: OutlineText(markdown)) {
            if !didParseFirst {
                didParseFirst = true
                await refresh(markdown)
                return
            }
            try? await Task.sleep(for: Self.refreshDelay)
            guard !Task.isCancelled else { return }
            await refresh(markdown)
        }
    }

    private var header: some View {
        HStack {
            Text("Outline")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color(nsColor: theme.ink2))
            Spacer()
            Button {
                close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 24, height: 24)
                    .foregroundStyle(Color(nsColor: theme.ink3))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable(false)
            .help("Close outline")
            .accessibilityLabel("Close outline")
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let headings, !headings.isEmpty {
                    ForEach(headings, id: \.index) { heading in
                        row(heading)
                    }
                } else {
                    // The web's placeholder, shown before the first parse
                    // lands and for a document with no headings.
                    Text(headings == nil ? "" : "No headings yet.")
                        .font(.system(size: 13))
                        .foregroundStyle(Color(nsColor: theme.ink3))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                }
            }
            .padding(8)
        }
    }

    private func row(_ heading: OutlineHeading) -> some View {
        Button {
            jump(heading)
        } label: {
            HStack(spacing: 8) {
                Text(heading.text.isEmpty ? "(untitled heading)" : heading.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, CGFloat(max(heading.depth - 1, 0)) * 16 + 8)
                    .foregroundStyle(Color(nsColor: theme.ink2))
                Spacer(minLength: 8)
                if flagged.contains(heading.index) {
                    Circle()
                        .fill(Color(nsColor: theme.flagColor))
                        .frame(width: 6, height: 6)
                        .help("Has open flags")
                        .accessibilityLabel("Has open flags")
                }
                Text(verbatim: "H\(heading.depth)")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(nsColor: theme.ink3))
            }
            .font(.system(size: 13))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .help("Jump to heading")
        .accessibilityLabel("Jump to heading “\(heading.text)”")
    }

    private func refresh(_ markdown: String) async {
        guard let parsed = try? await parse(markdown) else { return }
        // A failed parse keeps what was there; an empty one is a real answer.
        headings = parsed
        if let flags = try? await findFlags(markdown) {
            flagged = FlaggedHeadings.indexes(parsed, flags)
        }
    }
}

/// Equality by bytes, so an unchanged string costs a pointer check and a
/// cancelled task, not another JS-core parse.
private struct OutlineText: Equatable {
    let value: String

    init(_ value: String) {
        self.value = value
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.value as NSString).isEqual(to: rhs.value)
    }
}