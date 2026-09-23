import AppKit
import Foundation
import Observation
import RectoCoreJS
import RectoEditor

/// `lib/ai/instructions.ts`'s presets, verbatim.
struct TransformPreset: Identifiable, Equatable {
    let id: String
    let label: String
    let prompt: String

    static let all = [
        TransformPreset(id: "tighten", label: "Tighten",
                        prompt: "Tighten this prose. Cut redundancy and filler; keep the meaning, voice, and Markdown formatting intact."),
        TransformPreset(id: "rewrite", label: "Rewrite",
                        prompt: "Rewrite this passage to read more clearly and naturally, preserving its meaning and Markdown formatting."),
        TransformPreset(id: "expand", label: "Expand",
                        prompt: "Expand this passage with a little more detail and supporting texture, staying on topic and preserving Markdown formatting."),
        TransformPreset(id: "fix-grammar", label: "Fix grammar",
                        prompt: "Correct grammar, spelling, and punctuation only. Do not change wording, meaning, voice, or Markdown formatting beyond what the corrections require."),
    ]

    /// `instructionLabel`: the preset's label, or the first 24 characters of free text.
    static func label(presetId: String?, freeText: String) -> String {
        if let preset = all.first(where: { $0.id == presetId }) { return preset.label }
        let text = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "edit" }
        return text.count > 24 ? String(text.prefix(24)) + "…" : text
    }
}

/// One window's AI: the transform sheet, the review run, related passages and
/// re-indexing, with consent and the key asked for when the server wants them.
@MainActor
@Observable
final class AIController {
    enum Sheet: Equatable {
        case consent
        case key
        case transform
    }

    /// What the writer selected when the transform opened.
    struct Selection: Equatable {
        let range: NSRange
        let text: String
        let markdown: String
    }

    enum TransformState: Equatable {
        case picking
        case running
        /// Applied; in pending mode Keep or Reject decides.
        case done(output: String, warnings: [String], awaitingDecision: Bool)
    }

    var sheet: Sheet?
    private(set) var selection: Selection?
    private(set) var transformState: TransformState = .picking
    private(set) var isBusy = false
    private(set) var passages: [AIClient.Passage]?
    var showsRelated = false
    var message: (title: String, body: String, opensReview: Bool)?
    var errorMessage: String?

    @ObservationIgnored private var afterConsent: (() -> Void)?
    @ObservationIgnored private let settings: StudioSettings
    @ObservationIgnored private let chrome: EditorHostController
    @ObservationIgnored private let model: CloudDocumentModel
    @ObservationIgnored private let storage: () -> RectoTextStorage

    init(settings: StudioSettings, chrome: EditorHostController, model: CloudDocumentModel, storage: @escaping () -> RectoTextStorage) {
        self.settings = settings
        self.chrome = chrome
        self.model = model
        self.storage = storage
    }

    private var client: AIClient? { chrome.cloud.map(AIClient.init(cloud:)) }

    // MARK: - Gates

    /// `toggle-ai`: turning it on asks for consent first, as the web does.
    func toggle() {
        if settings.aiEnabled {
            settings.aiEnabled = false
        } else {
            withConsent { [settings] in settings.aiEnabled = true }
        }
    }

    private func withConsent(_ action: @escaping () -> Void) {
        guard let client else {
            errorMessage = "AI needs a synced document."
            return
        }
        Task {
            if (try? await client.hasConsent()) == true {
                action()
            } else {
                afterConsent = action
                sheet = .consent
            }
        }
    }

