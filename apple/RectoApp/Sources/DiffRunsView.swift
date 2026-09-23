import RectoEditor
import RectoHistory
import SwiftUI

/// `components/review/diff-runs-view.tsx`: a diff as runs, inline (deletions
/// struck through, insertions washed) or side by side (the old text with its
/// deletions, the new with its insertions). Shared by version compare and the
/// review surface.
struct DiffRunsView: View {
    let runs: [DiffRun]
    let layout: StudioSettings.DiffLayout
    let theme: RectoEditorTheme

    var body: some View {
        switch layout {
        case .inline:
            text(runs)
        case .sideBySide:
            HStack(alignment: .top, spacing: 12) {
                text(runs.filter { $0.type != .add })
                Color(nsColor: theme.line).frame(width: 1)
                text(runs.filter { $0.type != .del })
            }
        }
    }

    private func text(_ runs: [DiffRun]) -> some View {
        Text(Self.attributed(runs, theme: theme))
            .font(.system(size: 12))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    static func attributed(_ runs: [DiffRun], theme: RectoEditorTheme) -> AttributedString {
        var result = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            switch run.type {
            case .same:
                piece.foregroundColor = Color(nsColor: theme.ink2)
            case .add:
                piece.foregroundColor = Color(nsColor: theme.ink)
                piece.backgroundColor = Color(nsColor: theme.accent.withAlphaComponent(0.22))
            case .del:
                piece.foregroundColor = Color(nsColor: theme.ink3)
                piece.strikethroughStyle = .single
            }
            result += piece
        }
        return result
    }
}

/// The web's `DiffRunsToggle`: word/line and inline/side-by-side.
struct DiffRunsToggle: View {
    let settings: StudioSettings
    let theme: RectoEditorTheme

    var body: some View {
        HStack(spacing: 8) {
            Picker("Granularity", selection: Binding(get: { settings.diffGranularity }, set: { settings.diffGranularity = $0 })) {
                Text("Word").tag(DiffGranularity.word)
                Text("Line").tag(DiffGranularity.line)
            }
            Picker("Layout", selection: Binding(get: { settings.diffLayout }, set: { settings.diffLayout = $0 })) {
                Text("Inline").tag(StudioSettings.DiffLayout.inline)
                Text("Side by side").tag(StudioSettings.DiffLayout.sideBySide)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
    }
}
