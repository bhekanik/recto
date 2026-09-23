import CryptoKit
import Foundation
import RectoCoreJS
import RectoSync

/// The Mac side of `convex/ai`: consent, the writer's key, and the four AI
/// features. Every AI call runs against the server's own copy of the
/// document: the request names the server's current node and the SHA-256 of
/// its Markdown, and `verifySource` refuses anything else. So this Mac's edits
/// are pushed and settled first.
@MainActor
struct AIClient {
    /// Where an AI request starts: the synced head and its exact text.
    struct Source: Equatable {
        let documentId: String
        let nodeId: String
        let markdown: String
        var hash: String { AIClient.sha256(markdown) }
    }

    struct TransformResult: Decodable, Sendable {
        let output: String
    }

    /// `AiReviewSummary`.
    struct ReviewSummary: Decodable, Sendable, Equatable {
        let commentsPlaced: Double
        let commentsTotal: Double
        let editsPlaced: Double
        let editsTotal: Double
    }

    struct Passage: Decodable, Sendable, Equatable, Identifiable {
        let documentId: String
        let title: String
        let text: String
        let charStart: Double
        let charEnd: Double
        let score: Double
        var id: String { "\(documentId)-\(Int(charStart))" }
    }

    enum Failure: LocalizedError, Equatable {
        case notSynced
        case consentRequired
        case keyRequired
        case message(String)

        var errorDescription: String? {
            switch self {
            case .notSynced: "Some changes haven't synced yet. AI works on the synced draft; try again once it has."
            case .consentRequired: "Accept the AI notice first."
            case .keyRequired: "Add your OpenRouter key to use AI."
            case .message(let text): text
            }
        }
    }

    let cloud: CloudDocumentContext
    /// Identifies these calls in the server's runs and traces.
    static let platform = "mac"

    nonisolated static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Consent and key

    func hasConsent() async throws -> Bool {
        struct Consent: Decodable { let version: Double; let acceptedAt: Double? }
        let consent: Consent = try await cloud.api.query(ConvexFunction.aiConsentGet, args: [:])
        return consent.acceptedAt != nil
    }

    func acceptConsent() async throws {
        struct Consent: Decodable { let version: Double }
        let current: Consent = try await cloud.api.query(ConvexFunction.aiConsentGet, args: [:])
        let _: ConvexVoid = try await cloud.api.mutation(ConvexFunction.aiConsentAccept, args: ["version": .number(current.version)])
    }

    func keyLast4() async throws -> String? {
        struct Status: Decodable { let configured: Bool; let last4: String? }
        let status: Status = try await cloud.api.query(ConvexFunction.aiCredentialsStatus, args: [:])
        return status.configured ? status.last4 : nil
    }

    func saveKey(_ key: String) async throws {
        let _: ConvexVoid = try await cloud.api.action(ConvexFunction.aiCredentialsSaveKey, args: ["apiKey": .string(key)])
    }

    func removeKey() async throws {
        let _: ConvexVoid = try await cloud.api.mutation(ConvexFunction.aiCredentialsRemove, args: [:])
    }

    // MARK: - Requests

    /// Push this Mac's edits and name the synced head. `markdown` is what the
    /// editor holds; it must be what the server holds too.
    func source(head: () -> String, markdown: () -> String) async throws -> Source {
        guard let documentId = cloud.convexId, await cloud.syncForExport() else { throw Failure.notSynced }
        return Source(documentId: documentId, nodeId: head(), markdown: markdown())
    }

    /// A run left from before (the app quit mid-request) holds the server's
    /// one active-run slot; clear it, or wait if it is still going.
    func clearLeftoverRun(documentId: String, kind: String) async throws {
        struct Run: Decodable { let requestId: String; let status: String }
        let run: Run? = try await cloud.api.query(
            ConvexFunction.aiRunsLatestRecoverable, args: ["documentId": .string(documentId), "kind": .string(kind)])
        guard let run else { return }
        if ["reserved", "provider_started"].contains(run.status) {
            throw Failure.message("An AI request on this document is still running.")
        }
        _ = try await acknowledge(run.requestId)
    }

    func acknowledge(_ requestId: String) async throws -> Bool {
        struct Ack: Decodable { let acknowledged: Bool }
        let ack: Ack = try await cloud.api.mutation(ConvexFunction.aiRunsAcknowledge, args: ["requestId": .string(requestId)])
        return ack.acknowledged
    }

