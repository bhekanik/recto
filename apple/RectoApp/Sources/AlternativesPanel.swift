import AppKit
import RectoEditor
import RectoHistory
import SwiftUI

/// Wordings for one passage, beside the draft. Up and Down show each wording
/// in place, Return with an empty field keeps the one on show, Return with
/// text saves it as another wording, Escape puts the starting wording back.
/// The passages around the caret the panel can work on, one per scope, in
/// the draft's UTF-16 offsets.
struct AlternativesTargets: Equatable {
    var ranges: [AlternativeGroup.Scope: NSRange]
    var initial: AlternativeGroup.Scope
}

struct AlternativesPanel: View {
    let model: CloudDocumentModel
    let theme: RectoEditorTheme
    let targets: AlternativesTargets
    let close: () -> Void

    @State private var draft = ""
    @State private var scope: AlternativeGroup.Scope?
    @FocusState private var fieldFocused: Bool

    private var currentScope: AlternativeGroup.Scope { scope ?? targets.initial }
    private var range: NSRange { targets.ranges[currentScope] ?? NSRange(location: 0, length: 0) }

    private var group: AlternativeGroup? {
        let writing = model.writing
        if let exact = writing.group(covering: range) { return exact }
        // A kept wording of another length moves the passage's end, not its start.
        return writing.alternatives.first { !$0.detached && $0.scope == currentScope && $0.location == range.location }
    }

    private var shownId: String? { model.preview?.shownId ?? group?.activeId }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Alternatives").font(.system(size: 13, weight: .medium))
                Spacer()
                Button { finish(keeping: false) } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).focusable(false)
                    .help("Close alternatives").accessibilityLabel("Close alternatives")
            }
            .foregroundStyle(Color(nsColor: theme.ink2))
            .padding(.horizontal, 12).frame(height: 36)
            Color(nsColor: theme.line).frame(height: 1)
            Picker("Scope", selection: Binding(get: { currentScope }, set: { choose($0) })) {
                ForEach([AlternativeGroup.Scope.word, .sentence, .paragraph], id: \.self) { scope in
                    Text(scope.label).tag(scope)
                }
            }
            .pickerStyle(.segmented).labelsHidden()
            .disabled(model.preview != nil)
            .padding(.horizontal, 12).padding(.top, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if let group {
                        ForEach(Array(group.candidates.enumerated()), id: \.element.id) { index, candidate in
                            row(candidate, isOriginal: index == 0, in: group)
                        }
                    } else {
                        Text(targets.ranges[currentScope] == nil
                             ? "There is no \(currentScope.label.lowercased()) at the caret."
                             : "Type another wording for “\(passage)” and press Return.")
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
        Task { await model.addAlternative(text, at: target, scope: currentScope) }
    }

    private func choose(_ next: AlternativeGroup.Scope) {
        guard targets.ranges[next] != nil else { return }
        scope = next
        fieldFocused = true
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

extension AlternativeGroup.Scope {
    var label: String {
        switch self {
        case .word: "Word"
        case .sentence: "Sentence"
        case .paragraph: "Paragraph"
        }
    }
}
