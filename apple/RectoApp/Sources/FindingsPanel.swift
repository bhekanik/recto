import AppKit
import RectoEditor
import SwiftUI

/// A Lab review beside the draft: the editor's assessment, then each finding
/// with its reason. A suggestion is never applied from here; `Compare wording`
/// adds it as an alternative so the writer reads it in place first.
struct FindingsPanel: View {
    let ai: AIController
    let review: AIController.LabReview
    let theme: RectoEditorTheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(review.pass.label).font(.system(size: 13, weight: .medium))
                Spacer()
                Button(action: ai.dismissReview) { Image(systemName: "xmark") }
                    .buttonStyle(.plain).focusable(false)
                    .help("Close the review").accessibilityLabel("Close the review")
            }
            .foregroundStyle(Color(nsColor: theme.ink2))
            .padding(.horizontal, 12).frame(height: 36)
            Color(nsColor: theme.line).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !review.assessment.isEmpty {
                        Text(review.assessment)
                            .font(.system(size: 13))
                            .foregroundStyle(Color(nsColor: theme.ink))
                            .textSelection(.enabled)
                    }
                    if review.opening != nil, !review.openings.isEmpty {
                        Button("Compare \(review.openings.count) opening\(review.openings.count == 1 ? "" : "s")") {
                            Task { await ai.compareOpenings() }
                        }
                    }
                    ForEach(Array(review.findings.enumerated()), id: \.offset) { index, finding in
                        findingRow(index, finding)
                    }
                    if review.findings.isEmpty {
                        Text("No passages to point at.")
                            .font(.system(size: 12)).foregroundStyle(Color(nsColor: theme.ink3))
                    }
                    if review.dropped > 0 {
                        Text("\(review.dropped) point\(review.dropped == 1 ? "" : "s") could not be matched to exact words in the draft and were left out.")
                            .font(.system(size: 11)).foregroundStyle(Color(nsColor: theme.ink3))
                    }
                }
                .padding(12)
            }
        }
        .frame(width: 300)
        .background(Color(nsColor: theme.sheet))
        .overlay(alignment: .leading) { Color(nsColor: theme.line).frame(width: 1) }
    }

    private func findingRow(_ index: Int, _ finding: AIController.LabReview.Finding) -> some View {
        let text = review.text as NSString
        let quote = NSMaxRange(finding.range) <= text.length ? text.substring(with: finding.range) : ""
        return VStack(alignment: .leading, spacing: 6) {
            Text("“\(quote)”")
                .font(.system(size: 12)).italic()
                .foregroundStyle(Color(nsColor: theme.ink2))
                .lineLimit(3)
            Text(finding.reason)
                .font(.system(size: 12))
                .foregroundStyle(Color(nsColor: theme.ink))
                .textSelection(.enabled)
            HStack(spacing: 8) {
                Button("Show") { ai.showFinding(at: index) }
                if finding.suggestion != nil {
                    Button("Compare wording") { Task { await ai.compareFinding(at: index) } }
                }
                Button("Dismiss") { ai.dismissFinding(at: index) }
            }
            .controlSize(.small)
        }
    }
}
