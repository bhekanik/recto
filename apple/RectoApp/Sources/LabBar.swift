import AppKit
import RectoEditor
import SwiftUI

/// Under the draft while the Lab works or shows a proposal: how much the cuts
/// would take, and the choices the walkthrough video shows (make the cuts,
/// walk through them, or set the proposal aside).
struct LabBar: View {
    let ai: AIController
    let theme: RectoEditorTheme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            switch (ai.labState, ai.lab) {
            case let (.reading(target), _):
                ProgressView().controlSize(.small)
                Text("\(AIController.trimLabel(target)) · Reading the draft…")
            case let (.reviewing(pass), _):
                ProgressView().controlSize(.small)
                Text("\(pass.label) · Reading the draft…")
            case let (.idle, lab?):
                if let index = lab.walking {
                    walkthrough(lab, index)
                } else {
                    summary(lab)
                }
            default:
                EmptyView()
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 12))
        .foregroundStyle(Color(nsColor: theme.ink2))
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(Color(nsColor: theme.raised))
        .overlay(alignment: .top) { Color(nsColor: theme.line).frame(height: 1) }
    }

    private func summary(_ lab: AIController.LabProposal) -> some View {
        let before = lab.wordsBefore, after = lab.wordsAfter
        let percent = before == 0 ? 0 : Int((Double(before - after) / Double(before) * 100).rounded())
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(AIController.trimLabel(lab.target)) · \(before) → \(after) words · −\(percent)%")
                    .foregroundStyle(Color(nsColor: theme.ink))
                Text(lab.dropped > 0
                     ? "Faded words would go. Click one to keep it. \(lab.dropped) suggestion\(lab.dropped == 1 ? "" : "s") could not be placed exactly and were left out."
                     : "Faded words would go. Click one to keep it.")
                    .foregroundStyle(Color(nsColor: theme.ink3))
            }
            Button("Make the cuts") { Task { await ai.makeCuts() } }
                .disabled(lab.cutRanges.isEmpty)
            Button("Walk through", action: ai.walkThrough)
            Button("Done", action: ai.dismissLab).keyboardShortcut(.cancelAction)
        }
    }

    private func walkthrough(_ lab: AIController.LabProposal, _ index: Int) -> some View {
        let cut = lab.cuts[index]
        let kept = lab.kept.contains(index)
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Cut \(index + 1) of \(lab.cuts.count)\(kept ? " · kept" : "")")
                    .foregroundStyle(Color(nsColor: theme.ink))
                Text(cut.reason.isEmpty ? "No reason given." : cut.reason)
                    .foregroundStyle(Color(nsColor: theme.ink3))
            }
            Button("Keep the words") { ai.decideWalkingCut(keep: true) }
            Button("Cut them") { ai.decideWalkingCut(keep: false) }
            Button("Done", action: ai.dismissLab).keyboardShortcut(.cancelAction)
        }
    }
}
