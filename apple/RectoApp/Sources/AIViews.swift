import RectoEditor
import SwiftUI

/// The sheet the window's AI controller asks for.
struct AISheetView: View {
    let ai: AIController
    let settings: StudioSettings

    var body: some View {
        switch ai.sheet {
        case .consent: ConsentSheet(ai: ai)
        case .key: KeySheet(ai: ai)
        case .transform: TransformSheet(ai: ai, settings: settings)
        case nil: EmptyView()
        }
    }
}

/// `ai-consent-dialog.tsx`, word for word.
private struct ConsentSheet: View {
    let ai: AIController
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enable AI features?").font(.headline)
            Text("Recto sends the selected text or draft to OpenRouter and the model provider for transforms, reviews, and related-passage search. Full inputs and outputs are also sent to LangSmith for tracing and evals. Your saved OpenRouter key is used when configured; otherwise an eligible Recto house key is used. You can turn AI off later.")
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Decline", action: ai.declineConsent).keyboardShortcut(.cancelAction).disabled(busy)
                Button(busy ? "Enabling…" : "Accept and enable") {
                    busy = true
                    Task { await ai.acceptConsent(); busy = false }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}

/// Bring your own key: the writer's OpenRouter key, stored encrypted on the server.
private struct KeySheet: View {
    let ai: AIController
    @State private var key = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add your OpenRouter key").font(.headline)
            Text("AI runs on your own OpenRouter account. The key is encrypted on Recto's server and used only for your requests.")
                .fixedSize(horizontal: false, vertical: true)
            SecureField("sk-or-…", text: $key).textFieldStyle(.roundedBorder)
            HStack {
                Link("Get a key", destination: URL(string: "https://openrouter.ai/keys")!)
                Spacer()
                Button("Cancel") { ai.sheet = nil }.keyboardShortcut(.cancelAction)
                Button("Save") { Task { await ai.saveKey(key) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}

/// `ai-transform-popover.tsx`: a preset or your own instruction, then the
/// result, with the web's checks beside Keep and Reject in pending mode.
private struct TransformSheet: View {
    let ai: AIController
    let settings: StudioSettings
    @State private var instruction = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch ai.transformState {
            case .picking:
                Text("Transform with AI").font(.headline)
                ForEach(TransformPreset.all) { preset in
                    Button {
                        Task { await ai.runTransform(instruction: preset.prompt, presetId: preset.id) }
                    } label: {
                        Text(preset.label).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                TextField("Or describe the change…", text: $instruction)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(runFreeText)
                HStack {
                    Text("\(ai.selection?.text.count ?? 0) characters selected · reversible — undo to reject")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { ai.sheet = nil }.keyboardShortcut(.cancelAction)
                    Button("Run", action: runFreeText).disabled(instruction.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            case .running:
                ProgressView("Transforming…")
                    .frame(maxWidth: .infinity)
            case .done(let output, let warnings, let awaitingDecision):
                Text("AI suggestion").font(.headline)
                ScrollView {
                    Text(output).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 280)
                if !warnings.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(warnings, id: \.self) { Text($0) }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Checks on this suggestion")
                }
                HStack {
                    Spacer()
                    if awaitingDecision {
                        Button("Reject (undo)") { Task { await ai.reject() } }.keyboardShortcut(.cancelAction)
                        Button("Keep", action: ai.keep).keyboardShortcut(.defaultAction)
                    } else {
                        Button("Close", action: ai.keep).keyboardShortcut(.defaultAction)
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func runFreeText() {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Task { await ai.runTransform(instruction: text, presetId: nil) }
    }
}

/// `related-passages-panel.tsx` as a trailing panel.
struct RelatedPanel: View {
    let ai: AIController
    let theme: RectoEditorTheme
    let open: (AIClient.Passage) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Related passages").font(.system(size: 12, weight: .medium)).foregroundStyle(Color(nsColor: theme.ink2))
                Spacer()
                Button { ai.showsRelated = false } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color(nsColor: theme.ink3))
                    .help("Close related passages")
                    .accessibilityLabel("Close related passages")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            Color(nsColor: theme.line).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let passages = ai.passages {
                        if passages.isEmpty {
                            Text("No related passages found. Try “Re-index this draft for search” on your other drafts first.")
                                .font(.system(size: 12)).foregroundStyle(Color(nsColor: theme.ink3))
                        }
                        ForEach(passages) { passage in
                            Button { open(passage) } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(passage.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                        Spacer()
                                        Text("\(Int((passage.score * 100).rounded()))%").font(.system(size: 10))
                                            .foregroundStyle(Color(nsColor: theme.ink3))
                                    }
                                    Text(passage.text.trimmingCharacters(in: .whitespacesAndNewlines))
                                        .font(.system(size: 12)).lineLimit(3)
                                        .foregroundStyle(Color(nsColor: theme.ink2))
                                }
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(nsColor: theme.raised), in: RoundedRectangle(cornerRadius: 6))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        ProgressView("Searching your past drafts…").frame(maxWidth: .infinity)
                    }
                }
                .padding(12)
            }
            Color(nsColor: theme.line).frame(height: 1)
            Text("Semantic matches from your own drafts · click to open")
                .font(.system(size: 10)).foregroundStyle(Color(nsColor: theme.ink3)).padding(8)
        }
        .frame(width: 320)
        .background(Color(nsColor: theme.sheet))
        .overlay(alignment: .leading) { Color(nsColor: theme.line).frame(width: 1) }
    }
}
