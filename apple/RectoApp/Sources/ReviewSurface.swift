import RectoEditor
import RectoHistory
import SwiftUI

/// `components/review/review-surface.tsx`: the open suggestion branches, and
/// for the one picked its diff, accepted whole or change by change.
struct ReviewSurface: View {
    let review: ReviewSurfaceModel
    let settings: StudioSettings
    let theme: RectoEditorTheme
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Review suggestions").font(.headline)
                Spacer()
                Button("Done", action: dismiss).keyboardShortcut(.cancelAction)
            }
            if review.branches.isEmpty {
                Text("No open suggestions. Reviewers' tracked changes and AI review edits land here.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(review.branches) { branch in
                Button {
                    Task { await review.select(branch, granularity: settings.diffGranularity) }
                } label: {
                    HStack {
                        Text(branch.reviewerName)
                        Spacer()
                        Text("^[\(Int(branch.nodeCount)) edit](inflect: true)").foregroundStyle(.secondary)
                        Text(HistoryPanel.time(branch.updatedAt)).foregroundStyle(.secondary)
                    }
                    .padding(8)
                    .background(review.selectedId == branch.id ? Color.accentColor.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 6))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if review.diff != nil { diffArea }
        }
        .padding(20)
        .frame(width: 620)
        .frame(minHeight: 260)
        .alert("Review", isPresented: Binding(
            get: { review.errorMessage != nil }, set: { if !$0 { review.errorMessage = nil } }
        )) {} message: {
            Text(review.errorMessage ?? "")
        }
    }

    private var diffArea: some View {
        let runs = review.runs(granularity: settings.diffGranularity)
        let hunks = groupHunks(runs)
        return VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack {
                DiffRunsToggle(settings: settings, theme: theme).disabled(review.perHunk)
                Spacer()
                if hunks.count > 1 {
                    Toggle(review.perHunk ? "Reviewing each change" : "Review each change", isOn: Binding(
                        get: { review.perHunk }, set: { review.perHunk = $0 }))
                        .toggleStyle(.button)
                        .controlSize(.small)
                }
            }
            ScrollView {
                if review.perHunk {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(hunks, id: \.index) { hunk in
                            Toggle(isOn: Binding(get: { review.accepted.contains(hunk.index) }, set: { _ in review.toggle(hunk.index) })) {
                                Text(DiffRunsView.attributed(hunk.runIndices.map { runs[$0] }, theme: theme))
                                    .font(.system(size: 12))
                            }
                            .toggleStyle(.checkbox)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    DiffRunsView(runs: runs, layout: settings.diffLayout, theme: theme)
                }
            }
            .frame(maxHeight: 360)
            HStack {
                Spacer()
                Button("Reject", role: .destructive) { Task { await review.reject() } }
                Button(acceptTitle(hunks.count)) { Task { await review.accept(granularity: settings.diffGranularity) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(review.perHunk && review.accepted.isEmpty)
            }
        }
    }

    private func acceptTitle(_ total: Int) -> String {
        guard review.perHunk, review.accepted.count < total else { return "Accept all" }
        return "Accept \(review.accepted.count) of \(total)"
    }
}
