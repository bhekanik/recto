import Foundation
import OSLog
import RectoAuth
import RectoHistory
import RectoStore

/// What the sync engine tells the UI and the open `DocumentSession`s.
public enum SyncEvent: Sendable, Equatable {
  /// The mirror changed underneath an open document (remote nodes arrived, or a
  /// head was adopted). Reload from the store.
  case documentChanged(localId: String)
  case syncStateChanged(localId: String, state: SyncState)
  /// Both branches are kept; the UI offers the compare sheet. Nothing resolves
  /// automatically — that would silently pick a winner.
  case diverged(localId: String, local: String, remote: String)
  /// A document appeared or disappeared remotely.
  case libraryChanged
}

/// Drains the outbox and mirrors Convex into `RectoStore` (plan 023 §4.3, §4.4).
public actor SyncEngine {
  private let logger = Logger(subsystem: "com.bhekani.recto", category: "sync")
  private let store: RectoStore
  private let transport: any RectoTransport
  private let origin: String

  private var eventContinuations: [UUID: AsyncStream<SyncEvent>.Continuation] = [:]
  private var drainTask: Task<Void, Never>?
  private var drainRequested = false
  private var isDraining = false
  /// `start()` has been called. Until then `requestDrain()` only records that
  /// work is waiting: an engine nobody started must not reach the network.
  private var isRunning = false
  /// Documents a window has open. Held separately from the subscription tasks
  /// so `stop()` / `resume()` can tear the sockets down and bring the same set
  /// back up.
  private var openDocumentIds: Set<String> = []
  private var nodeSubscriptions: [String: Task<Void, Never>] = [:]
  private var libraryTask: Task<Void, Never>?
  private var retryTasks: [Int64: Task<Void, Never>] = [:]

  /// A per-device provenance id, stored in `docNodes.origin`. The web keeps its
  /// own in localStorage; here it lives in the settings table so it survives a
  /// relaunch and identifies this Mac in the history panel.
  public static let originSettingKey = "device-origin"

  public init(store: RectoStore, transport: any RectoTransport, origin: String) {
    self.store = store
    self.transport = transport
    self.origin = origin
  }

  /// Resolve (or mint) this device's provenance id.
  public static func resolveOrigin(store: RectoStore) async throws -> String {
    if let existing = try await store.setting(originSettingKey) { return existing.json }
    let fresh = UUID().uuidString
    try await store.saveSetting(key: originSettingKey, json: fresh, dirty: false)
    return fresh
  }

  public var events: AsyncStream<SyncEvent> {
    AsyncStream { continuation in
      let id = UUID()
      eventContinuations[id] = continuation
      continuation.onTermination = { [weak self] _ in
        Task { await self?.removeContinuation(id) }
      }
    }
  }

  private func removeContinuation(_ id: UUID) { eventContinuations[id] = nil }

  private func emit(_ event: SyncEvent) {
    for continuation in eventContinuations.values { continuation.yield(event) }
  }

  // MARK: - Lifecycle

  /// Start (or restart) the library subscription and the drain loop.
  ///
  /// Call on launch, on every auth transition, and on foreground: a Convex
  /// subscription that hit a server error is a completed publisher and never
  /// comes back on its own (N0a).
  public func start() {
    isRunning = true
    libraryTask?.cancel()
    libraryTask = Task { [weak self] in await self?.runLibrarySubscription() }
    for localId in openDocumentIds { subscribeToNodes(localId: localId) }
    requestDrain()
  }

  /// Tear down every subscription. The outbox is untouched — that is the point
  /// of it.
  /// Tear down every socket. `openDocumentIds` and the outbox survive — that is
  /// what lets `resume()` bring the same documents back after a suspend.
  public func stop() {
    isRunning = false
    libraryTask?.cancel()
    libraryTask = nil
    for task in nodeSubscriptions.values { task.cancel() }
    nodeSubscriptions.removeAll()
    for task in retryTasks.values { task.cancel() }
    retryTasks.removeAll()
    drainTask?.cancel()
    drainTask = nil
    isDraining = false
  }

  /// The socket reconnected, the network changed, or the app came to the
  /// foreground.
  public func resume() async {
    _ = await transport.loginFromCache()
    // `stop()` keeps `openDocumentIds`, so `start()` brings the same documents
    // back up on the new socket.
    stop()
    start()
  }

  // MARK: - Library subscription

  private func runLibrarySubscription() async {
    do {
      for try await summaries in await transport.documentsStream() {
        try await mirrorLibrary(summaries)
        emit(.libraryChanged)
      }
    } catch {
      logger.error(
        "documents.list subscription ended: \(error.localizedDescription, privacy: .public)")
    }
  }

  /// Apply a `documents.list` result. Public so a caller can force a refresh
  /// without waiting for the subscription to tick.
  public func mirrorLibrary(_ summaries: [RemoteDocumentSummary]) async throws {
    let known = try await store.documents()
    let byConvexId = Dictionary(
      known.compactMap { doc in doc.convexId.map { ($0, doc) } }, uniquingKeysWith: { first, _ in first })

    for summary in summaries {
      if var local = byConvexId[summary.id] {
        guard local.title != summary.title || local.remoteUpdatedAt != summary.updatedAt else {
          continue
        }
        local.title = summary.title
        local.remoteUpdatedAt = summary.updatedAt
        try await store.save(local)
      } else {
        try await hydrate(convexId: summary.id)
      }
    }

    // A document that vanished from the server is gone — unless this device
    // still has unsent work for it, in which case the outbox wins.
    let remoteIds = Set(summaries.map(\.id))
    for local in known {
      guard let convexId = local.convexId, !remoteIds.contains(convexId) else { continue }
      guard try await store.pendingJobs(documentLocalId: local.localId).isEmpty else { continue }
      try await store.deleteDocumentRow(localId: local.localId)
    }
  }

  /// Pull a document this device has never seen: metadata, then its node DAG.
  func hydrate(convexId: String) async throws {
    guard let remote = try await transport.getDocument(documentId: convexId) else { return }
    let localId = UUID().uuidString
    try await store.save(
      DocumentRecord(
        localId: localId,
        convexId: remote.id,
        title: remote.title,
        markdown: remote.markdown,
        wordCount: Int(remote.wordCount),
        localHeadNodeId: remote.currentNodeId,
        remoteHeadNodeId: remote.currentNodeId,
        remoteUpdatedAt: remote.updatedAt,
        syncState: .synced,
        updatedAt: remote.updatedAt,
        createdAt: remote.createdAt))

    let nodes = try await transport.listNodes(documentId: remote.id, sinceCreatedAt: nil)
    try await store.mergeRemoteNodes(
      documentLocalId: localId, nodes: nodes.map { $0.record(documentLocalId: localId) })
  }

  // MARK: - Per-document node subscription

  /// Mirror this document's nodes while it is open.
  ///
  /// Like `requestDrain()`, this only records the intent until `start()` has been
  /// called: an engine nobody started must not open a socket. That also makes a
  /// test that drives `reconcileHead` / `drainNow` by hand deterministic, instead
  /// of racing a subscription tick it never asked for.
  public func openDocument(localId: String) async {
    openDocumentIds.insert(localId)
    subscribeToNodes(localId: localId)
  }

  public func closeDocument(localId: String) {
    openDocumentIds.remove(localId)
    nodeSubscriptions[localId]?.cancel()
    nodeSubscriptions[localId] = nil
  }

  private func subscribeToNodes(localId: String) {
    guard isRunning, nodeSubscriptions[localId] == nil else { return }
    nodeSubscriptions[localId] = Task { [weak self] in
      await self?.runNodeSubscription(localId: localId)
    }
  }

  private func runNodeSubscription(localId: String) async {
    guard let document = try? await store.document(localId: localId),
      let convexId = document.convexId
    else { return }

    // Deliberately no `sinceCreatedAt` cursor: `mergeRemoteNodes` is idempotent,
    // a reconnect re-delivers the whole result anyway, and a cursor would drop a
    // node whose `createdAt` came from a device with a skewed clock.
    do {
      for try await nodes in await transport.nodesStream(
        documentId: convexId, sinceCreatedAt: nil)
      {
        try await store.mergeRemoteNodes(
          documentLocalId: localId, nodes: nodes.map { $0.record(documentLocalId: localId) })
        try await reconcileHead(localId: localId)
        emit(.documentChanged(localId: localId))
      }
    } catch {
      logger.error(
        "docNodes subscription for \(localId, privacy: .public) ended: \(error.localizedDescription, privacy: .public)"
      )
    }
  }

  /// Compare the local head with the server's and apply §4.4.
  ///
  /// `pullMissingNodes` is false on the second pass, after a pull, so a server
  /// head that stays unreachable cannot recurse forever.
  public func reconcileHead(localId: String, pullMissingNodes: Bool = true) async throws {
    guard let document = try await store.document(localId: localId),
      let convexId = document.convexId,
      let remote = try await transport.getDocument(documentId: convexId)
    else { return }

    let hasPendingWork =
      try await !store.pendingJobs(documentLocalId: localId).isEmpty
      || document.draftMarkdown != nil
    let nodesById = indexNodes(try await store.nodes(documentLocalId: localId).map(\.docNode))

    // A reconcile must never clear `.failed`. The failure is about the outbox,
    // not about where the heads are, and a node subscription tick arriving after
    // a failed drain would otherwise reset the badge to "pending" and hide a
    // stuck queue. The queue itself is asked, immediately before each write —
    // `document` was read before several awaits and its `syncState` is already
    // stale by the time we get here.
    func settled(_ candidate: SyncState) async -> SyncState {
      let failing = (try? await store.hasFailedJobs(documentLocalId: localId)) ?? false
      return failing ? .failed : candidate
    }

    switch ConflictResolver.resolve(
      localHead: document.localHeadNodeId, remoteHead: remote.currentNodeId,
      nodesById: nodesById, hasPendingWork: hasPendingWork)
    {
    case .inSync:
      try await store.setSyncState(
        documentLocalId: localId, await settled(hasPendingWork ? .pending : .synced),
        remoteHeadNodeId: remote.currentNodeId, remoteUpdatedAt: remote.updatedAt,
        divergedRemoteHeadNodeId: .some(nil))

    case .awaitingNodes(let remoteHead):
      // Fetch the missing branch rather than waiting for the subscription to
      // deliver it. A Convex subscription that hit a server error is a completed
      // publisher that never returns (N0a), so a document whose convergence
      // depended on one would simply stop converging.
      guard pullMissingNodes else {
        logger.error(
          "remote head \(remoteHead, privacy: .public) is still unreachable for \(localId, privacy: .public)"
        )
        return
      }
      let missing = try await transport.listNodes(documentId: convexId, sinceCreatedAt: nil)
      try await store.mergeRemoteNodes(
        documentLocalId: localId, nodes: missing.map { $0.record(documentLocalId: localId) })
      try await reconcileHead(localId: localId, pullMissingNodes: false)

    case .uploadAncestors:
      // The server is behind us; the outbox already holds the work. Nothing to
      // adopt and nothing to overwrite.
      try await store.setSyncState(
        documentLocalId: localId, await settled(.pending),
        remoteHeadNodeId: remote.currentNodeId,
        remoteUpdatedAt: remote.updatedAt)

    case .adoptRemote(let headNodeId, let whenIdle):
      guard whenIdle else {
        // The user is mid-edit. Record where the server is and adopt once the
        // outbox drains; moving the caret now is plan 022 in a new costume.
        try await store.setSyncState(
          documentLocalId: localId, await settled(.pending), remoteHeadNodeId: headNodeId,
          remoteUpdatedAt: remote.updatedAt)
        return
      }
      let markdown = try await store.materializedMarkdown(
        documentLocalId: localId, nodeId: headNodeId)
      _ = try await store.moveHead(
        documentLocalId: localId, to: headNodeId, markdown: markdown,
        wordCount: Int(remote.wordCount), job: nil, clearDivergence: true)
      try await store.setSyncState(
        documentLocalId: localId, .synced, remoteHeadNodeId: headNodeId, remoteUpdatedAt: remote.updatedAt,
        divergedRemoteHeadNodeId: .some(nil))
      emit(.documentChanged(localId: localId))
      emit(.syncStateChanged(localId: localId, state: .synced))

    case .diverged(let local, let remoteHead):
      // Both branches stay in the DAG. The UI offers keep local / keep remote /
      // edit merged; resolving it here would silently pick a winner.
      try await store.setSyncState(
        documentLocalId: localId, .diverged, remoteHeadNodeId: remoteHead, remoteUpdatedAt: remote.updatedAt,
        divergedRemoteHeadNodeId: remoteHead)
      emit(.diverged(localId: localId, local: local, remote: remoteHead))
      emit(.syncStateChanged(localId: localId, state: .diverged))
    }
  }

  // MARK: - Outbox drain

  /// Ask for a drain. Coalesced: a burst of keystrokes produces one pass.
  public func requestDrain() {
    drainRequested = true
    guard isRunning, !isDraining else { return }
    drainTask = Task { [weak self] in await self?.drainLoop() }
  }

  /// Drain everything now and return when the queue is empty or stuck. Used by
  /// `DocumentSession.flush()` and by the tests.
  public func drainNow() async {
    do {
      for localId in try await store.documentsWithPendingJobs() {
        await drainDocument(localId: localId)
      }
    } catch {
      storeFailed(error, while: "listing documents with queued work")
    }
  }

  private func drainLoop() async {
    isDraining = true
    defer { isDraining = false }
    while drainRequested {
      drainRequested = false
      if Task.isCancelled { return }
      await drainNow()
    }
  }

  /// A local-store failure during a drain is not "nothing to send" — it means the
  /// mirror is unreadable, and sync would otherwise sit silently idle forever.
  private func storeFailed(_ error: any Error, while action: String) {
    logger.error(
      "local store failed while \(action, privacy: .public): \(error.localizedDescription, privacy: .public)"
    )
  }

  private enum JobOutcome {
    /// Delete the job and continue with the next one.
    case completed
    /// Delete the job but stop draining this document (a conflict is now in
    /// charge of what happens next).
    case completedAndStop
    /// Leave the job queued and stop.
    case stop
  }

  /// Send this document's queue in order, stopping at the first job that cannot
  /// complete. Retry-until-acknowledged: the head of the queue is re-sent with
  /// the same `clientMutationId` until the server answers, because the server
  /// remembers exactly one and a pipelined replay would be answered `diverged`.
  func drainDocument(localId: String) async {
    while let job = try? await store.nextJob(documentLocalId: localId), let jobId = job.id {
      guard let document = try? await store.document(localId: localId) else {
        // The row is gone: a queued delete has already done its work and
        // anything else is moot.
        try? await store.completeJob(id: jobId)
        continue
      }

      do {
        switch try await send(job, document: document) {
        case .completed:
          try await store.completeJob(id: jobId)
        case .completedAndStop:
          try await store.completeJob(id: jobId)
          return
        case .stop:
          return
        }
      } catch {
        await handleSendFailure(job: job, jobId: jobId, error: error)
        return
      }
    }

    guard let document = try? await store.document(localId: localId),
      document.syncState == .pending || document.syncState == .syncing,
      (try? await store.pendingJobs(documentLocalId: localId))?.isEmpty == true
    else { return }
    try? await store.setSyncState(
        documentLocalId: localId, .synced)
    emit(.syncStateChanged(localId: localId, state: .synced))
  }

  private func send(_ job: OutboxJob, document: DocumentRecord) async throws -> JobOutcome {
    let payload = OutboxPayload.decode(job.payload)

    switch job.kind {
    case .createDocument:
      guard document.convexId == nil else { return .completed }
      let response = try await transport.createDocument(title: payload.title ?? document.title)
      try await store.attachConvexId(
        documentLocalId: document.localId, convexId: response.documentId)
      try await adoptServerRoot(document: document, response: response)
      return .completed

    case .commitEdit:
      guard let convexId = document.convexId else { return .stop }
      let request = CommitEditRequest(
        documentId: convexId,
        nodeId: payload.nodeId ?? "",
        parentNodeId: payload.parentNodeId,
        patch: payload.patch ?? "",
        snapshot: payload.snapshot,
        selection: payload.selection,
        origin: payload.origin ?? origin,
        createdAt: payload.createdAt ?? job.createdAt,
        markdown: payload.markdown ?? document.markdown,
        wordCount: payload.wordCount ?? document.wordCount,
        expectedHeadNodeId: job.baseHeadNodeId ?? document.localHeadNodeId,
        clientMutationId: job.clientMutationId)

      switch try await transport.commitEdit(request).outcome {
      case .committed(let headNodeId, let updatedAt):
        try await store.markNodesSynced(
          documentLocalId: document.localId, nodeIds: [request.nodeId])
        try await store.setSyncState(
        documentLocalId: document.localId, .syncing, remoteHeadNodeId: headNodeId, remoteUpdatedAt: updatedAt,
          divergedRemoteHeadNodeId: .some(nil))
        return .completed

      case .diverged(let remoteHeadNodeId):
        // `commitEdit` inserts the node regardless of the head check, so the
        // text is safe on the server; only the pointer is contended.
        try await store.markNodesSynced(
          documentLocalId: document.localId, nodeIds: [request.nodeId])
        try await resolveDivergence(document: document, remoteHeadNodeId: remoteHeadNodeId)
        return .completedAndStop
      }

    case .pointerMove:
      guard let convexId = document.convexId, let nodeId = payload.nodeId else { return .completed }
      _ = try await transport.updateCurrentNodeId(
        documentId: convexId, currentNodeId: nodeId,
        markdown: payload.markdown ?? document.markdown,
        wordCount: payload.wordCount ?? document.wordCount,
        updatedAt: Date().timeIntervalSince1970 * 1000)
      return .completed

    case .draftSave:
      guard let convexId = document.convexId else { return .stop }
      // A stale answer is not an error: the draft has no node behind it, so
      // dropping the save loses nothing that the next commit will not carry.
      // Either way the server's `updatedAt` is what the next CAS must use.
      let response = try await transport.updateMarkdown(
        documentId: convexId, markdown: payload.markdown ?? document.displayMarkdown,
        wordCount: payload.wordCount ?? document.wordCount,
        expectedUpdatedAt: document.remoteUpdatedAt ?? document.updatedAt,
        title: payload.title)
      try await store.setSyncState(
        documentLocalId: document.localId, document.syncState, remoteUpdatedAt: response.updatedAt)
      return .completed

    case .rename:
      guard let convexId = document.convexId else { return .stop }
      try await transport.rename(documentId: convexId, title: payload.title ?? document.title)
      return .completed

    case .remove:
      guard let convexId = document.convexId else { return .completed }
      try await transport.remove(documentId: convexId)
      try await store.deleteDocumentRow(localId: document.localId)
      return .completedAndStop

    case .writingStats:
      guard let date = payload.date, let words = payload.words else { return .completed }
      try await transport.recordWritingStat(date: date, words: words)
      try await store.markWritingStatsClean(dates: [date])
      return .completed
    }
  }

  /// The server minted its own root node id for an offline-created document.
  /// Re-key the local root so the first commit's `parentNodeId` names a node the
  /// server actually has.
  private func adoptServerRoot(document: DocumentRecord, response: CreateDocumentResponse)
    async throws
  {
    let nodes = try await store.nodes(documentLocalId: document.localId)
    guard let localRoot = nodes.first(where: { $0.parentNodeId == nil }),
      localRoot.nodeId != response.rootNodeId,
      // `documents.create` always snapshots an empty document. Re-keying a root
      // whose snapshot differs would silently change what every child patch
      // applies to.
      (localRoot.snapshot ?? "").isEmpty
    else { return }

    try await store.mergeRemoteNodes(
      documentLocalId: document.localId,
      nodes: [
        DocNodeRecord(
          documentLocalId: document.localId, nodeId: response.rootNodeId, parentNodeId: nil,
          patch: localRoot.patch, snapshot: "", origin: "server", createdAt: localRoot.createdAt,
          materialized: "", synced: true)
      ])
    try await store.replaceRoot(
      documentLocalId: document.localId, oldRootNodeId: localRoot.nodeId,
      newRootNodeId: response.rootNodeId)
  }

  private func resolveDivergence(document: DocumentRecord, remoteHeadNodeId: String) async throws {
    guard let convexId = document.convexId else { return }
    // Pull whatever the other client wrote before deciding. "Is their head above
    // mine or beside it?" cannot be answered without their nodes, and guessing
    // loses a branch.
    let remoteNodes = try await transport.listNodes(documentId: convexId, sinceCreatedAt: nil)
    try await store.mergeRemoteNodes(
      documentLocalId: document.localId,
      nodes: remoteNodes.map { $0.record(documentLocalId: document.localId) })
    try await reconcileHead(localId: document.localId)
  }

  private func handleSendFailure(job: OutboxJob, jobId: Int64, error: any Error) async {
    let attempts = job.attempts + 1
    let description = String(describing: error)
    // A Clerk token lives 60 seconds and can expire between two jobs of a long
    // drain. Force a re-auth before backing off, or the retry fails identically.
    if description.localizedCaseInsensitiveContains("unauthenticated")
      || description.localizedCaseInsensitiveContains("auth")
    {
      _ = await transport.loginFromCache()
    }

    let delay = outboxBackoff(attempts: attempts)
    try? await store.failJob(id: jobId, error: description, retryAfter: delay)
    try? await store.setSyncState(
        documentLocalId: job.documentLocalId, .failed)
    emit(.syncStateChanged(localId: job.documentLocalId, state: .failed))
    logger.error("outbox job \(jobId) failed (attempt \(attempts)): \(description, privacy: .public)")

    // Wake the loop when the backoff elapses instead of waiting for a keystroke.
    retryTasks[jobId]?.cancel()
    retryTasks[jobId] = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      await self?.finishRetryWait(jobId: jobId)
    }
  }

  private func finishRetryWait(jobId: Int64) {
    retryTasks[jobId] = nil
    requestDrain()
  }
}
