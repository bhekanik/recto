import Foundation
import GRDB
import OSLog
import RectoHistory
import Synchronization

public enum StoreError: Error, Equatable, Sendable {
  case documentNotFound(String)
  case nodeNotFound(document: String, node: String)
  case headMoved(expected: String, actual: String)
  case parentMismatch(expected: String, actual: String?)
  case rootSnapshotMismatch(String)
  /// A scheduled write arrived with a draft revision the document has moved past.
  case staleGeneration(expected: Int, actual: Int)
  /// A resolution's expectations no longer hold — the divergence moved under it.
  case resolutionRaced(String)
  /// The row still holds work that exists nowhere else.
  case hasLocalWork(String)
  /// An auth transition has exclusive ownership of the local mirror.
  case localMutationsFrozen
}

/// A synchronous boundary around Store mutations that originate in product UI.
/// Holding the lock through the SQLite transaction makes freeze-versus-create
/// an order, rather than a check followed by a write that can race the purge.
private final class LocalMutationFence: Sendable {
  private struct State {
    var generation = 0
    var isFrozen = false
  }

  private let state = Mutex(State())

  func freeze() -> Int {
    state.withLock {
      $0.generation += 1
      $0.isFrozen = true
      return $0.generation
    }
  }

  func resume(frozenAt expectedGeneration: Int) {
    state.withLock {
      guard $0.generation == expectedGeneration else { return }
      $0.isFrozen = false
    }
  }

  func perform<T>(_ body: () throws -> T) throws -> T {
    try state.withLock {
      guard !$0.isFrozen else { throw StoreError.localMutationsFrozen }
      return try body()
    }
  }
}

/// Why a document's outbox queue is held (`documents.queueBlockedReason`).
///
/// Two kinds, and the difference is who is expected to clear it.
///
/// A **durable** barrier waits for a person: a divergence holds the queue until
/// the compare sheet is answered, because everything behind it belongs to the
/// branch under dispute.
///
/// A **provisional** barrier belongs to the reconciliation that runs
/// immediately after the job which wrote it. It exists only so the tail cannot
/// drain while the situation is being classified, and that reconciliation must
/// either promote it to a divergence or release it. Leaving one behind is a
/// deadlock with no way out: the tail cannot drain, so the document can never
/// become idle, so the adoption that was deferred *because* work was pending
/// never happens, and the next reconciliation reads the remote ancestor as
/// server lag.
public enum QueueBlockReason: String, Sendable, CaseIterable {
  /// Durable: both heads are kept and the user chooses.
  case diverged
  /// Durable: the document is gone from the server.
  case removed
  /// Durable for the length of one resolution: the queue is being rewritten.
  case resolving
  /// Provisional: `commitEdit` was answered `diverged` by the server.
  case commitRejected = "commit-rejected"
  /// Provisional: `updateCurrentNodeId` lost the last-write-wins check.
  case pointerMoveRejected = "pointer-move-rejected"
  /// Provisional: a draft was written against a head that has since moved.
  case draftHeadMoved = "draft-head-moved"

  public var isProvisional: Bool {
    switch self {
    case .commitRejected, .pointerMoveRejected, .draftHeadMoved: true
    case .diverged, .removed, .resolving: false
    }
  }

  public static var provisional: [QueueBlockReason] { allCases.filter(\.isProvisional) }
}

