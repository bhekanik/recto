import AppKit
import Foundation
import Observation
import RectoCore
import RectoCoreJS
import RectoEditor
import RectoHistory

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

    /// The Lab's trim proposal: cuts shown faded over `base`, none applied
    /// until the writer makes them.
    struct LabProposal: Equatable {
        let target: Int
        let base: String
        let cuts: [AIClient.LabCut]
        let dropped: Int
        /// Cuts the writer chose to keep the text of.
        var kept: Set<Int> = []
        /// The cut the walkthrough is on, when walking through.
        var walking: Int?

        var cutRanges: [NSRange] { cuts.indices.filter { !kept.contains($0) }.map { cuts[$0].range } }
        var wordsBefore: Int { RectoWordCount.plainText(base) }
        var wordsAfter: Int {
            var text = base as NSString
            for range in cutRanges.sorted(by: { $0.location > $1.location }) {
                text = text.replacingCharacters(in: range, with: "") as NSString
            }
            return RectoWordCount.plainText(text as String)
        }
    }

    enum LabState: Equatable {
        case idle
        case reading(target: Int)
        case reviewing(ReviewPass)
    }

    enum ReviewPass: String, CaseIterable, Equatable {
        case opening, clarity, voice
        var label: String {
            switch self {
            case .opening: "Improve the opening"
            case .clarity: "Find confusing passages"
            case .voice: "Check voice and phrasing"
            }
        }
    }

    /// One editorial pass's result, its ranges kept in step with the text.
    struct LabReview: Equatable {
        struct Finding: Equatable {
            var range: NSRange
            let reason: String
            let suggestion: String?
        }
        let pass: ReviewPass
        let assessment: String
        var findings: [Finding]
        var opening: NSRange?
        let openings: [String]
        let dropped: Int
        /// The text the ranges are offsets into.
        var text: String
    }

    private(set) var labReview: LabReview?

    /// The passage AI wordings are being fetched for.
    private(set) var suggesting: NSRange?
    private(set) var lab: LabProposal?
    private(set) var labState: LabState = .idle
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

    // MARK: - Lab review

    /// Set by the host: open the alternatives panel on a passage.
    @ObservationIgnored var openAlternatives: (NSRange, AlternativeGroup.Scope) -> Void = { _, _ in }

    func review(_ pass: ReviewPass) {
        withConsent { [weak self] in Task { await self?.runReview(pass) } }
    }

    private func runReview(_ pass: ReviewPass) async {
        guard let client, labState == .idle else { return }
        await model.keepAlternative()
        labState = .reviewing(pass)
        defer { labState = .idle }
        do {
            let source = try await source(client)
            let result = try await client.labReview(source, pass: pass.rawValue)
            let length = (source.markdown as NSString).length
            let fits = { (range: NSRange) in range.length > 0 && NSMaxRange(range) <= length }
            var review = LabReview(
                pass: pass, assessment: result.assessment,
                findings: result.findings.filter { fits($0.range) }.map {
                    LabReview.Finding(range: $0.range, reason: $0.reason, suggestion: $0.suggestion)
                },
                opening: result.opening.map(\.range).flatMap { fits($0) ? $0 : nil },
                openings: result.openings, dropped: Int(result.dropped), text: source.markdown)
            // The draft may have moved on while the pass ran; carry the ranges over.
            Self.follow(&review, to: storage().markdown)
            labReview = review
        } catch {
            fail(error)
        }
    }

    func dismissReview() { labReview = nil }

    func dismissFinding(at index: Int) {
        guard labReview?.findings.indices.contains(index) == true else { return }
        labReview?.findings.remove(at: index)
    }

    func showFinding(at index: Int) {
        guard let finding = labReview?.findings[safe: index] else { return }
        chrome.jump(to: finding.range)
    }

    /// Add the finding's suggestion as an AI wording of its passage and open
    /// the alternatives there, so it is compared in place, not applied.
    func compareFinding(at index: Int) async {
        guard let review = labReview, let finding = review.findings[safe: index],
              let suggestion = finding.suggestion else { return }
        let scope = Self.scope(of: (review.text as NSString).substring(with: finding.range))
        await model.addSuggestedAlternatives([suggestion], at: finding.range, scope: scope, on: review.text)
        openAlternatives(finding.range, scope)
    }

    func compareOpenings() async {
        guard let review = labReview, let opening = review.opening, !review.openings.isEmpty else { return }
        await model.addSuggestedAlternatives(review.openings, at: opening, scope: .paragraph, on: review.text)
        openAlternatives(opening, .paragraph)
    }

    static func scope(of passage: String) -> AlternativeGroup.Scope {
        if passage.contains("\n") { return .paragraph }
        return passage.rangeOfCharacter(from: .whitespaces) == nil ? .word : .sentence
    }

    /// Shift the review's ranges through the edit from its text to `markdown`.
    /// A finding the edit cut across is dropped; an edit inside it keeps it.
    static func follow(_ review: inout LabReview, to markdown: String) {
        guard !(review.text as NSString).isEqual(to: markdown) else { return }
        let patch = computePatch(review.text, markdown)
        let delta = patch.insert.count - (patch.to - patch.from)
        func shift(_ range: NSRange) -> NSRange? {
            let start = range.location, end = NSMaxRange(range)
            if patch.to <= start { return NSRange(location: start + delta, length: range.length) }
            if patch.from >= end { return range }
            if patch.from >= start, patch.to <= end, range.length + delta > 0 {
                return NSRange(location: start, length: range.length + delta)
            }
            return nil
        }
        review.findings = review.findings.compactMap { finding in
            shift(finding.range).map { var moved = finding; moved.range = $0; return moved }
        }
        review.opening = review.opening.flatMap(shift)
        review.text = markdown
    }

    // MARK: - Alternatives

    /// Ask for other wordings of `range`; they join its alternatives marked as AI's.
    func suggestAlternatives(for range: NSRange, scope: AlternativeGroup.Scope) {
        withConsent { [weak self] in Task { await self?.runSuggestions(for: range, scope: scope) } }
    }

    private func runSuggestions(for range: NSRange, scope: AlternativeGroup.Scope) async {
        guard let client, suggesting == nil else { return }
        await model.keepAlternative()
        suggesting = range
        defer { suggesting = nil }
        do {
            let source = try await source(client)
            let text = source.markdown as NSString
            guard NSMaxRange(range) <= text.length, range.length > 0 else { return }
            let passage = text.substring(with: range)
            let wordings = try await client.alternatives(
                source, passage: passage, from: range.location, scope: scope.rawValue)
            guard !wordings.isEmpty else {
                message = ("AI alternatives", "The AI had no other wordings for this passage.", false)
                return
            }
            await model.addSuggestedAlternatives(wordings, at: range, scope: scope, on: source.markdown)
        } catch {
            fail(error)
        }
    }

    // MARK: - Lab

    static let trimPresets: [(target: Int, label: String)] = [
        (10, "Slight trim"), (20, "Tighten more"), (30, "Even sharper"), (50, "Cut in half"),
    ]

    static func trimLabel(_ target: Int) -> String {
        trimPresets.first { $0.target == target }?.label ?? "Trim"
    }

    /// Ask for cuts making the draft about `target` percent shorter. Nothing in
    /// the draft changes until the writer makes the cuts.
    func trim(target: Int) {
        withConsent { [weak self] in Task { await self?.runTrim(target: target) } }
    }

    private func runTrim(target: Int) async {
        guard let client, labState == .idle else { return }
        await model.keepAlternative()
        lab = nil
        labState = .reading(target: target)
        defer { labState = .idle }
        do {
            let source = try await source(client)
            let result = try await client.trim(source, target: target)
            guard (storage().markdown as NSString).isEqual(to: source.markdown) else {
                throw AIClient.Failure.message("The draft changed while the Lab read it. Nothing is shown; run it again.")
            }
            let length = (source.markdown as NSString).length
            let cuts = result.cuts.filter { $0.from >= 0 && $0.to > $0.from && Int($0.to) <= length }
            guard !cuts.isEmpty else {
                message = ("\(Self.trimLabel(target))", "The Lab found nothing it would cut.", false)
                return
            }
            lab = LabProposal(target: target, base: source.markdown, cuts: cuts, dropped: Int(result.dropped))
        } catch {
            fail(error)
        }
    }

    /// A click in a faded cut keeps its words; a click on a kept one cuts them again.
    func toggleCut(at location: Int) {
        guard var lab, let index = lab.cuts.firstIndex(where: {
            $0.range.location <= location && location < NSMaxRange($0.range)
        }) else { return }
        if lab.kept.contains(index) { lab.kept.remove(index) } else { lab.kept.insert(index) }
        self.lab = lab
    }

    func walkThrough() {
        guard var lab else { return }
        lab.walking = lab.cuts.indices.first { !lab.kept.contains($0) } ?? 0
        self.lab = lab
        showWalkingCut()
    }

    /// Keep or cut the walkthrough's current cut, then move to the next.
    func decideWalkingCut(keep: Bool) {
        guard var lab, let index = lab.walking else { return }
        if keep { lab.kept.insert(index) } else { lab.kept.remove(index) }
        lab.walking = index + 1 < lab.cuts.count ? index + 1 : nil
        self.lab = lab
        showWalkingCut()
    }

    private func showWalkingCut() {
        guard let lab, let index = lab.walking else { return }
        chrome.jump(to: lab.cuts[index].range)
    }

    func makeCuts() async {
        guard let lab else { return }
        let ranges = lab.cutRanges
        self.lab = nil
        guard !ranges.isEmpty else { return }
        if !(await model.applyCuts(ranges, on: lab.base)) {
            errorMessage = "The draft changed since the Lab read it. Run it again."
        }
    }

    func dismissLab() { lab = nil }

    /// The proposal belongs to the text it was made for; any other text drops
    /// it. A review's findings follow the text instead.
    func followText(_ markdown: String) {
        if let lab, !(lab.base as NSString).isEqual(to: markdown) { self.lab = nil }
        if var review = labReview {
            Self.follow(&review, to: markdown)
            labReview = review
        }
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

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
