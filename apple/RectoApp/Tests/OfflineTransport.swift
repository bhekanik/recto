import RectoSync

/// A server that is never reached: every call that would write fails, every
/// stream ends at once. For tests that need a signed-in library on screen
/// without a network.
actor OfflineTransport: RectoTransport {
    enum Failure: Error { case unexpectedCall }
    func createDocument(title: String, documentUuid: String) async throws
        -> CreateDocumentResponse { throw Failure.unexpectedCall }
    func commitEdit(_ request: CommitEditRequest) async throws
        -> CommitEditResponse { throw Failure.unexpectedCall }
    func updateCurrentNodeId(
        documentId: String, currentNodeId: String, markdown: String, wordCount: Int,
        updatedAt: Double, expectedPointerRevision: Double?, title: String?
    ) async throws -> UpdateCurrentNodeResponse { throw Failure.unexpectedCall }
    func updateMarkdown(
        documentId: String, markdown: String, wordCount: Int, expectedUpdatedAt: Double,
        expectedHeadNodeId: String?, title: String?
    ) async throws -> UpdateMarkdownResponse { throw Failure.unexpectedCall }
    func appendNode(documentId: String, node: CommitEditRequest) async throws { throw Failure.unexpectedCall }
    func rename(documentId: String, title: String) async throws { throw Failure.unexpectedCall }
    func remove(documentId: String) async throws { throw Failure.unexpectedCall }
    func recordWritingStat(date: String, words: Int) async throws { throw Failure.unexpectedCall }
    func listNodes(documentId: String, sinceCreatedAt: Double?) async throws -> [RemoteNode] { [] }
    func getDocument(documentId: String) async throws -> RemoteDocument? { nil }
    func documentsStream() -> AsyncThrowingStream<[RemoteDocumentSummary], any Error> {
        AsyncThrowingStream { $0.finish() }
    }
    func nodesStream(documentId: String, sinceCreatedAt: Double?)
        -> AsyncThrowingStream<[RemoteNode], any Error> { AsyncThrowingStream { $0.finish() } }
    func loginFromCache() async -> Bool { false }
}