    func acceptConsent() async {
        guard let client else { return }
        do {
            try await client.acceptConsent()
            sheet = nil
            let next = afterConsent
            afterConsent = nil
            next?()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func declineConsent() {
        afterConsent = nil
        sheet = nil
    }

    func saveKey(_ key: String) async {
        guard let client else { return }
        do {
            try await client.saveKey(key.trimmingCharacters(in: .whitespacesAndNewlines))
            sheet = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func fail(_ error: any Error) {
        switch AIClient.explain(error) {
        case AIClient.Failure.consentRequired:
            sheet = .consent
        case AIClient.Failure.keyRequired:
            sheet = .key
        case let explained:
            errorMessage = explained.localizedDescription
        }
    }

    private func source(_ client: AIClient) async throws -> AIClient.Source {
        try await client.source(head: { model.state.head }, markdown: { storage().markdown })
    }

    // MARK: - Transform

    /// `ai-transform`: open on the selection.
    func beginTransform() {
        beginTransform(on: chrome.seam?.selectedRange ?? NSRange())
    }

    func beginTransform(on range: NSRange) {
        let storage = storage()
        guard range.length > 0 else {
            errorMessage = "Select some text to transform."
            return
        }
        let text = (storage.markdown as NSString).substring(with: range)
        selection = Selection(range: range, text: text, markdown: storage.markdown)
        transformState = .picking
        withConsent { [weak self] in self?.sheet = .transform }
    }

    func runTransform(instruction: String, presetId: String?) async {
        guard let client, let selection else { return }
        let label = TransformPreset.label(presetId: presetId, freeText: instruction)
        transformState = .running
        do {
            let source = try await source(client)
            guard source.markdown == selection.markdown else {
                throw AIClient.Failure.message("The document changed after you selected the text. Select it again.")
            }
            let output = try await client.transform(source, instruction: instruction, selection: selection.text)
            let storage = storage()
            guard storage.markdown == selection.markdown else {
                throw AIClient.Failure.message("The document changed while the AI worked. Nothing was applied.")
            }
            let replaced = (selection.markdown as NSString).replacingCharacters(in: selection.range, with: output)
            let next = (try? await SharedRectoCore.core().normalize(replaced)) ?? replaced
            storage.markdown = next
            model.accept(RectoEditorEdit(markdown: next, structural: true), from: storage, origin: "ai:\(label)")
            await model.save()
            let warnings = (try? await SharedRectoCore.core().transformWarnings(
                original: selection.text, rewritten: output, presetId: presetId)) ?? []
            let pending = settings.aiTransformMode == .pending
            transformState = .done(output: output, warnings: warnings, awaitingDecision: pending)
            if !pending { sheet = nil }
        } catch {
            transformState = .picking
            sheet = nil
            fail(error)
        }
    }

    /// Keep: the edit already landed; close.
    func keep() {
        sheet = nil
        transformState = .picking
    }

    /// Reject: the AI edit is its own node, so undo takes it back.
    func reject() async {
        sheet = nil
        transformState = .picking
        await model.undo()
    }

    // MARK: - Review, related, re-index

    /// `ai-critique`: comments and a suggestion branch land on the server,
    /// where the comments panel and the review surface pick them up.
    func critique() {
        withConsent { [weak self] in Task { await self?.runCritique() } }
    }

    private func runCritique() async {
        guard let client else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let summary = try await client.review(try await source(client))
            let comments = Int(summary.commentsTotal), edits = Int(summary.editsTotal)
            var body = "Placed \(Int(summary.commentsPlaced)) of \(comments) comment\(comments == 1 ? "" : "s")"
            if edits > 0 { body += " and \(Int(summary.editsPlaced)) of \(edits) edit\(edits == 1 ? "" : "s") in a review branch" }
            message = ("AI review", body + ".", summary.commentsPlaced > 0 || summary.editsPlaced > 0)
        } catch {
            fail(error)
        }
    }

    /// `ai-related`: passages from the writer's other drafts like the section
    /// at the caret.
    func findRelated() {
        withConsent { [weak self] in Task { await self?.runRelated() } }
    }

    private func runRelated() async {
        guard let client else { return }
        showsRelated = true
        passages = nil
        do {
            let source = try await source(client)
            let caret = chrome.seam?.selectedRange.location ?? 0
            let query = (try? await Self.section(at: caret, in: source.markdown)) ?? source.markdown
            passages = try await client.related(source, query: query)
        } catch {
            passages = []
            fail(error)
        }
    }

    /// `ai-reindex`.
    func reindex() {
        withConsent { [weak self] in Task { await self?.runReindex() } }
    }

    private func runReindex() async {
        guard let client else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let count = try await client.reindex(try await source(client))
            message = ("Re-indexed", "\(count) passage\(count == 1 ? "" : "s") of this draft can now be found from your other drafts.", false)
        } catch {
            fail(error)
        }
    }

    /// The web's `sectionAtOffset`: from the nearest heading at or before
    /// `offset` to the next heading of the same or a higher level.
    static func section(at offset: Int, in markdown: String) async throws -> String {
        let headings = try await SharedRectoCore.core().parseOutline(markdown)
        let text = markdown as NSString
        let current = headings.last { $0.offset <= offset }
        let next = current.map { current in headings.first { $0.offset > current.offset && $0.depth <= current.depth } }
            ?? headings.first
        let start = current?.offset ?? 0
        let end = next?.offset ?? text.length
        return text.substring(with: NSRange(location: start, length: max(0, end - start)))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