    /// `ai/transform:run`, then acknowledge so the result is this Mac's to apply.
    func transform(_ source: Source, instruction: String, selection: String) async throws -> String {
        try await clearLeftoverRun(documentId: source.documentId, kind: "transform")
        let requestId = UUID().uuidString
        let result: TransformResult = try await cloud.api.action(ConvexFunction.aiTransformRun, args: [
            "requestId": .string(requestId), "documentId": .string(source.documentId),
            "sourceNodeId": .string(source.nodeId), "sourceHash": .string(source.hash),
            "instruction": .string(instruction), "selection": .string(selection),
            "platform": .string(Self.platform), "traceContent": true,
        ])
        guard try await acknowledge(requestId) else {
            throw Failure.message("The AI result could not be claimed. Try again.")
        }
        return result.output
    }

    /// `ai/review:run`: comments and a suggestion branch land on the server.
    func review(_ source: Source) async throws -> ReviewSummary {
        try await clearLeftoverRun(documentId: source.documentId, kind: "review")
        let requestId = UUID().uuidString
        let summary: ReviewSummary = try await cloud.api.action(ConvexFunction.aiReviewRun, args: [
            "requestId": .string(requestId), "documentId": .string(source.documentId),
            "sourceNodeId": .string(source.nodeId), "sourceHash": .string(source.hash),
            "text": .string(source.markdown), "platform": .string(Self.platform), "traceContent": true,
        ])
        _ = try? await acknowledge(requestId)
        return summary
    }

    /// Embeddings, 16 texts per run as on the web. The request id is derived
    /// from the batch, so a retried batch is the same request.
    func embed(_ source: Source, texts: [String], purpose: String) async throws -> [[Double]] {
        var vectors: [[Double]] = []
        for offset in stride(from: 0, to: texts.count, by: 16) {
            let batch = Array(texts[offset..<min(offset + 16, texts.count)])
            let identity = [purpose, source.documentId, source.nodeId, source.hash, String(offset)] + batch
            let requestId = "embed:\(purpose):\(Self.sha256(identity.joined(separator: "\u{1F}")))"
            let result: [[Double]] = try await cloud.api.action(ConvexFunction.aiEmbedRun, args: [
                "requestId": .string(requestId), "documentId": .string(source.documentId),
                "sourceNodeId": .string(source.nodeId), "sourceHash": .string(source.hash),
                "inputs": .array(batch.map(ConvexValue.string)),
                "platform": .string(Self.platform), "traceContent": true,
            ])
            vectors += result
        }
        return vectors
    }

    /// Related passages from the writer's other drafts, for `query` (the
    /// section at the caret, as the web now uses).
    func related(_ source: Source, query: String) async throws -> [Passage] {
        let trimmed = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4_000))
        guard !trimmed.isEmpty, let vector = try await embed(source, texts: [trimmed], purpose: "query").first else { return [] }
        return try await cloud.api.action(ConvexFunction.embeddingsSearchByVector, args: [
            "vector": .array(vector.map(ConvexValue.number)), "excludeDocumentId": .string(source.documentId),
        ])
    }

    /// Re-embed the whole draft and replace its stored chunks. Returns the count.
    func reindex(_ source: Source) async throws -> Int {
        let chunks = try await SharedRectoCore.core().chunk(source.markdown)
        let vectors = chunks.isEmpty ? [] : try await embed(source, texts: chunks.map(\.text), purpose: "reindex")
        guard vectors.count == chunks.count else { throw Failure.message("Embedding count did not match chunk count.") }
        let _: ConvexVoid = try await cloud.api.mutation(ConvexFunction.embeddingsReplaceChunks, args: [
            "documentId": .string(source.documentId), "embeddedNodeId": .string(source.nodeId),
            "expectedMarkdown": .string(source.markdown),
            "chunks": .array(zip(chunks, vectors).map { chunk, vector in
                ["charStart": .number(Double(chunk.charStart)), "charEnd": .number(Double(chunk.charEnd)),
                 "text": .string(chunk.text), "embedding": .array(vector.map(ConvexValue.number))]
            }),
        ])
        return chunks.count
    }

    /// The server's refusals, in words the writer can act on.
    static func explain(_ error: any Error) -> any Error {
        guard let remote = error as? RemoteCallError else { return error }
        switch remote.code {
        case "ai_consent_required": return Failure.consentRequired
        case "ai_credential_required": return Failure.keyRequired
        case "document_shared": return Failure.message("AI is off on shared documents.")
        case "document_changed": return Failure.message("The document changed while the request started. Try again.")
        case "ai_rate_limited": return Failure.message("Too many AI requests. Wait a minute and try again.")
        default: return remote
        }
    }
}
