import AppKit
import RectoEditor
import RectoHistory
import SwiftUI

/// Wordings for one passage, beside the draft. Up and Down show each wording
/// in place, Return with an empty field keeps the one on show, Return with
/// text saves it as another wording, Escape puts the starting wording back.
struct AlternativesPanel: View {
    let model: CloudDocumentModel
    let theme: RectoEditorTheme
    /// The passage the panel opened on, in the draft's UTF-16 offsets.
    let range: NSRange
    let close: () -> Void

    @State private var draft = ""
    @FocusState private var fieldFocused: Bool

    private var group: AlternativeGroup? {
        let writing = model.writing
        return writing.group(covering: range) ?? writing.group(containing: range.location)
    }

    private var shownId: String? { model.preview?.shownId ?? group?.activeId }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Alternatives").font(.system(size: 13, weight: .medium))
                Text("Word").font(.system(size: 12)).foregroundStyle(Color(nsColor: theme.ink3))
                Spacer()
                Button { finish(keeping: false) } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).focusable(false)
                    .help("Close alternatives").accessibilityLabel("Close alternatives")
            }
            .foregroundStyle(Color(nsColor: theme.ink2))
            .padding(.horizontal, 12).frame(height: 36)
            Color(nsColor: theme.line).frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if let group {
                        ForEach(Array(group.candidates.enumerated()), id: \.element.id) { index, candidate in
                            row(candidate, isOriginal: index == 0, in: group)
                        }
                    } else {
                        Text("Type another wording for “\(passage)” and press Return.")
                            .font(.system(size: 12)).foregroundStyle(Color(nsColor: theme.ink3))
                            .padding(.vertical, 6)
                    }
                }
                .padding(12)
            }

            TextField("Add a wording", text: $draft)
                .textFieldStyle(.roundedBorder)
                .focused($fieldFocused)
                .onSubmit(submit)
                .onKeyPress(.upArrow) { step(-1); return .handled }
                .onKeyPress(.downArrow) { step(1); return .handled }
                .onKeyPress(.escape) { finish(keeping: false); return .handled }
                .onExitCommand { finish(keeping: false) }
                .accessibilityLabel("Add a wording")
                .padding(.horizontal, 12)
            Text("↑↓ compare in place · return adds or keeps · esc restores")
                .font(.system(size: 11)).foregroundStyle(Color(nsColor: theme.ink3))
                .padding(12)
        }
        .frame(width: 260)
        .background(Color(nsColor: theme.sheet))
        .overlay(alignment: .trailing) { Color(nsColor: theme.line).frame(width: 1) }
        .onAppear { fieldFocused = true }
    }

    private var passage: String {
        let text = model.storage.markdown as NSString
        guard NSMaxRange(range) <= text.length else { return "" }
        return text.substring(with: range)
    }

    private func row(_ candidate: AlternativeCandidate, isOriginal: Bool, in group: AlternativeGroup) -> some View {
        let isShown = candidate.id == shownId
        return HStack(spacing: 8) {
            // A filled dot for the writer's own wordings, a sparkle for the AI's.
            Image(systemName: candidate.author == .ai ? "sparkle" : "circle.fill")
                .font(.system(size: candidate.author == .ai ? 9 : 5))
                .foregroundStyle(Color(nsColor: isShown ? theme.accent : theme.ink3))
                .frame(width: 12)
                .accessibilityLabel(candidate.author == .ai ? "Suggested by AI" : "Your wording")
            Text(candidate.text)
                .font(.system(size: 13, weight: isShown ? .medium : .regular))
                .foregroundStyle(Color(nsColor: isShown ? theme.ink : theme.ink2))
                .lineLimit(3)
            if isOriginal {
                Text("original").font(.system(size: 11)).foregroundStyle(Color(nsColor: theme.ink3))
            }
            Spacer(minLength: 4)
            if !isShown, !isOriginal {
                Button {
                    Task { await model.removeAlternative(candidate.id, from: group.id) }
                } label: { Image(systemName: "minus.circle") }
                    .buttonStyle(.plain).focusable(false)
                    .help("Remove this wording").accessibilityLabel("Remove \(candidate.text)")
            }
        }
        .padding(.vertical, 4).padding(.horizontal, 6)
        .background(isShown ? Color(nsColor: theme.selection).opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
        .onTapGesture { model.showAlternative(candidate.id, in: group.id) }
        .accessibilityAddTraits(isShown ? [.isButton, .isSelected] : .isButton)
    }

    private func step(_ offset: Int) {
        guard let group, let shownId,
              let index = group.candidates.firstIndex(where: { $0.id == shownId }) else { return }
        let next = (index + offset + group.candidates.count) % group.candidates.count
        model.showAlternative(group.candidates[next].id, in: group.id)
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            finish(keeping: true)
            return
        }
        draft = ""
        let target = group?.range ?? range
        Task { await model.addAlternative(text, at: target) }
    }

    private func finish(keeping: Bool) {
        if keeping {
            Task {
                await model.keepAlternative()
                close()
            }
        } else {
            model.restoreAlternative()
            close()
        }
    }
}