/// The local SQLite mirror (plan 023 §4.2).
///
/// One `DatabasePool` in WAL mode, owned by an actor. The pool is already
/// thread-safe; the actor exists so that read-modify-write sequences the app
/// performs (commit a node, then decide what to enqueue) cannot interleave with
/// a concurrent sync apply.
public actor RectoStore {
  /// How many nodes per document keep a cached materialization. Undo/redo walks
  /// a handful of steps around the head, so a small window makes those
  /// instantaneous while keeping the mirror small.
  static let materializationCacheSize = 24

  private let logger = Logger(subsystem: "com.bhekani.recto", category: "store")
  nonisolated let writer: any DatabaseWriter
  private nonisolated let localMutationFence = LocalMutationFence()
  public nonisolated let path: String

  private static var configuration: Configuration {
    var config = Configuration()
    config.prepareDatabase { db in
      // WAL is the pool default; foreign keys are not.
      try db.execute(sql: "PRAGMA foreign_keys = ON")
    }
    return config
  }

  /// Opens (and migrates) the mirror at `url`: a `DatabasePool` in WAL mode, so
  /// a background sync write never blocks the editor's reads.
  public init(url: URL) throws {
    try Self.prepareDirectory(url.deletingLastPathComponent())
    self.writer = try DatabasePool(path: url.path, configuration: Self.configuration)
    self.path = url.path
    try Migrations.migrator().migrate(writer)
    try Self.protect(url)
  }

  /// Open a database migrated only as far as `target`, so a test can create a
  /// realistic older file and then upgrade it.
  static func openAtSchemaVersion(url: URL, target: String) throws -> DatabasePool {
    let pool = try DatabasePool(path: url.path, configuration: Self.configuration)
    try Migrations.migrator().migrate(pool, upTo: target)
    return pool
  }

  /// An in-memory mirror, for tests. A `DatabaseQueue`, not a pool: WAL needs a
  /// real file on disk, so `DatabasePool(path: ":memory:")` cannot open at all.
  public static func inMemory() throws -> RectoStore {
    try RectoStore(writer: DatabaseQueue(configuration: Self.configuration))
  }

  private init(writer: any DatabaseWriter) throws {
    self.writer = writer
    self.path = ":memory:"
    try Migrations.migrator().migrate(writer)
  }

  /// The default location: Application Support/Recto/recto.sqlite.
  public static func defaultURL(fileManager: FileManager = .default) throws -> URL {
    let base = try fileManager.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appending(path: "Recto", directoryHint: .isDirectory)
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appending(path: "recto.sqlite")
  }

  // MARK: - Documents

  /// Exclude product mutations while auth counts or destroys the mirror.
  /// Returns the generation a later resume must still own.
  public nonisolated func freezeLocalMutations() -> Int {
    localMutationFence.freeze()
  }

  public nonisolated func resumeLocalMutations(frozenAt generation: Int) {
    localMutationFence.resume(frozenAt: generation)
  }

  // The feature extension shares the same fence as prose and auth transitions.
  nonisolated func performLocalMutation<T>(_ body: () throws -> T) throws -> T {
    try localMutationFence.perform(body)
  }

  public func document(localId: String) throws -> DocumentRecord? {
    try writer.read { try DocumentRecord.fetchOne($0, key: localId) }
  }

  public func document(convexId: String) throws -> DocumentRecord? {
    try writer.read {
      try DocumentRecord.filter(Column("convexId") == convexId).fetchOne($0)
    }
  }

  /// Newest first, excluding soft-deleted rows.
  public func documents() throws -> [DocumentRecord] {
    try writer.read {
      try DocumentRecord
        .filter(Column("deletedAt") == nil)
        .order(Column("updatedAt").desc)
        .fetchAll($0)
    }
  }

  /// Apply a remote title change without touching anything else.
  ///
  /// A whole-record `save` from a copy read before the edit silently reverts the
  /// draft, head, revision and sync state that a session wrote in between —
  /// `documents.list` only ever tells us about the title.
  @discardableResult
  public func updateRemoteTitle(
    documentLocalId: String, title: String, titleMode: TitleMode = .manual,
    remoteUpdatedAt: Double?
  )
    throws -> Bool
  {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      let renamePending = try OutboxJob
        .filter(Column("documentLocalId") == documentLocalId)
        .filter(Column("kind") == OutboxKind.rename.rawValue)
        .fetchCount(db) > 0
      let derivedEditCount = try Int.fetchOne(
        db,
        sql: """
          SELECT COUNT(*) FROM outbox
          WHERE documentLocalId = ? AND kind IN (?, ?, ?)
          """,
        arguments: [
          documentLocalId, OutboxKind.commitEdit.rawValue, OutboxKind.pointerMove.rawValue,
          OutboxKind.draftSave.rawValue,
        ]) ?? 0
      let derivedEditPending = titleMode == .derived && derivedEditCount > 0
      guard !renamePending, !derivedEditPending else { return false }
      if let remoteUpdatedAt, let accepted = document.remoteTitleUpdatedAt,
        remoteUpdatedAt <= accepted
      {
        return false
      }
      document.title = title
      document.titleMode = titleMode
      if let remoteUpdatedAt { document.remoteTitleUpdatedAt = remoteUpdatedAt }
      try document.update(db)
      return true
    }
  }

  /// Documents whose queue is held for one of `reasons`, oldest first.
  ///
  /// A provisional barrier belongs to the reconciliation that follows the job
  /// which wrote it; a crash in between leaves one with no owner, and nothing
  /// else ever looks at a blocked document. `start()` sweeps them.
  public func documentsBlocked(byReasons reasons: [QueueBlockReason]) throws -> [String] {
    guard !reasons.isEmpty else { return [] }
    return try writer.read { db in
      let placeholders = databaseQuestionMarks(count: reasons.count)
      return try String.fetchAll(
        db,
        sql: """
          SELECT localId FROM documents
          WHERE queueBlockedReason IN (\(placeholders)) AND deletedAt IS NULL
          ORDER BY updatedAt
          """,
        arguments: StatementArguments(reasons.map(\.rawValue)))
    }
  }

  /// Hold or release a document's queue. Set inside the same transaction as the
  /// divergence it describes; cleared only by a resolver or a reconciliation.
  public func setQueueBlocked(documentLocalId: String, reason: String?) throws {
    try writer.write { db in
      try db.execute(
        sql: "UPDATE documents SET queueBlockedReason = ? WHERE localId = ?",
        arguments: [reason, documentLocalId])
    }
  }

  public func save(_ document: DocumentRecord) throws {
    try writer.write { try document.save($0) }
  }

  /// Persist an explicit rename and its outbox row together. The mode changes
  /// even when the visible string is unchanged.
  public func renameDocument(
    documentLocalId: String, title: String, job: OutboxJob,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> DocumentRecord {
    try localMutationFence.perform {
      try writer.write { db in
        guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
          throw StoreError.documentNotFound(documentLocalId)
        }
        document.title = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          ? "Untitled" : title.trimmingCharacters(in: .whitespacesAndNewlines)
        document.titleMode = .manual
        document.updatedAt = now
        if document.syncState != .diverged { document.syncState = .pending }
        try document.update(db)
        var queued = job
        try queued.insert(db)
        return document
      }
    }
  }

  /// Insert an offline document, its local root, and its create mutation as one
  /// transaction. A crash can therefore expose either the whole new document
  /// or none of it, never a library row that cannot open or cannot sync.
  public func createLocalDocument(
    _ document: DocumentRecord,
    rootNode: DocNodeRecord,
    createJob: OutboxJob
  ) throws -> DocumentRecord {
    try localMutationFence.perform {
      try writer.write { db in
        try document.insert(db)
        try rootNode.insert(db)
        var job = createJob
        try job.insert(db)
        return document
      }
    }
  }

  public func nodes(documentLocalId: String) throws -> [DocNodeRecord] {
    try writer.read {
      try DocNodeRecord
        .filter(Column("documentLocalId") == documentLocalId)
        .order(Column("createdAt"))
        .fetchAll($0)
    }
  }

  public func node(documentLocalId: String, nodeId: String) throws -> DocNodeRecord? {
    try writer.read { try DocNodeRecord.fetchOne($0, key: [
      "documentLocalId": documentLocalId, "nodeId": nodeId,
    ]) }
  }

  /// Nodes on this document that the server has not acknowledged, oldest first —
  /// the ancestor-upload path of §4.4.
  public func unsyncedNodes(documentLocalId: String) throws -> [DocNodeRecord] {
    try writer.read {
      try DocNodeRecord
        .filter(Column("documentLocalId") == documentLocalId && Column("synced") == false)
        .order(Column("createdAt"))
        .fetchAll($0)
    }
  }

  // MARK: - The edit path

  /// Persist one committed node, advance the head, and queue the mutation — in a
  /// single transaction (plan 023 §4.3).
  ///
  /// The three writes the web made separately are what plan 022 traced its
  /// pointer race to. Locally the same rule applies: a crash between the node
  /// insert and the head update would leave a document pointing at a node that
  /// does not describe its text.
  @discardableResult
  public func commit(
    documentLocalId: String,
    node: DocNodeRecord,
    markdown: String,
    wordCount: Int,
    title: String? = nil,
    preserveQueuedDraftJob: Bool = false,
    expectedHeadNodeId: String,
    expectedDraftRevision: Int? = nil,
    job: OutboxJob?,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> DocumentRecord {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      guard document.localHeadNodeId == expectedHeadNodeId else {
        throw StoreError.headMoved(
          expected: expectedHeadNodeId, actual: document.localHeadNodeId)
      }
      guard node.parentNodeId == expectedHeadNodeId else {
        throw StoreError.parentMismatch(
          expected: expectedHeadNodeId, actual: node.parentNodeId)
      }
      if let expectedDraftRevision, document.draftRevision != expectedDraftRevision {
        throw StoreError.staleGeneration(
          expected: expectedDraftRevision, actual: document.draftRevision)
      }

      var stored = node
      stored.materialized = markdown
      stored.materializedAt = now
      try stored.save(db)

      // Grouping can commit the previous body while the current callback starts
      // the next group. That newer ingress must follow the commit, not vanish.
      let committedAcknowledgedIngress =
        preserveQueuedDraftJob && document.editorIngressRevision != nil
        && document.editorIngressAcknowledged
        && document.draftMarkdown.map { ($0 as NSString).isEqual(to: markdown) } == true
      let retainedEditorIngress =
        document.editorIngressRevision != nil
        && (document.draftMarkdown.map { !($0 as NSString).isEqual(to: markdown) } == true
          || preserveQueuedDraftJob)
        && !committedAcknowledgedIngress
      var retainedDraftJob: OutboxJob?
      if job != nil {
        let queuedDraft = try OutboxJob
          .filter(Column("documentLocalId") == documentLocalId)
          .filter(Column("kind") == OutboxKind.draftSave.rawValue)
          .fetchOne(db)
        // A derived commit with no title delegates title publication to the
        // editor's async lane. Keep its draft behind the body commit whether
        // that lane has finished already or still has to replace it.
        if retainedEditorIngress || preserveQueuedDraftJob {
          retainedDraftJob = queuedDraft
        }
      }

      document.localHeadNodeId = node.nodeId
      document.markdown = markdown
      if document.titleMode == .derived, let title { document.title = title }
      if !retainedEditorIngress {
        document.wordCount = wordCount
        document.draftMarkdown = nil
        document.draftSelectionAnchor = nil
        document.draftSelectionHead = nil
        document.editorIngressRevision = nil
        document.editorIngressAcknowledged = false
      }
      document.updatedAt = now
      document.draftRevision += 1
      if retainedEditorIngress { document.editorIngressRevision = document.draftRevision }
      if document.syncState != .diverged { document.syncState = .pending }
      try document.update(db)

      if var job {
        _ =
          try OutboxJob
          .filter(Column("documentLocalId") == documentLocalId)
          .filter(Column("kind") == OutboxKind.draftSave.rawValue)
          .deleteAll(db)
        try job.insert(db)
        if var retainedDraftJob {
          retainedDraftJob.id = nil
          retainedDraftJob.baseHeadNodeId = node.nodeId
          retainedDraftJob.attempts = 0
          retainedDraftJob.lastError = nil
          retainedDraftJob.nextAttemptAt = 0
          try retainedDraftJob.insert(db)
        }
      }
      try Self.trimMaterializationCache(db, documentLocalId: documentLocalId)
      return document
    }
  }

  /// Move the head to an existing node (undo, redo, navigate, adopt-remote).
  ///
  /// `expectedHeadNodeId` is a compare-and-set. Two windows share one session
  /// actor but that actor suspends at every `await`, so a navigation that
  /// materialized its target can find the head already moved by a keystroke from
  /// the other window; moving it anyway would strand the newer node's queued job.
  @discardableResult
  public func moveHead(
    documentLocalId: String,
    to nodeId: String,
    markdown: String,
    wordCount: Int,
    title: String? = nil,
    expectedHeadNodeId: String?,
    job: OutboxJob?,
    clearDivergence: Bool = false,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> DocumentRecord {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      if let expectedHeadNodeId, document.localHeadNodeId != expectedHeadNodeId {
        throw StoreError.headMoved(
          expected: expectedHeadNodeId, actual: document.localHeadNodeId)
      }
      guard
        var node = try DocNodeRecord.fetchOne(
          db, key: ["documentLocalId": documentLocalId, "nodeId": nodeId])
      else {
        throw StoreError.nodeNotFound(document: documentLocalId, node: nodeId)
      }

      node.materialized = markdown
      node.materializedAt = now
      try node.update(db)

      document.localHeadNodeId = nodeId
      document.markdown = markdown
      if document.titleMode == .derived, let title { document.title = title }
      document.wordCount = wordCount
      document.draftMarkdown = nil
      document.draftSelectionAnchor = nil
      document.draftSelectionHead = nil
      document.editorIngressRevision = nil
      document.editorIngressAcknowledged = false
      document.updatedAt = now
      document.draftRevision += 1
      if clearDivergence {
        document.divergedRemoteHeadNodeId = nil
        document.syncState = job == nil ? .synced : .pending
      } else if document.syncState != .diverged {
        document.syncState = .pending
      }
      try document.update(db)

      if var job { try job.insert(db) }
      try Self.trimMaterializationCache(db, documentLocalId: documentLocalId)
      return document
    }
  }

  /// The debounced draft row: text that has no node yet.
  ///
  /// `expectedDraftRevision` is how a scheduled task proves it is not stale. A
  /// 250 ms debounce fired for change A can otherwise land after change B has
  /// already been persisted and write A back over it — and a crash before B's
  /// next debounce would then lose B entirely.
  @discardableResult
  public func saveDraft(
    documentLocalId: String,
    markdown: String,
    selection: NodeSelection?,
    wordCount: Int,
    title: String? = nil,
    job: OutboxJob?,
    expectedDraftRevision: Int? = nil,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> Int {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      if let expectedDraftRevision, document.draftRevision != expectedDraftRevision {
        throw StoreError.staleGeneration(
          expected: expectedDraftRevision, actual: document.draftRevision)
      }
      document.draftMarkdown = (markdown as NSString).isEqual(to: document.markdown) ? nil : markdown
      document.draftSelectionAnchor = selection?.anchor
      document.draftSelectionHead = selection?.head
      document.wordCount = wordCount
      if document.titleMode == .derived, let title { document.title = title }
      document.updatedAt = now
      if document.draftMarkdown != nil,
        document.syncState == .synced || document.syncState == .syncing
      {
        document.syncState = .pending
      }
      document.draftRevision += 1
      document.editorIngressRevision = document.draftMarkdown == nil ? nil : document.draftRevision
      document.editorIngressAcknowledged = false
      if document.draftMarkdown == nil,
        document.syncState == .pending,
        document.queueBlockedReason == nil,
        document.remoteHeadNodeId == document.localHeadNodeId,
        try OutboxJob.filter(Column("documentLocalId") == documentLocalId).fetchCount(db) == 0
      {
        document.syncState = .synced
      }
      try document.update(db)
      if var job { try job.insert(db) }
      return document.draftRevision
    }
  }

  /// Synchronous write-ahead boundary for AppKit's synchronous text callback.
  ///
  /// `DatabasePool` serializes writes internally. Keeping this one operation
  /// nonisolated lets the callback put the exact visible snapshot on disk
  /// before it returns, instead of starting an async task that can lose a race
  /// with process termination.
  @discardableResult
  public nonisolated func saveEditorIngressSynchronously(
    documentLocalId: String,
    markdown: String,
    selection: NodeSelection?,
    wordCount: Int,
    title: String? = nil,
    clientMutationId: String,
    draftPayload: String,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> Int {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      document.draftMarkdown = markdown
      document.draftSelectionAnchor = selection?.anchor
      document.draftSelectionHead = selection?.head
      document.wordCount = wordCount
      if document.titleMode == .derived, let title { document.title = title }
      document.updatedAt = now
      if document.syncState != .diverged { document.syncState = .pending }
      document.draftRevision += 1
      document.editorIngressRevision = document.draftRevision
      document.editorIngressAcknowledged = false
      try document.update(db)

      // Draft bodies are mutable full snapshots. The newest accepted snapshot
      // supersedes every older unsent one, while keeping its place after any
      // immutable node jobs already queued for this document.
      _ = try OutboxJob
        .filter(Column("documentLocalId") == documentLocalId)
        .filter(Column("kind") == OutboxKind.draftSave.rawValue)
        .deleteAll(db)
      var job = OutboxJob(
        documentLocalId: documentLocalId,
        kind: .draftSave,
        clientMutationId: clientMutationId,
        baseHeadNodeId: document.localHeadNodeId,
        payload: draftPayload,
        createdAt: now)
      try job.insert(db)
      return document.draftRevision
    }
  }

  /// Finish title work that was deliberately kept off AppKit's synchronous
  /// callback. The body must still be current, while title mode protects a
  /// manual rename that happened while derivation ran. A clean acknowledged
  /// body remains eligible because the server still needs its exact title.
  @discardableResult
  public func finishEditorIngressTitle(
    documentLocalId: String,
    markdown: String,
    expectedDraftRevision: Int,
    title: String,
    job: OutboxJob
  ) throws -> Bool {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      guard document.titleMode == .derived,
        document.draftRevision >= expectedDraftRevision,
        (document.displayMarkdown as NSString).isEqual(to: markdown)
      else { return false }

      document.title = title
      try document.update(db)

      // The body-only ingress job may already be in flight. Replacing every
      // queued draft with this exact body/title pair is safe either way: an
      // in-flight body-only write can land first, then this job repairs title.
      _ = try OutboxJob
        .filter(Column("documentLocalId") == documentLocalId)
        .filter(Column("kind") == OutboxKind.draftSave.rawValue)
        .deleteAll(db)
      var stored = job
      stored.id = nil
      stored.documentLocalId = documentLocalId
      stored.kind = .draftSave
      stored.baseHeadNodeId = document.localHeadNodeId
      stored.attempts = 0
      stored.lastError = nil
      stored.nextAttemptAt = 0
      try stored.insert(db)
      return true
    }
  }

  /// Clear a clean-head ingress only after the server accepted its exact body
  /// and, in derived mode, its exact title. A body-only acknowledgement leaves
  /// the marker for relaunch recovery if the async title worker dies.
  public func acknowledgeEditorIngress(
    documentLocalId: String,
    markdown: String,
    title: String?
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId),
        document.editorIngressRevision != nil,
        document.draftMarkdown.map({ ($0 as NSString).isEqual(to: markdown) }) == true,
        document.titleMode == .manual || (title != nil && document.title == title)
      else { return }
      guard (document.markdown as NSString).isEqual(to: markdown) else {
        document.editorIngressAcknowledged = true
        try document.update(db)
        return
      }
      document.draftMarkdown = nil
      document.draftSelectionAnchor = nil
      document.draftSelectionHead = nil
      document.editorIngressRevision = nil
      document.editorIngressAcknowledged = false
      document.draftRevision += 1
      try document.update(db)
    }
  }

  /// Adopt the server's stored body as a pending draft.
  ///
  /// Only ever called when the server stamped that body with the node it belongs
  /// to (`documents.markdownHeadNodeId`) AND that stamp is our head AND the
  /// server's `updatedAt` is ahead of what we have seen. Text whose provenance is
  /// unknown or points at another branch is NOT the head's text, and treating it
  /// as such is how one device's draft silently overwrites another's branch.
  public func adoptServerDraft(
    documentLocalId: String,
    markdown: String,
    wordCount: Int,
    title: String? = nil,
    stampedHeadNodeId: String,
    remoteUpdatedAt: Double,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> Bool {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      guard document.localHeadNodeId == stampedHeadNodeId,
        document.draftMarkdown == nil,
        try OutboxJob.filter(Column("documentLocalId") == documentLocalId).fetchCount(db) == 0,
        remoteUpdatedAt > (document.remoteUpdatedAt ?? -1)
      else { return false }

      document.draftMarkdown = (markdown as NSString).isEqual(to: document.markdown) ? nil : markdown
      document.draftSelectionAnchor = nil
      document.draftSelectionHead = nil
      document.wordCount = wordCount
      if document.titleMode == .derived, let title { document.title = title }
      document.remoteMarkdownHeadNodeId = stampedHeadNodeId
      document.remoteUpdatedAt = remoteUpdatedAt
      document.draftRevision += 1
      document.updatedAt = now
      try document.update(db)
      return true
    }
  }

  /// Delete a document that vanished from the server — but only if this device
  /// holds nothing that exists nowhere else.
  ///
  /// The write-ahead path persists a draft BEFORE its outbox job, so checking
  /// the queue alone can delete the user's only copy; and a separate check
  /// followed by a separate delete can be interleaved by a live edit.
  @discardableResult
  public func deleteRemotelyRemovedDocument(localId: String) throws -> Bool {
    try writer.write { db in
      guard let document = try DocumentRecord.fetchOne(db, key: localId) else { return true }
      guard document.draftMarkdown == nil,
        try OutboxJob.filter(Column("documentLocalId") == localId).fetchCount(db) == 0,
        try !Self.hasUnsyncedOverflow(db, localId: localId)
      else { return false }
      _ = try DocumentRecord.deleteOne(db, key: localId)
      return true
    }
  }

  /// Insert nodes that arrived from the server. Append-only: an existing node is
  /// never overwritten, only marked synced (blueprint 07 §7, ADR-10).
  public func mergeRemoteNodes(documentLocalId: String, nodes: [DocNodeRecord]) throws {
    guard !nodes.isEmpty else { return }
    try writer.write { db in
      for node in nodes {
        if var existing = try DocNodeRecord.fetchOne(
          db, key: ["documentLocalId": documentLocalId, "nodeId": node.nodeId])
        {
          guard !existing.synced else { continue }
          existing.synced = true
          try existing.update(db)
        } else {
          var incoming = node
          incoming.documentLocalId = documentLocalId
          incoming.synced = true
          try incoming.insert(db)
        }
      }
    }
  }

  public func markNodesSynced(documentLocalId: String, nodeIds: [String]) throws {
    guard !nodeIds.isEmpty else { return }
    try writer.write { db in
      _ = try DocNodeRecord
        .filter(Column("documentLocalId") == documentLocalId)
        .filter(nodeIds.contains(Column("nodeId")))
        .updateAll(db, Column("synced").set(to: true))
    }
  }

  /// Adopt a remote head, but only if nothing has changed since the caller
  /// observed it (plan 023 §4.4, "adopt when idle, keep caret").
  ///
  /// The whole check runs inside the write transaction. `reconcileHead` decides
  /// to adopt, then suspends to materialize the target; a keystroke in that gap
  /// persists a draft and queues a job, and adopting anyway would delete that
  /// draft and point the document at someone else's branch. Returns false when
  /// the CAS fails; the caller treats that as "still pending".
  public func adoptRemoteHead(
    documentLocalId: String,
    observedLocalHeadNodeId: String,
    remoteHeadNodeId: String,
    markdown: String,
    wordCount: Int,
    remoteUpdatedAt: Double?,
    remotePointerRevision: Double?,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> Bool {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      guard document.localHeadNodeId == observedLocalHeadNodeId,
        document.draftMarkdown == nil,
        try OutboxJob.filter(Column("documentLocalId") == documentLocalId).fetchCount(db) == 0
      else { return false }
      guard
        var node = try DocNodeRecord.fetchOne(
          db, key: ["documentLocalId": documentLocalId, "nodeId": remoteHeadNodeId])
      else {
        throw StoreError.nodeNotFound(document: documentLocalId, node: remoteHeadNodeId)
      }

      node.materialized = markdown
      node.materializedAt = now
      try node.update(db)

      document.localHeadNodeId = remoteHeadNodeId
      document.remoteHeadNodeId = remoteHeadNodeId
      if let remoteUpdatedAt { document.remoteUpdatedAt = remoteUpdatedAt }
      if let remotePointerRevision { document.remotePointerRevision = remotePointerRevision }
      document.markdown = markdown
      document.wordCount = wordCount
      document.divergedRemoteHeadNodeId = nil
      document.queueBlockedReason = nil
      document.syncState = .synced
      document.updatedAt = now
      try document.update(db)
      try Self.trimMaterializationCache(db, documentLocalId: documentLocalId)
      return true
    }
  }

  /// What a divergence resolution asserts about the world before it acts.
  ///
  /// The user chooses against a snapshot, then the sheet suspends while the
  /// target is materialized. If another client advances in that window, applying
  /// the old choice adopts a stale head AND clears a divergence the user never
  /// saw. Every field here is compared inside the transaction.
  public struct ResolutionExpectation: Sendable, Equatable {
    public var localHeadNodeId: String
    public var divergedRemoteHeadNodeId: String
    public var remotePointerRevision: Double?

    public init(
      localHeadNodeId: String, divergedRemoteHeadNodeId: String,
      remotePointerRevision: Double?
    ) {
      self.localHeadNodeId = localHeadNodeId
      self.divergedRemoteHeadNodeId = divergedRemoteHeadNodeId
      self.remotePointerRevision = remotePointerRevision
    }
  }

  private static func checkResolution(
    _ db: Database, _ document: DocumentRecord, _ expected: ResolutionExpectation
  ) throws {
    guard document.localHeadNodeId == expected.localHeadNodeId,
      document.divergedRemoteHeadNodeId == expected.divergedRemoteHeadNodeId,
      document.remotePointerRevision == expected.remotePointerRevision
    else {
      throw StoreError.resolutionRaced(document.localId)
    }
  }

  /// Rewrite the queue of a branch that is no longer the head.
  ///
  /// Commits become node-only uploads (`docNodes.append`) so the text survives
  /// without contesting the pointer; drafts and pointer moves are dropped
  /// outright, because both would push the discarded branch back.
  private static func demoteBranchJobs(_ db: Database, documentLocalId: String) throws {
    try db.execute(
      sql: "DELETE FROM outbox WHERE documentLocalId = ? AND kind IN (?, ?)",
      arguments: [
        documentLocalId, OutboxKind.pointerMove.rawValue, OutboxKind.draftSave.rawValue,
      ])
    try db.execute(
      sql:
        "UPDATE outbox SET kind = ?, baseHeadNodeId = NULL WHERE documentLocalId = ? AND kind = ?",
      arguments: [
        OutboxKind.appendNode.rawValue, documentLocalId, OutboxKind.commitEdit.rawValue,
      ])
  }

  /// Take the remote branch after a divergence, in one transaction (§4.4).
  ///
  /// The local branch is NOT deleted — the DAG is append-only and the user can
  /// still reach it from the history panel — but every queued job that would
  /// push its pointer back has to go, or the next drain simply recreates the
  /// divergence.
  public func resolveKeepingRemote(
    documentLocalId: String,
    expecting: ResolutionExpectation,
    markdown: String,
    wordCount: Int,
    title: String? = nil,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      try Self.checkResolution(db, document, expecting)
      let remoteHeadNodeId = expecting.divergedRemoteHeadNodeId
      guard
        var node = try DocNodeRecord.fetchOne(
          db, key: ["documentLocalId": documentLocalId, "nodeId": remoteHeadNodeId])
      else {
        throw StoreError.nodeNotFound(document: documentLocalId, node: remoteHeadNodeId)
      }

      try Self.demoteBranchJobs(db, documentLocalId: documentLocalId)

      node.materialized = markdown
      node.materializedAt = now
      try node.update(db)

      document.localHeadNodeId = remoteHeadNodeId
      document.markdown = markdown
      document.wordCount = wordCount
      if document.titleMode == .derived, let title { document.title = title }
      document.draftMarkdown = nil
      document.draftSelectionAnchor = nil
      document.draftSelectionHead = nil
      document.editorIngressRevision = nil
      document.editorIngressAcknowledged = false
      document.divergedRemoteHeadNodeId = nil
      document.queueBlockedReason = nil
      document.draftRevision += 1
      document.syncState =
        try OutboxJob.filter(Column("documentLocalId") == documentLocalId).fetchCount(db) == 0
        ? .synced : .pending
      document.updatedAt = now
      try document.update(db)
      try Self.trimMaterializationCache(db, documentLocalId: documentLocalId)
    }
  }

  /// Keep the local branch: adopt the remote head as the base, demote the old
  /// branch's jobs, and queue the rebased commit BEHIND those node uploads —
  /// all in one transaction.
  ///
  /// Leaving the old jobs in front of the rebase is what let them replay against
  /// the discarded base and recreate the divergence the user just resolved.
  public func resolveKeepingLocal(
    documentLocalId: String,
    expecting: ResolutionExpectation,
    remoteMarkdown: String,
    remoteWordCount: Int,
    rebasedNode: DocNodeRecord,
    rebasedMarkdown: String,
    rebasedWordCount: Int,
    title: String? = nil,
    rebasedJob: OutboxJob,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      try Self.checkResolution(db, document, expecting)
      let remoteHeadNodeId = expecting.divergedRemoteHeadNodeId
      guard
        var base = try DocNodeRecord.fetchOne(
          db, key: ["documentLocalId": documentLocalId, "nodeId": remoteHeadNodeId])
      else {
        throw StoreError.nodeNotFound(document: documentLocalId, node: remoteHeadNodeId)
      }

      try Self.demoteBranchJobs(db, documentLocalId: documentLocalId)

      base.materialized = remoteMarkdown
      base.materializedAt = now
      try base.update(db)
      _ = remoteWordCount

      var node = rebasedNode
      node.materialized = rebasedMarkdown
      node.materializedAt = now
      try node.save(db)

      // Enqueued last, so it drains after the node-only uploads that carry the
      // discarded branch's text.
      var job = rebasedJob
      try job.insert(db)

      document.localHeadNodeId = node.nodeId
      document.markdown = rebasedMarkdown
      document.wordCount = rebasedWordCount
      if document.titleMode == .derived, let title { document.title = title }
      document.draftMarkdown = nil
      document.draftSelectionAnchor = nil
      document.draftSelectionHead = nil
      document.editorIngressRevision = nil
      document.editorIngressAcknowledged = false
      document.divergedRemoteHeadNodeId = nil
      document.queueBlockedReason = nil
      document.draftRevision += 1
      document.syncState = .pending
      document.updatedAt = now
      try document.update(db)
      try Self.trimMaterializationCache(db, documentLocalId: documentLocalId)
    }
  }

  /// Everything an offline `documents.create` acknowledgement implies, in one
  /// transaction (plan 023 §4.1(5)).
  ///
  /// `documents.create` mints its own root nodeId, so a document created offline
  /// has a root the server never heard of, and the queued commits name it as
  /// their parent — in the node rows AND inside the encoded outbox payloads.
  /// Splitting this across transactions leaves a document whose first child is
  /// sent with a parent that does not exist. Idempotent: a retry that finds the
  /// adoption already done is a no-op.
  public func finishOfflineCreate(
    documentLocalId: String,
    convexId: String,
    serverRootNodeId: String,
    rewritePayloadNodeIds: @Sendable (_ payload: String, _ oldRoot: String, _ newRoot: String)
      -> String
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      document.convexId = convexId
      document.remoteHeadNodeId = serverRootNodeId

      let localRoot = try DocNodeRecord
        .filter(Column("documentLocalId") == documentLocalId && Column("parentNodeId") == nil)
        .fetchOne(db)

      if let localRoot, localRoot.nodeId != serverRootNodeId {
        // Both roots snapshot the empty document, so re-keying cannot change
        // what any child patch applies to. Refuse if that is ever not true.
        guard (localRoot.snapshot ?? "").isEmpty else {
          throw StoreError.rootSnapshotMismatch(documentLocalId)
        }
        if try DocNodeRecord.fetchOne(
          db, key: ["documentLocalId": documentLocalId, "nodeId": serverRootNodeId]) == nil
        {
          try DocNodeRecord(
            documentLocalId: documentLocalId, nodeId: serverRootNodeId, parentNodeId: nil,
            patch: localRoot.patch, snapshot: "", origin: "server",
            createdAt: localRoot.createdAt, materialized: "", synced: true
          ).insert(db)
        }
        try db.execute(
          sql:
            "UPDATE doc_nodes SET parentNodeId = ? WHERE documentLocalId = ? AND parentNodeId = ?",
          arguments: [serverRootNodeId, documentLocalId, localRoot.nodeId])
        try db.execute(
          sql: "UPDATE outbox SET baseHeadNodeId = ? WHERE documentLocalId = ? AND baseHeadNodeId = ?",
          arguments: [serverRootNodeId, documentLocalId, localRoot.nodeId])

        // The encoded payload carries its own copies of node ids — a commit's
        // `parentNodeId` and a pointer move's `nodeId`. Rewriting only the node
        // rows would still send the deleted root, and the server does not
        // validate that a pointer target exists.
        for var job in try OutboxJob
          .filter(Column("documentLocalId") == documentLocalId)
          .fetchAll(db)
        {
          let rewritten = rewritePayloadNodeIds(job.payload, localRoot.nodeId, serverRootNodeId)
          guard rewritten != job.payload else { continue }
          job.payload = rewritten
          try job.update(db)
        }

        try db.execute(
          sql: "UPDATE versions SET nodeId = ? WHERE documentLocalId = ? AND nodeId = ?",
          arguments: [serverRootNodeId, documentLocalId, localRoot.nodeId])
        try db.execute(
          sql: "UPDATE review_branches SET baseNodeId = CASE WHEN baseNodeId = ?2 THEN ?1 ELSE baseNodeId END, headNodeId = CASE WHEN headNodeId = ?2 THEN ?1 ELSE headNodeId END WHERE documentLocalId = ?3",
          arguments: [serverRootNodeId, localRoot.nodeId, documentLocalId])

        if document.localHeadNodeId == localRoot.nodeId {
          document.localHeadNodeId = serverRootNodeId
        }
        if document.divergedRemoteHeadNodeId == localRoot.nodeId {
          document.divergedRemoteHeadNodeId = serverRootNodeId
        }
        try db.execute(
          sql: "DELETE FROM doc_nodes WHERE documentLocalId = ? AND nodeId = ?",
          arguments: [documentLocalId, localRoot.nodeId])
      }

      try document.update(db)
    }
  }

  /// Insert a freshly pulled document together with its whole DAG.
  ///
  /// One transaction: a row whose head node never arrived can never materialize,
  /// and `mirrorLibrary` would skip re-pulling it because the title and
  /// `remoteUpdatedAt` already match.
  public func hydrate(document: DocumentRecord, nodes: [DocNodeRecord]) throws {
    try writer.write { db in
      try document.save(db)
      for node in nodes {
        guard
          try DocNodeRecord.fetchOne(
            db, key: ["documentLocalId": document.localId, "nodeId": node.nodeId]) == nil
        else { continue }
        var incoming = node
        incoming.documentLocalId = document.localId
        incoming.synced = true
        try incoming.insert(db)
      }
    }
  }

  /// A local row whose head node is missing — an interrupted hydration. It has
  /// to be pulled again rather than left as a document that cannot open.
  public func incompleteDocumentIds() throws -> [String] {
    try writer.read { db in
      try String.fetchAll(
        db,
        sql: """
          SELECT d.localId FROM documents d
          WHERE d.convexId IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM doc_nodes n
            WHERE n.documentLocalId = d.localId AND n.nodeId = d.localHeadNodeId
          )
          """)
    }
  }

  /// Drafts and queued mutations that exist nowhere else. Sign-out asks first.
  public func unsyncedWorkCount() throws -> Int {
    try writer.read { db in
      let jobs = try OutboxJob.fetchCount(db)
      let drafts = try DocumentRecord.filter(Column("draftMarkdown") != nil).fetchCount(db)
      let overflow = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM document_overflow WHERE generation != acknowledgedGeneration OR pending IS NOT NULL OR remoteMarkdown IS NOT NULL") ?? 0
      return jobs + drafts + overflow
    }
  }

  // MARK: - Materialization

  /// Markdown at a node, using (and filling) the per-node cache.
  public func materializedMarkdown(documentLocalId: String, nodeId: String) throws -> String {
    if let cached = try node(documentLocalId: documentLocalId, nodeId: nodeId)?.materialized {
      return cached
    }
    let markdown = try writer.read { db in
      try Self.materialize(db, documentLocalId: documentLocalId, nodeId: nodeId)
    }
    try writer.write { db in
      try db.execute(
        sql: """
          UPDATE doc_nodes SET materialized = ?, materializedAt = ?
          WHERE documentLocalId = ? AND nodeId = ?
          """,
        arguments: [markdown, Date().timeIntervalSince1970 * 1000, documentLocalId, nodeId])
      try Self.trimMaterializationCache(db, documentLocalId: documentLocalId)
    }
    return markdown
  }

  /// Walk to the nearest ancestor carrying either a cached materialization or a
  /// snapshot, then replay patches forward. The snapshot cadence bounds this at
  /// `snapshotEveryN` steps even with a cold cache.
  private static func materialize(_ db: Database, documentLocalId: String, nodeId: String) throws
    -> String
  {
    var chain: [DocNodeRecord] = []
    var currentId: String? = nodeId
    var base: String?

    while let id = currentId {
      guard
        let node = try DocNodeRecord.fetchOne(
          db, key: ["documentLocalId": documentLocalId, "nodeId": id])
      else {
        throw StoreError.nodeNotFound(document: documentLocalId, node: id)
      }
      if let cached = node.materialized, id != nodeId {
        base = cached
        break
      }
      chain.append(node)
      if let snapshot = node.snapshot {
        base = snapshot
        chain.removeLast()
        break
      }
      currentId = node.parentNodeId
    }

    var markdown = JSString(base ?? "")
    for node in chain.reversed() {
      markdown = applyPatch(markdown, try TextPatch.decode(node.patch))
    }
    guard let string = markdown.string else { throw PatchDecodingError.illFormedResult }
    return string
  }

  /// Keep the cache to the most recently materialized nodes per document.
  private static func trimMaterializationCache(_ db: Database, documentLocalId: String) throws {
    try db.execute(
      sql: """
        UPDATE doc_nodes SET materialized = NULL, materializedAt = NULL
        WHERE documentLocalId = ? AND materialized IS NOT NULL AND nodeId NOT IN (
          SELECT nodeId FROM doc_nodes
          WHERE documentLocalId = ? AND materialized IS NOT NULL
          ORDER BY materializedAt DESC LIMIT ?
        )
        """,
      arguments: [documentLocalId, documentLocalId, materializationCacheSize])
  }

  // MARK: - Outbox

  public func enqueue(_ job: OutboxJob) throws -> OutboxJob {
    try writer.write { db in
      var stored = job
      try stored.insert(db)
      return stored
    }
  }

  /// The next job for this document, in insertion order. One at a time: the
  /// server's replay window only covers the most recent `clientMutationId`, so a
  /// pipelined queue that replays an older commit gets `diverged` instead of its
  /// original answer.
  public func nextJob(
    documentLocalId: String, now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> OutboxJob? {
    try writer.read { db in
      // Only ever the HEAD of the queue, and only once its backoff has elapsed.
      // A later job must not overtake a failing one: the server remembers a
      // single `clientMutationId`, so replaying an older commit after a newer
      // one landed is answered with `diverged` instead of its original result.
      guard
        let head = try OutboxJob
          .filter(Column("documentLocalId") == documentLocalId)
          .order(Column("id"))
          .fetchOne(db)
      else { return nil }
      return head.nextAttemptAt <= now ? head : nil
    }
  }

  /// Documents with queued work, oldest job first. Draining is per document so a
  /// document stuck on a divergence does not hold up every other document.
  public func documentsWithPendingJobs() throws -> [String] {
    try writer.read { db in
      // Blocked documents are excluded here rather than in memory, so the
      // barrier survives a relaunch.
      try String.fetchAll(
        db,
        sql: """
          SELECT o.documentLocalId FROM outbox o
          LEFT JOIN documents d ON d.localId = o.documentLocalId
          WHERE d.queueBlockedReason IS NULL
          GROUP BY o.documentLocalId ORDER BY MIN(o.id)
          """)
    }
  }

  /// When the earliest backed-off job becomes eligible, so the drain loop can
  /// sleep exactly that long instead of polling.
  ///
  /// Only the HEAD row of each UNBLOCKED document counts, because only a head
  /// row can ever be sent. `MIN` over every row answers with a later job's
  /// default zero timestamp, and the woken drain then finds nothing it may send
  /// and arms another zero-delay wake — a spin that consumes a core until the
  /// head becomes eligible, or forever behind a barrier. Parked rows are
  /// excluded for the same reason: nothing will retry them, so their year-2100
  /// timestamp is not a wake time.
  public func earliestNextAttempt() throws -> Double? {
    try writer.read { db in
      try Double.fetchOne(
        db,
        sql: """
          SELECT MIN(o.nextAttemptAt) FROM outbox o
          LEFT JOIN documents d ON d.localId = o.documentLocalId
          WHERE d.queueBlockedReason IS NULL
            AND o.nextAttemptAt < ?
            AND o.id = (
              SELECT MIN(h.id) FROM outbox h WHERE h.documentLocalId = o.documentLocalId
            )
          """,
        arguments: [Self.parkedForever])
    }
  }

  public func pendingJobs(documentLocalId: String? = nil) throws -> [OutboxJob] {
    try writer.read { db in
      var request = OutboxJob.order(Column("id"))
      if let documentLocalId {
        request = request.filter(Column("documentLocalId") == documentLocalId)
      }
      return try request.fetchAll(db)
    }
  }

  /// Does this document have a queued job that has already failed at least once?
  ///
  /// `SyncState.failed` is derived from this rather than owned as an independent
  /// flag: a reconcile that decided "nothing to do" from a snapshot taken before
  /// a drain failed would otherwise reset the badge and hide a stuck queue.
  public func hasFailedJobs(documentLocalId: String) throws -> Bool {
    try writer.read { db in
      try OutboxJob
        .filter(Column("documentLocalId") == documentLocalId)
        .filter(Column("lastError") != nil)
        .fetchCount(db) > 0
    }
  }

  public func pendingJobCount() throws -> Int {
    try writer.read { try OutboxJob.fetchCount($0) }
  }

  /// Park a job that can never succeed: keep the row (it is the only copy of
  /// that work) but stop it blocking the queue forever.
  ///
  /// `nextAttemptAt` is set beyond any plausible retry rather than deleting the
  /// row, so an export/recovery path can still reach it.
  public func parkJob(id: Int64, reason: String) throws {
    try writer.write { db in
      try db.execute(
        sql: "UPDATE outbox SET lastError = ?, nextAttemptAt = ?, attempts = attempts + 1 WHERE id = ?",
        arguments: [reason, Self.parkedForever, id])
    }
  }

  /// Far enough in the future that nothing retries it, near enough that it is an
  /// obviously artificial value in the database.
  static let parkedForever: Double = 4_102_444_800_000  // 2100-01-01

  /// Jobs parked because they cannot be sent — what an export/recovery UI lists.
  public func parkedJobs() throws -> [OutboxJob] {
    try writer.read { db in
      try OutboxJob
        .filter(Column("nextAttemptAt") >= Self.parkedForever)
        .order(Column("id"))
        .fetchAll(db)
    }
  }

  /// Delete the job AND hold the document's queue, in one transaction.
  ///
  /// `completedAndBlock` promises both. Doing them separately leaves a window —
  /// and a reconciliation that lands in it can decide the document is merely
  /// `pending`, after which everything queued behind the conflict drains.
  public func completeJobAndBlockQueue(id: Int64, documentLocalId: String, reason: String) throws {
    try writer.write { db in
      _ = try OutboxJob.deleteOne(db, key: id)
      try db.execute(
        sql: "UPDATE documents SET queueBlockedReason = ? WHERE localId = ?",
        arguments: [reason, documentLocalId])
    }
  }

  public func completeJob(id: Int64) throws {
    _ = try writer.write { db in try OutboxJob.deleteOne(db, key: id) }
  }

  /// Record a failed attempt and schedule the retry. The job stays at the head of
  /// its document's queue: retry-until-acked is what makes the server's
  /// single-slot replay window safe.
  public func failJob(id: Int64, error: String, retryAfter: Double, now: Double = Date().timeIntervalSince1970 * 1000) throws {
    try writer.write { db in
      try db.execute(
        sql: """
          UPDATE outbox
          SET attempts = attempts + 1, lastError = ?, nextAttemptAt = ?
          WHERE id = ?
          """,
        arguments: [error, now + retryAfter * 1000, id])
    }
  }

  /// Everything a server-rejected `commitEdit` implies, in ONE transaction.
  ///
  /// `documents.commitEdit` inserts the node whatever the head check says, so a
  /// rejection means: the text is safe on the server, and the two heads are
  /// branches the user has to choose between. Doing this in pieces — mark
  /// synced, record the revision, delete the job, then reconcile — is what let
  /// the generic reconciliation classify the remote head as "the server has not
  /// seen our nodes yet" and release the barrier, stranding the committed node
  /// off the server's branch with no resolver and a `pending` badge.
  ///
  /// The barrier written here is DURABLE: only a resolution clears it.
  public func recordCommitDivergence(
    documentLocalId: String,
    jobId: Int64,
    syncedNodeId: String,
    remoteHeadNodeId: String,
    remotePointerRevision: Double?
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      _ = try DocNodeRecord
        .filter(Column("documentLocalId") == documentLocalId)
        .filter(Column("nodeId") == syncedNodeId)
        .updateAll(db, Column("synced").set(to: true))
      _ = try OutboxJob.deleteOne(db, key: jobId)

      document.syncState = .diverged
      document.remoteHeadNodeId = remoteHeadNodeId
      document.divergedRemoteHeadNodeId = remoteHeadNodeId
      if let remotePointerRevision { document.remotePointerRevision = remotePointerRevision }
      document.queueBlockedReason = QueueBlockReason.diverged.rawValue
      try document.update(db)
    }
  }

  /// Push a job's next attempt out WITHOUT recording a failure.
  ///
  /// A server answer of "nothing was written, your baseline is stale" is not an
  /// error: the job is fine and the next attempt will carry the refreshed
  /// baseline. Writing `lastError` would derive `SyncState.failed` from it and
  /// put a stuck-queue badge on a queue that is working exactly as designed.
  public func deferJob(
    id: Int64, retryAfter: Double, now: Double = Date().timeIntervalSince1970 * 1000
  ) throws {
    try writer.write { db in
      try db.execute(
        sql: "UPDATE outbox SET attempts = attempts + 1, nextAttemptAt = ? WHERE id = ?",
        arguments: [now + retryAfter * 1000, id])
    }
  }

  /// Rewrite a queued job in place — used when a divergence resolution rebases a
  /// commit onto the remote head. The `clientMutationId` is deliberately NOT
  /// reused: the payload changed, so it is a different mutation.
  public func replaceJob(id: Int64, with job: OutboxJob) throws {
    try writer.write { db in
      var replacement = job
      replacement.id = id
      try replacement.update(db)
    }
  }

  // MARK: - Document sync state

  public func setSyncState(
    documentLocalId: String,
    _ state: SyncState,
    remoteHeadNodeId: String? = nil,
    remoteUpdatedAt: Double? = nil,
    remotePointerRevision: Double? = nil,
    divergedRemoteHeadNodeId: String?? = nil
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      document.syncState = state
      // A divergence and its barrier are one fact; writing them separately is
      // what let a restart drain past an unresolved conflict.
      if state == .diverged { document.queueBlockedReason = QueueBlockReason.diverged.rawValue }
      if let remoteHeadNodeId { document.remoteHeadNodeId = remoteHeadNodeId }
      if let remoteUpdatedAt { document.remoteUpdatedAt = remoteUpdatedAt }
      if let remotePointerRevision { document.remotePointerRevision = remotePointerRevision }
      if let divergedRemoteHeadNodeId {
        document.divergedRemoteHeadNodeId = divergedRemoteHeadNodeId
      }
      try document.update(db)
    }
  }

  public func attachConvexId(documentLocalId: String, convexId: String) throws {
    try writer.write { db in
      try db.execute(
        sql: "UPDATE documents SET convexId = ? WHERE localId = ?",
        arguments: [convexId, documentLocalId])
    }
  }

  // MARK: - Secondary tables

  public func saveVersions(_ versions: [VersionRecord]) throws {
    try writer.write { db in for version in versions { try version.save(db) } }
  }

  public func versions(documentLocalId: String) throws -> [VersionRecord] {
    try writer.read {
      try VersionRecord
        .filter(Column("documentLocalId") == documentLocalId)
        .order(Column("createdAt").desc)
        .fetchAll($0)
    }
  }

  public func saveComments(_ comments: [CommentRecord]) throws {
    try writer.write { db in for comment in comments { try comment.save(db) } }
  }

  public func comments(documentLocalId: String) throws -> [CommentRecord] {
    try writer.read {
      try CommentRecord.filter(Column("documentLocalId") == documentLocalId)
        .order(Column("createdAt")).fetchAll($0)
    }
  }

  public func saveReviewBranches(_ branches: [ReviewBranchRecord]) throws {
    try writer.write { db in for branch in branches { try branch.save(db) } }
  }

  public func reviewBranches(documentLocalId: String) throws -> [ReviewBranchRecord] {
    try writer.read {
      try ReviewBranchRecord.filter(Column("documentLocalId") == documentLocalId).fetchAll($0)
    }
  }

  public func saveAIRun(_ run: AIRunRecord) throws {
    try writer.write { try run.save($0) }
  }

  public func aiRuns(documentLocalId: String?) throws -> [AIRunRecord] {
    try writer.read { db in
      var request = AIRunRecord.order(Column("createdAt").desc)
      if let documentLocalId {
        request = request.filter(Column("documentLocalId") == documentLocalId)
      }
      return try request.fetchAll(db)
    }
  }

  /// Words written on a local calendar day. Monotonic, matching
  /// `writingStats.record`: a lower number never overwrites a higher one, so a
  /// second device reporting a stale count cannot erase progress.
  public func recordWritingStat(date: String, words: Int, now: Double = Date().timeIntervalSince1970 * 1000) throws {
    try writer.write { db in
      let existing = try WritingStatRecord.fetchOne(db, key: date)
      guard words > (existing?.words ?? -1) else { return }
      try WritingStatRecord(date: date, words: words, updatedAt: now, dirty: true).save(db)
    }
  }

  public func writingStats() throws -> [WritingStatRecord] {
    try writer.read { try WritingStatRecord.order(Column("date")).fetchAll($0) }
  }

  public func dirtyWritingStats() throws -> [WritingStatRecord] {
    try writer.read { try WritingStatRecord.filter(Column("dirty") == true).fetchAll($0) }
  }

  public func markWritingStatsClean(dates: [String]) throws {
    guard !dates.isEmpty else { return }
    try writer.write { db in
      _ = try WritingStatRecord.filter(dates.contains(Column("date")))
        .updateAll(db, Column("dirty").set(to: false))
    }
  }

  public func setting(_ key: String) throws -> SettingRecord? {
    try writer.read { try SettingRecord.fetchOne($0, key: key) }
  }

  public func settings() throws -> [SettingRecord] {
    try writer.read { try SettingRecord.fetchAll($0) }
  }

  public func saveSetting(key: String, json: String, dirty: Bool = true, now: Double = Date().timeIntervalSince1970 * 1000) throws {
    try writer.write { try SettingRecord(key: key, json: json, updatedAt: now, dirty: dirty).save($0) }
  }

  public func saveWindowState(_ state: WindowStateRecord) throws {
    try writer.write { try state.save($0) }
  }

  public func windowState(windowId: String) throws -> WindowStateRecord? {
    try writer.read { try WindowStateRecord.fetchOne($0, key: windowId) }
  }

  public func windowStates() throws -> [WindowStateRecord] {
    try writer.read { try WindowStateRecord.fetchAll($0) }
  }

  /// Remove a document and everything keyed to it. The outbox is deliberately
  /// untouched: a queued `remove` job has to outlive the row it deletes.
  public func deleteDocumentRow(localId: String) throws {
    _ = try writer.write { db in try DocumentRecord.deleteOne(db, key: localId) }
  }

  /// Close the database so every subsequent read fails — for the fail-closed
  /// tests, which need a store that errors rather than one that is merely empty.
  public func closeForTesting() throws {
    try writer.close()
  }

  /// Schema introspection, for the migration test.
  public func tableExists(_ name: String) throws -> Bool {
    try writer.read { try $0.tableExists(name) }
  }

  /// Which Clerk user this mirror belongs to.
  ///
  /// Kept out of the user-keyed tables on purpose: it has to survive a purge and
  /// be readable before any session is published, so a cold start can tell
  /// "user B opened an app whose database belongs to A" from "A came back".
  public static let mirrorOwnerKey = "mirror-owner"

  /// This device's provenance id (`docNodes.origin`), owned by `SyncEngine`.
  ///
  /// Named here because a purge has to keep it: it identifies the Mac, not the
  /// account, and minting a new one on every sign-in would make the history
  /// panel show one machine as several.
  public static let deviceOriginKey = "device-origin"

  public func mirrorOwner() throws -> String? {
    try setting(Self.mirrorOwnerKey)?.json
  }

  /// Purge every user-keyed row and record the new owner, in ONE transaction.
  ///
  /// Two `try?` calls could leave the rows in place while ownership moved on —
  /// which is precisely how one account ends up reading another's documents.
  /// Either both happen or neither does.
  public func purgeAndSetMirrorOwner(_ userId: String?) throws {
    try writer.write { db in
      // documents cascades into doc_nodes/versions/comments/review_branches/ai_runs.
      try db.execute(sql: "DELETE FROM documents")
      try db.execute(sql: "DELETE FROM outbox")
      try db.execute(sql: "DELETE FROM writing_stats")
      // The device id is not the account's data; keeping it stops one Mac
      // reappearing as a new device in the history panel after every sign-in.
      try db.execute(
        sql: "DELETE FROM settings WHERE key <> ?", arguments: [Self.deviceOriginKey])
      try db.execute(sql: "DELETE FROM window_state")
      try db.execute(sql: "DELETE FROM ai_runs")
      if let userId {
        try SettingRecord(
          key: Self.mirrorOwnerKey, json: userId,
          updatedAt: Date().timeIntervalSince1970 * 1000, dirty: false
        ).insert(db)
      }
    }
    reclaimSpace()
  }

  public func setMirrorOwner(_ userId: String?) throws {
    try writer.write { db in
      guard let userId else {
        _ = try SettingRecord.deleteOne(db, key: Self.mirrorOwnerKey)
        return
      }
      try SettingRecord(
        key: Self.mirrorOwnerKey, json: userId,
        updatedAt: Date().timeIntervalSince1970 * 1000, dirty: false
      ).save(db)
    }
  }

  // MARK: - Sign-out

  /// Purge every user-keyed row. Sign-out must leave nothing readable behind
  /// (plan 023 §4.1(4)); the backend's `account.deleteEverything` action is a
  /// separate, later concern.
  public func purgeEverything() throws {
    try writer.write { db in
      // documents cascades into doc_nodes/versions/comments/review_branches/ai_runs.
      try db.execute(sql: "DELETE FROM documents")
      try db.execute(sql: "DELETE FROM outbox")
      try db.execute(sql: "DELETE FROM writing_stats")
      // Every setting except the ownership marker, which has to outlive the
      // purge so a later cold start can still tell whose database this is, and
      // the device id, which belongs to the machine rather than the account.
      try db.execute(
        sql: "DELETE FROM settings WHERE key NOT IN (?, ?)",
        arguments: [Self.mirrorOwnerKey, Self.deviceOriginKey])
      try db.execute(sql: "DELETE FROM window_state")
      try db.execute(sql: "DELETE FROM ai_runs")
    }
    reclaimSpace()
  }

  /// Reclaim the pages the purge freed, so the deleted text is not still
  /// sitting in the file.
  ///
  /// Deliberately NOT `throws`. It runs after the purge transaction has
  /// committed, so reporting its failure as the failure of the identity
  /// transition would tell the caller to retry a decision whose destructive
  /// half already happened — `claimMirror` saying "could not claim" over a
  /// store the new user already owns, or sign-out throwing with Clerk already
  /// signed out and the rows already gone. Maintenance that did not run is
  /// logged and picked up by the next purge.
  private func reclaimSpace() {
    do {
      if let injected = maintenanceFailureForTesting { throw injected }
      try writer.writeWithoutTransaction { try $0.execute(sql: "VACUUM") }
    } catch {
      logger.error(
        "VACUUM after a purge failed; the transition itself committed: \(error.localizedDescription, privacy: .public)"
      )
    }
  }

  /// Forces `reclaimSpace()` to fail. There is no portable way to make SQLite
  /// refuse a `VACUUM` on demand, and the property under test is precisely that
  /// a post-commit failure is not reported as a failed transition.
  private var maintenanceFailureForTesting: (any Error)?

  func setMaintenanceFailureForTesting(_ error: (any Error)?) {
    maintenanceFailureForTesting = error
  }

  // MARK: - File protection

  private static func prepareDirectory(_ directory: URL) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    #if os(iOS)
      // Set it on the directory FIRST: SQLite's -wal and -shm files inherit the
      // directory's class when they are created, and they hold the same text.
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: directory.path)
    #endif
  }

  private static func protect(_ url: URL) throws {
    #if os(iOS)
      // `completeUntilFirstUserAuthentication`, not `complete`: background
      // sync, widgets and the share extension all need to read the mirror while
      // the device is locked.
      for suffix in ["", "-wal", "-shm"] {
        let path = url.path + suffix
        guard FileManager.default.fileExists(atPath: path) else { continue }
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
          ofItemAtPath: path)
      }
    #endif
  }
}
