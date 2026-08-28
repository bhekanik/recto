import Foundation
import GRDB
import RectoHistory

public enum StoreError: Error, Equatable, Sendable {
  case documentNotFound(String)
  case nodeNotFound(document: String, node: String)
  case headMoved(expected: String, actual: String)
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

  private let writer: any DatabaseWriter
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

  public func save(_ document: DocumentRecord) throws {
    try writer.write { try document.save($0) }
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
    expectedHeadNodeId: String,
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

      var stored = node
      stored.materialized = markdown
      stored.materializedAt = now
      try stored.save(db)

      document.localHeadNodeId = node.nodeId
      document.markdown = markdown
      document.wordCount = wordCount
      // The node now describes the text, so there is no draft ahead of the head.
      document.draftMarkdown = nil
      document.draftSelectionAnchor = nil
      document.draftSelectionHead = nil
      document.updatedAt = now
      if document.syncState != .diverged { document.syncState = .pending }
      try document.update(db)

      if var job { try job.insert(db) }
      try Self.trimMaterializationCache(db, documentLocalId: documentLocalId)
      return document
    }
  }

  /// Move the head to an existing node (undo, redo, navigate, adopt-remote).
  @discardableResult
  public func moveHead(
    documentLocalId: String,
    to nodeId: String,
    markdown: String,
    wordCount: Int,
    job: OutboxJob?,
    clearDivergence: Bool = false,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws -> DocumentRecord {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
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
      document.wordCount = wordCount
      document.draftMarkdown = nil
      document.draftSelectionAnchor = nil
      document.draftSelectionHead = nil
      document.updatedAt = now
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
  public func saveDraft(
    documentLocalId: String,
    markdown: String,
    selection: NodeSelection?,
    wordCount: Int,
    job: OutboxJob?,
    now: Double = Date().timeIntervalSince1970 * 1000
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      document.draftMarkdown = markdown == document.markdown ? nil : markdown
      document.draftSelectionAnchor = selection?.anchor
      document.draftSelectionHead = selection?.head
      document.wordCount = wordCount
      document.updatedAt = now
      try document.update(db)
      if var job { try job.insert(db) }
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
      try String.fetchAll(
        db,
        sql: "SELECT documentLocalId FROM outbox GROUP BY documentLocalId ORDER BY MIN(id)")
    }
  }

  /// When the earliest backed-off job becomes eligible, so the drain loop can
  /// sleep exactly that long instead of polling.
  public func earliestNextAttempt() throws -> Double? {
    try writer.read { db in
      try Double.fetchOne(db, sql: "SELECT MIN(nextAttemptAt) FROM outbox")
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

  public func pendingJobCount() throws -> Int {
    try writer.read { try OutboxJob.fetchCount($0) }
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
    divergedRemoteHeadNodeId: String?? = nil
  ) throws {
    try writer.write { db in
      guard var document = try DocumentRecord.fetchOne(db, key: documentLocalId) else {
        throw StoreError.documentNotFound(documentLocalId)
      }
      document.syncState = state
      if let remoteHeadNodeId { document.remoteHeadNodeId = remoteHeadNodeId }
      if let remoteUpdatedAt { document.remoteUpdatedAt = remoteUpdatedAt }
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

  /// Schema introspection, for the migration test.
  public func tableExists(_ name: String) throws -> Bool {
    try writer.read { try $0.tableExists(name) }
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
      try db.execute(sql: "DELETE FROM settings")
      try db.execute(sql: "DELETE FROM window_state")
      try db.execute(sql: "DELETE FROM ai_runs")
    }
    // Reclaim the pages so the deleted text is not still sitting in the file.
    try writer.writeWithoutTransaction { try $0.execute(sql: "VACUUM") }
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
