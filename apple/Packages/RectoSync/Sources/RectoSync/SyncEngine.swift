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
  /// The server no longer has this document, but it still holds work that exists
  /// nowhere else. The UI has to offer a decision — it is not ours to make.
  case unsyncedWorkOnRemovedDocument(localId: String)
  /// A queued mutation cannot be sent and never will be. It is parked, not
  /// dropped; the UI needs an export/recovery path.
  case jobUnsendable(localId: String, reason: String)
}

/// Drains the outbox and mirrors Convex into `RectoStore` (plan 023 §4.3, §4.4).
public actor SyncEngine: SyncControlling {
  private let logger = Logger(subsystem: "com.bhekani.recto", category: "sync")
  private let store: RectoStore
  private let transport: any RectoTransport
  private let origin: String

  private var eventContinuations: [UUID: AsyncStream<SyncEvent>.Continuation] = [:]
  /// The ONE drain in flight. Every request joins it rather than starting a
  /// second: two loops would each read the same head job, and the server
  /// remembers a single `clientMutationId`, so the slower duplicate comes back
  /// as a false divergence after the faster one has already moved on.
  private var drainTask: Task<Void, Never>?
  private var drainRequested = false
  private var backoffWake: Task<Void, Never>?
  /// `start()` has been called. Until then `requestDrain()` only records that
  /// work is waiting: an engine nobody started must not reach the network.
  private var isRunning = false
  /// Bumped by every `stop()`. Cancellation does not cancel an in-flight network
  /// call, so a task that was awaiting the transport when an account switch ran
  /// can resume afterwards and write the OLD account's data. Every task checks
  /// this after each external await and before each store write.
  private var lifecycle = 0

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
  public static let originSettingKey = RectoStore.deviceOriginKey

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
    let generation = lifecycle
    libraryTask?.cancel()
    libraryTask = Task { [weak self] in await self?.runLibrarySubscription() }
    for localId in openDocumentIds { subscribeToNodes(localId: localId) }
    Task { [weak self] in await self?.rehydrateIncompleteDocuments(generation: generation) }
    Task { [weak self] in await self?.reconcileAbandonedBarriers(generation: generation) }
    requestDrain()
  }

  /// Tear down every subscription. The outbox is untouched — that is the point
  /// of it.
  /// Tear down every socket. `openDocumentIds` and the outbox survive — that is
  /// what lets `resume()` bring the same documents back after a suspend.
  public func stop() async {
    // Bump FIRST: anything already past its cancellation check must still fail
    // the generation check before it writes.
    lifecycle += 1
    isRunning = false

    var pending: [Task<Void, Never>] = []
    if let libraryTask { pending.append(libraryTask) }
    pending.append(contentsOf: nodeSubscriptions.values)
    pending.append(contentsOf: retryTasks.values)
    if let drainTask { pending.append(drainTask) }
    if let backoffWake { pending.append(backoffWake) }

    libraryTask = nil
    nodeSubscriptions.removeAll()
    retryTasks.removeAll()
    drainTask = nil
    backoffWake = nil

    for task in pending { task.cancel() }
    // Awaiting is the point: cancellation does not abort a network call, and
    // returning early lets a stale task resume after the caller has purged and
    // switched accounts.
    for task in pending { await task.value }
  }

  /// The socket reconnected, the network changed, or the app came to the
  /// foreground.
  /// The socket reconnected, the network changed, or the app came to the
  /// foreground.
  ///
  /// Deliberately does NOT log in again. `loginFromCache` replaces the FFI auth
  /// bridge and its callback, and the Rust worker can be executing the previous
  /// callback at that moment (convex-swift #26 — a use-after-free). The existing
  /// bridge already refreshes an expired token through its own pull callback, so
  /// a foreground resume needs sockets rebuilt, not credentials replaced.
  public func resume() async {
    // `stop()` keeps `openDocumentIds`, so `start()` brings the same documents
    // back up on the new socket.
    let resumeGeneration = lifecycle + 1
    await stop()
    // Another stop can overtake us while the cancelled transport call winds
    // down. That newer lifecycle owns the stopped state; this stale resume must
    // not bring sockets back after sign-out or an account switch.
    guard lifecycle == resumeGeneration else { return }
    start()
  }

  /// Replace the auth bridge, with every socket stopped first.
  ///
  /// The only safe moment to swap the FFI callback is when nothing can be
  /// calling it. Used for auth-error recovery; ordinary expiry never comes
  /// through here.
  private func reauthenticateQuiesced() async {
    let subscriptions = Array(nodeSubscriptions.values) + [libraryTask].compactMap { $0 }
    libraryTask = nil
    nodeSubscriptions.removeAll()
    for task in subscriptions { task.cancel() }
    for task in subscriptions { await task.value }

    _ = await transport.loginFromCache()

    guard isRunning else { return }
    libraryTask = Task { [weak self] in await self?.runLibrarySubscription() }
    for localId in openDocumentIds { subscribeToNodes(localId: localId) }
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
    let generation = lifecycle
    await rehydrateIncompleteDocuments(generation: generation)
    guard isCurrent(generation) else { return }

    let known = try await store.documents()
    let byConvexId = Dictionary(
      known.compactMap { doc in doc.convexId.map { ($0, doc) } },
      uniquingKeysWith: { first, _ in first })
    let byLocalId = Dictionary(
      known.map { ($0.localId, $0) },
      uniquingKeysWith: { first, _ in first })

    for summary in summaries {
      guard isCurrent(generation) else { return }
      let local: DocumentRecord
      if let matched = byConvexId[summary.id] {
        local = matched
      } else if let documentUuid = summary.documentUuid,
        let pendingCreate = byLocalId[documentUuid],
        pendingCreate.convexId == nil,
        let serverRootNodeId = try await serverRootNodeId(for: summary)
      {
        try await finishCreate(
          document: pendingCreate, convexId: summary.id, serverRootNodeId: serverRootNodeId)
        local = try await store.document(localId: pendingCreate.localId) ?? pendingCreate
      } else {
        try await hydrate(convexId: summary.id, generation: generation)
        continue
      }
      let titleChanged = local.title != summary.title || local.titleMode != summary.titleMode
      let titleMetadataMayHaveChanged =
        titleChanged || summary.updatedAt > (local.remoteTitleUpdatedAt ?? -1)
      let bodyMayHaveChanged = summary.updatedAt > (local.remoteUpdatedAt ?? -1)
      guard titleMetadataMayHaveChanged || bodyMayHaveChanged else { continue }

      if titleMetadataMayHaveChanged {
        // Title only. `local` was read before this loop and a session may have
        // written a draft or a new head since; a whole-record save would revert it.
        _ = try await store.updateRemoteTitle(
          documentLocalId: local.localId, title: summary.title, titleMode: summary.titleMode,
          remoteUpdatedAt: summary.updatedAt)
      }
      // `documents.list` carries no body. A newer `updatedAt` on a document we
      // already have can be another device's draft save, which only `get`
      // reveals — and which stays invisible forever if we just bump the
      // timestamp and move on.
      if bodyMayHaveChanged {
        try await adoptServerBodyIfTrusted(localId: local.localId, generation: generation)
      }
    }

    // A document that vanished from the server is gone — unless this device
    // still holds work that exists nowhere else.
    let remoteIds = Set(summaries.map(\.id))
    for local in known where local.convexId.map({ !remoteIds.contains($0) }) ?? false {
      guard isCurrent(generation) else { return }
      // One transaction: the write-ahead path persists a draft BEFORE its outbox
      // job, so a queue check alone can delete the user's only copy, and a
      // separate check followed by a separate delete can be interleaved by a
      // live edit.
      if try await !store.deleteRemotelyRemovedDocument(localId: local.localId) {
        logger.info(
          "keeping \(local.localId, privacy: .public): removed remotely but it still holds local work"
        )
        emit(.unsyncedWorkOnRemovedDocument(localId: local.localId))
      }
    }
  }

  private func serverRootNodeId(for summary: RemoteDocumentSummary) async throws -> String? {
    return try await transport.listNodes(documentId: summary.id, sinceCreatedAt: nil)
      .first { $0.parentNodeId == nil }?.nodeId
  }

  /// Pull the body and adopt it as a pending draft — but only when the server
  /// vouches for which node it belongs to.
  ///
  /// `documents.markdownHeadNodeId` is that stamp. Absent means the provenance is
  /// unknown; a mismatch means the text belongs to another branch. In both cases
  /// the DAG materialization is the head's text and this body is not.
  func adoptServerBodyIfTrusted(localId: String, generation: Int) async throws {
    guard let document = try await store.document(localId: localId),
      let convexId = document.convexId,
      let remote = try await transport.getDocument(documentId: convexId),
      isCurrent(generation)
    else { return }

    // `updateCurrentNodeId` moves the document row WITHOUT writing `docNodes`,
    // so a remote undo or redo never fires the node subscription. Recording the
    // head and stopping here left the local head on the old branch forever.
    let headMoved = remote.currentNodeId != document.localHeadNodeId

    guard let stamp = remote.markdownHeadNodeId, stamp == remote.currentNodeId else {
      // Unstamped or stamped for another branch: record the timestamps, never
      // the text.
      if headMoved {
        // Reconcile FIRST: it compares the freshly fetched revision against the
        // one still on the row, and recording it here would erase that signal.
        try await reconcileHead(localId: localId)
      } else {
        try await store.setSyncState(
          documentLocalId: localId, document.syncState, remoteHeadNodeId: remote.currentNodeId,
          remoteUpdatedAt: remote.updatedAt, remotePointerRevision: remote.pointerRevision)
      }
      return
    }

    let adopted = try await store.adoptServerDraft(
      documentLocalId: localId, markdown: remote.markdown, wordCount: Int(remote.wordCount),
      title: remote.title,
      stampedHeadNodeId: stamp, remoteUpdatedAt: remote.updatedAt)
    if adopted { emit(.documentChanged(localId: localId)) }
    if headMoved {
      try await reconcileHead(localId: localId)
    } else {
      try await store.setSyncState(
        documentLocalId: localId, document.syncState, remoteHeadNodeId: remote.currentNodeId,
        remoteUpdatedAt: remote.updatedAt, remotePointerRevision: remote.pointerRevision)
    }
  }

  /// Pull a document this device has never seen.
  ///
  /// Both fetches complete before anything is written, and the row and its DAG
  /// go in together: a document whose head node never arrived can never
  /// materialize, and `mirrorLibrary` would skip re-pulling it because the title
  /// and `remoteUpdatedAt` already match.
  func hydrate(convexId: String, into existingLocalId: String? = nil, generation: Int? = nil)
    async throws
  {
    let generation = generation ?? lifecycle
    guard let remote = try await transport.getDocument(documentId: convexId) else { return }
    let nodes = try await transport.listNodes(documentId: remote.id, sinceCreatedAt: nil)
    guard nodes.contains(where: { $0.nodeId == remote.currentNodeId }) else {
      logger.error(
        "refusing to hydrate \(convexId, privacy: .public): head node is missing from the DAG")
      return
    }

    guard isCurrent(generation) else { return }
    let localId = existingLocalId ?? UUID().uuidString
    var document = DocumentRecord(
      localId: localId,
      convexId: remote.id,
      title: remote.title,
      titleMode: remote.titleMode,
      markdown: remote.markdown,
      wordCount: Int(remote.wordCount),
      localHeadNodeId: remote.currentNodeId,
      remoteHeadNodeId: remote.currentNodeId,
      remoteUpdatedAt: remote.updatedAt,
      remoteTitleUpdatedAt: remote.updatedAt,
      remotePointerRevision: remote.pointerRevision,
      remoteMarkdownHeadNodeId: remote.markdownHeadNodeId,
      syncState: .synced,
      updatedAt: remote.updatedAt,
      createdAt: remote.createdAt)

    // The row's `markdown` must be whatever the HEAD materializes to. The
    // server's stored body is only the head's text when it is stamped with the
    // head; otherwise it belongs to some other branch and is carried as a
    // pending draft rather than promoted into the head.
    // The row's `markdown` must be whatever the HEAD materializes to. If the
    // chain cannot be replayed the document is incomplete, not "close enough" —
    // adopting an unstamped body here is exactly the untrusted promotion this
    // whole path exists to prevent. Leave it unwritten and let the next pass
    // pull it again.
    let index = indexNodes(nodes.map { $0.record(documentLocalId: localId).docNode })
    guard let materialized = try? materialize(remote.currentNodeId, index) else {
      logger.error(
        "refusing to hydrate \(convexId, privacy: .public): the head does not materialize")
      return
    }
    document.markdown = materialized
    if remote.markdownHeadNodeId == remote.currentNodeId,
      !(remote.markdown as NSString).isEqual(to: materialized)
    {
      document.draftMarkdown = remote.markdown
    }
    try await store.hydrate(
      document: document, nodes: nodes.map { $0.record(documentLocalId: localId) })
  }

  /// Re-pull any row whose head node is missing — an interrupted hydration that
  /// would otherwise be a document that cannot be opened.
  func rehydrateIncompleteDocuments(generation: Int) async {
    guard let incomplete = try? await store.incompleteDocumentIds(), !incomplete.isEmpty else {
      return
    }
    for localId in incomplete {
      guard let document = try? await store.document(localId: localId),
        let convexId = document.convexId
      else { continue }
      guard isCurrent(generation) else { return }
      logger.info("rehydrating incomplete document \(localId, privacy: .public)")
      try? await hydrate(convexId: convexId, into: localId, generation: generation)
    }
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

    // Compared against what we had observed BEFORE this fetch: a bumped
    // revision means the server's pointer position is newer than anything we
    // produced, so an ancestor head is a remote undo rather than server lag.
    // The wire decodes an absent revision as 0 and v4 normalised local `nil` to
    // 0, so both sides mean the same thing and equality means "already seen".
    let remotePointerIsNewer = remote.pointerRevision > (document.remotePointerRevision ?? 0)

    switch ConflictResolver.resolve(
      localHead: document.localHeadNodeId, remoteHead: remote.currentNodeId,
      nodesById: nodesById, hasPendingWork: hasPendingWork,
      remotePointerIsNewer: remotePointerIsNewer)
    {
    case .inSync:
      try await store.setQueueBlocked(documentLocalId: localId, reason: nil)
      try await store.setSyncState(
        documentLocalId: localId, await settled(hasPendingWork ? .pending : .synced),
        remoteHeadNodeId: remote.currentNodeId, remoteUpdatedAt: remote.updatedAt,
        remotePointerRevision: remote.pointerRevision, divergedRemoteHeadNodeId: .some(nil))

    case .awaitingNodes(let remoteHead):
      // Fetch the missing branch rather than waiting for the subscription to
      // deliver it. A Convex subscription that hit a server error is a completed
      // publisher that never returns (N0a), so a document whose convergence
      // depended on one would simply stop converging.
      guard pullMissingNodes else {
        logger.error(
          "remote head \(remoteHead, privacy: .public) is still unreachable for \(localId, privacy: .public)"
        )
        // An unreachable head is not a decision, and a provisional barrier held
        // on one holds the queue for as long as the branch stays missing.
        try await releaseProvisionalBarrier(localId: localId)
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
        remoteHeadNodeId: remote.currentNodeId, remoteUpdatedAt: remote.updatedAt,
        remotePointerRevision: remote.pointerRevision)
      try await releaseProvisionalBarrier(localId: localId)

    case .adoptRemote(let headNodeId, let whenIdle):
      guard whenIdle else {
        // The user is mid-edit. Record where the server is and adopt once the
        // outbox drains; moving the caret now is plan 022 in a new costume.
        //
        // The pointer revision is deliberately NOT recorded: it is the only
        // thing that tells a deliberate remote undo from server lag, and
        // consuming it here — before the adoption it justifies has happened —
        // makes every later reconciliation read this ancestor as lag.
        try await store.setSyncState(
          documentLocalId: localId, await settled(.pending), remoteHeadNodeId: headNodeId,
          remoteUpdatedAt: remote.updatedAt)
        // The tail has to be able to drain, or the document can never become
        // idle and this adoption never happens.
        try await releaseProvisionalBarrier(localId: localId)
        return
      }
      let markdown = try await store.materializedMarkdown(
        documentLocalId: localId, nodeId: headNodeId)
      // Materializing suspended; a keystroke may have persisted a draft and
      // queued a job in the gap. The adopt is a CAS on the head we observed plus
      // "still no local work", evaluated inside the write transaction.
      let adopted = try await store.adoptRemoteHead(
        documentLocalId: localId,
        observedLocalHeadNodeId: document.localHeadNodeId,
        remoteHeadNodeId: headNodeId,
        markdown: markdown,
        wordCount: Int(remote.wordCount),
        remoteUpdatedAt: remote.updatedAt,
        remotePointerRevision: remote.pointerRevision)
      guard adopted else {
        // The CAS lost: a keystroke landed while the target was materializing.
        // Nothing was adopted, so the ordering signal is still unspent.
        try await store.setSyncState(
          documentLocalId: localId, await settled(.pending), remoteHeadNodeId: headNodeId,
          remoteUpdatedAt: remote.updatedAt)
        try await releaseProvisionalBarrier(localId: localId)
        return
      }
      try await store.setQueueBlocked(documentLocalId: localId, reason: nil)
      emit(.documentChanged(localId: localId))
      emit(.syncStateChanged(localId: localId, state: .synced))

    case .diverged(let local, let remoteHead):
      // Both branches stay in the DAG. The UI offers keep local / keep remote /
      // edit merged; resolving it here would silently pick a winner.
      try await store.setSyncState(
        documentLocalId: localId, .diverged, remoteHeadNodeId: remoteHead,
        remoteUpdatedAt: remote.updatedAt, remotePointerRevision: remote.pointerRevision,
        divergedRemoteHeadNodeId: remoteHead)
      // The barrier is written by `setSyncState(.diverged)` in the same
      // transaction as the divergence itself.
      emit(.diverged(localId: localId, local: local, remote: remoteHead))
      emit(.syncStateChanged(localId: localId, state: .diverged))
    }
  }

  /// Drop a barrier this reconciliation now owns.
  ///
  /// Only a PROVISIONAL reason (`QueueBlockReason.isProvisional`) is released,
  /// and only if it is still the reason on the row: a divergence, a removal and
  /// an in-flight resolution all wait for something other than this pass.
  private func releaseProvisionalBarrier(localId: String) async throws {
    guard let raw = try await store.document(localId: localId)?.queueBlockedReason,
      QueueBlockReason(rawValue: raw)?.isProvisional == true
    else { return }
    logger.info(
      "releasing the \(raw, privacy: .public) barrier on \(localId, privacy: .public) after reconciling"
    )
    try await store.setQueueBlocked(documentLocalId: localId, reason: nil)
    requestDrain()
  }

  /// Reconcile documents left holding a provisional barrier.
  ///
  /// The barrier and the job's deletion commit together, and the reconciliation
  /// that owns the barrier runs afterwards. A crash in that window leaves a
  /// barrier nobody will ever clear — `drainPass` skips blocked documents, so
  /// nothing else would look at it again. `start()` calls this; the app can too,
  /// after a forced relaunch.
  public func reconcileAbandonedBarriers() async {
    await reconcileAbandonedBarriers(generation: lifecycle)
  }

  private func reconcileAbandonedBarriers(generation: Int) async {
    guard
      let blocked = try? await store.documentsBlocked(byReasons: QueueBlockReason.provisional),
      !blocked.isEmpty
    else { return }
    for localId in blocked {
      guard isCurrent(generation) else { return }
      logger.info(
        "reconciling \(localId, privacy: .public), left blocked by an unfinished transition")
      do {
        try await reconcileHead(localId: localId)
      } catch {
        storeFailed(error, while: "reconciling the abandoned barrier on \(localId)")
      }
    }
  }

  // MARK: - Outbox drain

  /// Ask for a drain. Coalesced: a burst of keystrokes produces one pass.
  public func requestDrain() {
    drainRequested = true
    guard isRunning else { return }
    _ = ensureDrainTask()
  }

  private func ensureDrainTask() -> Task<Void, Never> {
    if let existing = drainTask { return existing }
    let task = Task { [weak self] in
      guard let self else { return }
      await self.drainLoop()
    }
    drainTask = task
    return task
  }

  /// Drain everything and return when the queue is empty or stuck. Joins the
  /// running drain instead of starting another. Used by `DocumentSession.flush()`
  /// and by the tests.
  public func drainNow() async {
    drainRequested = true
    await ensureDrainTask().value
  }

  private func drainLoop() async {
    defer {
      drainTask = nil
      scheduleBackoffWake()
    }
    while drainRequested {
      drainRequested = false
      if Task.isCancelled { return }
      await drainPass()
    }
  }

  /// Round-robin: at most one eligible head job per document per pass, repeated
  /// while any document made progress. A document under continuous editing would
  /// otherwise keep the loop inside one document and starve every document behind
  /// it. FIFO is preserved within a document because only its head is ever sent.
  private func drainPass() async {
    // Documents touched this pass. Their sync state is settled at the end: the
    // loop stops as soon as the queue is empty, so a document whose LAST job
    // just succeeded would otherwise never be re-examined and would sit on
    // `syncing` forever.
    var touched: Set<String> = []
    while true {
      if Task.isCancelled { return }
      let documents: [String]
      do {
        documents = try await store.documentsWithPendingJobs()
      } catch {
        storeFailed(error, while: "listing documents with queued work")
        return
      }
      guard !documents.isEmpty else { break }

      var progressed = false
      // `documentsWithPendingJobs` already excludes blocked documents in SQL, so
      // the barrier survives a stop, a relaunch and a new lifecycle.
      for localId in documents {
        if Task.isCancelled { return }
        touched.insert(localId)
        if await drainOneJob(localId: localId) { progressed = true }
      }
      guard progressed else { break }
    }

    for localId in touched {
      if Task.isCancelled { return }
      await settleWhenQueueIsEmpty(localId: localId)
    }
  }

  /// Wake once when the earliest backed-off job becomes eligible.
  ///
  /// Retry-until-acknowledged has to survive a relaunch: the in-memory retry task
  /// dies with the process and `nextJob` refuses a future `nextAttemptAt`, so
  /// without this a queue that failed before a quit would sit there until some
  /// unrelated edit happened to request a drain.
  private func scheduleBackoffWake() {
    backoffWake?.cancel()
    backoffWake = nil
    guard isRunning else { return }
    Task { [weak self] in await self?.armBackoffWake() }
  }

  /// How many wakes have actually been armed. A spin shows up here as an
  /// unbounded count where the design allows at most one per backed-off head.
  private(set) var armedBackoffWakes = 0

  private func armBackoffWake() async {
    guard isRunning, backoffWake == nil else { return }
    guard let earliest = (try? await store.earliestNextAttempt()) ?? nil else { return }
    let delay = max((earliest - Date().timeIntervalSince1970 * 1000) / 1000, 0)
    armedBackoffWakes += 1
    backoffWake = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      await self?.clearBackoffWake()
    }
  }

  private func clearBackoffWake() {
    backoffWake = nil
    requestDrain()
  }

  /// A local-store failure during a drain is not "nothing to send" — it means the
  /// mirror is unreadable, and sync would otherwise sit silently idle forever.
  /// True when this task still belongs to the current lifecycle. Checked after
  /// every external await and before every store write.
  private func isCurrent(_ generation: Int) -> Bool { generation == lifecycle }

  private func storeFailed(_ error: any Error, while action: String) {
    logger.error(
      "local store failed while \(action, privacy: .public): \(error.localizedDescription, privacy: .public)"
    )
  }

  private enum JobOutcome {
    /// Delete the job and continue with the next one.
    case completed
    /// Delete the job AND hold this document's queue until a conflict is
    /// resolved or a reconciliation releases it. Everything behind the job
    /// belongs to the branch under dispute; sending it would push the server
    /// back to the branch the user is still deciding about.
    /// `reconcile` runs AFTER the job is gone and the barrier is written. The
    /// queue has to be empty for `reconcileHead` to adopt rather than defer, and
    /// while the job is still queued it counts as pending work.
    case completedAndBlock(reason: QueueBlockReason, reconcile: Bool = false)
    /// Keep the job and try it again after a backoff. NOT a failure: the server
    /// answered, it simply wrote nothing, and the next attempt carries the
    /// baseline this one just learned.
    case retryAfterBackoff(reason: String)
    /// The server refused this commit's parent. The node landed anyway, so the
    /// two heads are branches the user has to choose between: one transaction
    /// records the synced node, the deletion, the remote head, the revision and
    /// a DURABLE divergence barrier.
    case divergedCommit(nodeId: String, remoteHeadNodeId: String, remotePointerRevision: Double?)
    /// Leave the job queued and stop.
    case stop
  }

  /// Send this document's queue in order, stopping at the first job that cannot
  /// complete. Retry-until-acknowledged: the head of the queue is re-sent with
  /// the same `clientMutationId` until the server answers, because the server
  /// remembers exactly one and a pipelined replay would be answered `diverged`.
  /// Send at most ONE eligible head job for this document. Returns true when the
  /// queue moved, so the round-robin pass knows whether to go again.
  ///
  /// Retry-until-acknowledged: the head of the queue is re-sent with the same
  /// `clientMutationId` until the server answers, because the server remembers
  /// exactly one and a pipelined replay would be answered `diverged`.
  @discardableResult
  func drainOneJob(localId: String) async -> Bool {
    let generation = lifecycle
    let job: OutboxJob?
    let document: DocumentRecord?
    do {
      job = try await store.nextJob(documentLocalId: localId)
      document = try await store.document(localId: localId)
    } catch {
      storeFailed(error, while: "reading the queue for \(localId)")
      return false
    }
    guard isCurrent(generation) else { return false }
    guard let job, let jobId = job.id else { return false }

    guard let document else {
      // The row is gone: a queued delete already did its work and anything else
      // is moot.
      try? await store.completeJob(id: jobId)
      return true
    }

    // A row that cannot be decoded, or that is missing a field its kind needs,
    // is NOT sent with guessed defaults: an empty `nodeId` and `patch` pass the
    // server's validators and can move `currentNodeId` to "". It is parked.
    let payload: OutboxPayload
    do {
      payload = try OutboxPayload.decode(job.payload)
      try payload.validate(for: job.kind, baseHeadNodeId: job.baseHeadNodeId)
    } catch {
      await parkUnsendableJob(job: job, jobId: jobId, reason: String(describing: error))
      return false
    }

    do {
      let outcome = try await send(job, payload: payload, document: document)
      guard isCurrent(generation) else { return false }
      switch outcome {
      case .completed:
        try await store.completeJob(id: jobId)
        return true
      case .completedAndBlock(let reason, let reconcile):
        // One transaction: the job goes and the barrier lands together.
        try await store.completeJobAndBlockQueue(
          id: jobId, documentLocalId: localId, reason: reason.rawValue)
        if reconcile { try await reconcileHead(localId: localId) }
        return true
      case .divergedCommit(let nodeId, let remoteHeadNodeId, let remotePointerRevision):
        try await store.recordCommitDivergence(
          documentLocalId: localId, jobId: jobId, syncedNodeId: nodeId,
          remoteHeadNodeId: remoteHeadNodeId, remotePointerRevision: remotePointerRevision)
        emit(
          .diverged(
            localId: localId, local: document.localHeadNodeId, remote: remoteHeadNodeId))
        emit(.syncStateChanged(localId: localId, state: .diverged))
        return true
      case .retryAfterBackoff(let reason):
        let delay = outboxBackoff(attempts: job.attempts + 1)
        logger.info(
          "outbox job \(jobId) will be retried in \(delay)s: \(reason, privacy: .public)")
        try await store.deferJob(id: jobId, retryAfter: delay)
        scheduleRetry(jobId: jobId, after: delay)
        return false
      case .stop:
        return false
      }
    } catch {
      guard isCurrent(generation) else { return false }
      await handleSendFailure(job: job, jobId: jobId, error: error)
      return false
    }
  }

  /// Park a job that can never succeed.
  ///
  /// Deleting it would destroy work; retrying it forever would block everything
  /// behind it. It goes into a terminal failed state with the reason recorded,
  /// and the UI is told so it can offer an export.
  private func parkUnsendableJob(job: OutboxJob, jobId: Int64, reason: String) async {
    logger.error(
      "outbox job \(jobId) is unsendable and has been parked: \(reason, privacy: .public)")
    try? await store.parkJob(id: jobId, reason: reason)
    try? await store.setSyncState(documentLocalId: job.documentLocalId, .failed)
    emit(.jobUnsendable(localId: job.documentLocalId, reason: reason))
    emit(.syncStateChanged(localId: job.documentLocalId, state: .failed))
  }

  /// Release a document whose conflict has been resolved (or which reconciled
  /// back to a non-diverged state).
  public func releaseDocument(localId: String) async {
    try? await store.setQueueBlocked(documentLocalId: localId, reason: nil)
  }

  /// Hold this document's queue and wait for any in-flight send to finish.
  ///
  /// A queue rewrite must not race the row currently being sent: the send would
  /// come back and delete a row the rewrite had already replaced. Returns
  /// whether the caller should release the block afterwards — a document that was
  /// already blocked by a divergence stays blocked until it is resolved.
  ///
  /// Not a `with…` closure on purpose: the work happens on the session actor, and
  /// handing an actor-isolated closure to this actor is not something Swift 6
  /// will let us do safely.
  @discardableResult
  public func beginExclusiveQueue(localId: String) async -> Bool {
    let wasBlocked =
      ((try? await store.document(localId: localId))?.queueBlockedReason) != nil
    try? await store.setQueueBlocked(documentLocalId: localId, reason: "resolving")
    // One owned drain task, so awaiting it is enough to know nothing is in
    // flight for any document.
    await drainTask?.value
    return !wasBlocked
  }

  public func endExclusiveQueue(localId: String, release: Bool) async {
    guard release else { return }
    try? await store.setQueueBlocked(documentLocalId: localId, reason: nil)
  }

  /// The queue for this document drained. Reconcile BEFORE claiming `synced`: an
  /// adoption deferred earlier because work was pending has nothing else that
  /// would ever retry it, so the remote head could stay unapplied indefinitely.
  private func settleWhenQueueIsEmpty(localId: String) async {
    do {
      guard let document = try await store.document(localId: localId),
        document.syncState == .pending || document.syncState == .syncing,
        try await store.pendingJobs(documentLocalId: localId).isEmpty
      else { return }
      try await reconcileHead(localId: localId)

      guard let settled = try await store.document(localId: localId),
        settled.syncState == .pending || settled.syncState == .syncing,
        try await store.pendingJobs(documentLocalId: localId).isEmpty,
        // Only once the heads actually agree. A rejected pointer move leaves them
        // apart, and calling that "synced" is the lie the badge exists to avoid.
        settled.remoteHeadNodeId == nil || settled.remoteHeadNodeId == settled.localHeadNodeId
      else { return }
      try await store.setSyncState(documentLocalId: localId, .synced)
      emit(.syncStateChanged(localId: localId, state: .synced))
    } catch {
      storeFailed(error, while: "settling the sync state for \(localId)")
    }
  }

  private func send(_ job: OutboxJob, payload: OutboxPayload, document: DocumentRecord)
    async throws -> JobOutcome
  {
    switch job.kind {
    case .createDocument:
      // A retry that already has a Convex id finishes the adoption rather than
      // asking the server again. If the first answer was lost before this id was
      // stored, `document.localId` is the stable server idempotency key.
      if let convexId = document.convexId {
        try await finishCreate(
          document: document, convexId: convexId,
          serverRootNodeId: document.remoteHeadNodeId ?? document.localHeadNodeId)
        return .completed
      }
      let response = try await transport.createDocument(
        title: payload.title ?? document.title,
        documentUuid: document.localId)
      try await finishCreate(
        document: document, convexId: response.documentId,
        serverRootNodeId: response.rootNodeId)
      return .completed

    case .commitEdit:
      guard let convexId = document.convexId else { return .stop }
      let request = commitRequest(convexId: convexId, job: job, payload: payload, document: document)

      switch try await transport.commitEdit(request).outcome {
      case .committed(let headNodeId, let updatedAt, let pointerRevision):
        try await store.markNodesSynced(
          documentLocalId: document.localId, nodeIds: [request.nodeId])
        try await store.setSyncState(
          documentLocalId: document.localId, .syncing, remoteHeadNodeId: headNodeId,
          remoteUpdatedAt: updatedAt, remotePointerRevision: pointerRevision,
          divergedRemoteHeadNodeId: .some(nil))
        return .completed

      case .diverged(let remoteHeadNodeId, let remotePointerRevision):
        // The ancestry has to be local before anything is decided, and pulling
        // it is safe with the job still queued.
        try await pullRemoteNodes(document: document)
        guard !remoteHeadNodeId.isEmpty, remoteHeadNodeId != document.localHeadNodeId else {
          // The server's head is where we already are — nothing is contended.
          // `markNodesSynced` still has to happen: the node did land.
          try await store.markNodesSynced(
            documentLocalId: document.localId, nodeIds: [request.nodeId])
          try await store.setSyncState(
            documentLocalId: document.localId, document.syncState,
            remotePointerRevision: remotePointerRevision)
          return .completedAndBlock(reason: .commitRejected, reconcile: true)
        }
        // A DURABLE divergence, decided here rather than by the generic
        // reconciliation. `commitEdit` inserts the node whatever the head check
        // says and does not move the pointer, so what the server is telling us
        // is "your branch and mine are both real". Handing that to the ancestry
        // rules instead reads a remote head that happens to sit ABOVE ours as
        // "the server has not seen our nodes yet", releases the barrier, and
        // strands the committed node with a `pending` badge and no resolver.
        return .divergedCommit(
          nodeId: request.nodeId, remoteHeadNodeId: remoteHeadNodeId,
          remotePointerRevision: remotePointerRevision)
      }

    case .appendNode:
      // A commit whose branch lost a divergence: keep the text, leave the
      // pointer alone. `docNodes.append` is idempotent on (documentId, nodeId).
      guard let convexId = document.convexId else { return .stop }
      let request = commitRequest(convexId: convexId, job: job, payload: payload, document: document)
      try await transport.appendNode(documentId: convexId, node: request)
      try await store.markNodesSynced(
        documentLocalId: document.localId, nodeIds: [request.nodeId])
      return .completed

    case .pointerMove:
      guard let convexId = document.convexId, let nodeId = payload.nodeId else { return .completed }
      // The EVENT time, not now(): a retry of an old offline undo must not win
      // the server's last-write-wins check against a newer pointer move.
      let response = try await transport.updateCurrentNodeId(
        documentId: convexId, currentNodeId: nodeId,
        markdown: payload.markdown ?? "",
        wordCount: payload.wordCount ?? 0,
        updatedAt: payload.createdAt ?? job.createdAt,
        // Read at DRAIN time, not captured when the job was enqueued: earlier
        // jobs in this document's FIFO queue legitimately bump the revision, and
        // sending the enqueue-time value would make our own commit reject our
        // own undo.
        expectedPointerRevision: document.remotePointerRevision ?? 0,
        title: payload.title)
      guard response.applied else {
        // Deliberately do NOT record the response's revision here. `reconcileHead`
        // compares the freshly fetched revision against the one still on the
        // row; storing it first turns "newer" into "equal" and a remote undo
        // reads as server lag.
        // The head that won is in the response. Acknowledging without looking
        // would leave local and remote heads apart under a `synced` badge.
        logger.info(
          "pointer move rejected for \(document.localId, privacy: .public); server head is \(response.currentNodeId, privacy: .public)"
        )
        return .completedAndBlock(reason: .pointerMoveRejected, reconcile: true)
      }
      try await store.setSyncState(
        documentLocalId: document.localId, document.syncState,
        remoteHeadNodeId: response.currentNodeId, remoteUpdatedAt: response.updatedAt,
        remotePointerRevision: response.pointerRevision)
      return .completed

    case .draftSave:
      guard let convexId = document.convexId else { return .stop }
      let response = try await transport.updateMarkdown(
        documentId: convexId, markdown: payload.markdown ?? document.displayMarkdown,
        wordCount: payload.wordCount ?? document.wordCount,
        expectedUpdatedAt: document.remoteUpdatedAt ?? document.updatedAt,
        expectedHeadNodeId: job.baseHeadNodeId,
        title: payload.title)
      // The refreshed baseline goes in either way — it is what the next CAS
      // uses — but it is not an acknowledgement of the text.
      try await store.setSyncState(
        documentLocalId: document.localId, document.syncState,
        remoteUpdatedAt: response.updatedAt)
      guard !response.headMoved else {
        // This draft belongs to a branch that is no longer the head. Writing it
        // would leave `documents.markdown` detached from `currentNodeId`, and
        // retrying would do it again — so drop it and reconcile. No text is
        // lost: the draft row stays local and the next commit carries it.
        return .completedAndBlock(reason: .draftHeadMoved, reconcile: true)
      }
      guard !response.stale else {
        // `stale` with the head unmoved means the server wrote NOTHING: some
        // other write bumped `updatedAt` and this CAS lost. Deleting the job
        // here was treating "rejected" as "accepted", and the queue could then
        // settle to `synced` with the final draft existing only in SQLite.
        return .retryAfterBackoff(reason: "draft CAS lost; baseline refreshed")
      }
      try await store.acknowledgeEditorIngress(
        documentLocalId: document.localId,
        markdown: payload.markdown ?? document.displayMarkdown,
        title: payload.title)
      return .completed

    case .rename:
      guard let convexId = document.convexId else { return .stop }
      try await transport.rename(documentId: convexId, title: payload.title ?? document.title)
      return .completed

    case .remove:
      guard let convexId = document.convexId else { return .completed }
      do {
        try await transport.remove(documentId: convexId)
      } catch let refusal as ServerRefusal where refusal.code == .notFound {
        // A delete response can be lost after the server commits. Replaying it
        // then returns not_found, which proves the requested final state.
      }
      try await store.deleteDocumentRow(localId: document.localId)
      return .completedAndBlock(reason: .removed)

    case .writingStats:
      guard let date = payload.date, let words = payload.words else { return .completed }
      try await transport.recordWritingStat(date: date, words: words)
      try await store.markWritingStatsClean(dates: [date])
      return .completed
    }
  }

  private func commitRequest(
    convexId: String, job: OutboxJob, payload: OutboxPayload, document: DocumentRecord
  ) -> CommitEditRequest {
    CommitEditRequest(
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
      title: payload.title,
      // Validated before we got here: a commit whose base head we had to guess
      // is a commit onto the wrong parent.
      expectedHeadNodeId: job.baseHeadNodeId ?? "",
      clientMutationId: job.clientMutationId)
  }

  /// Everything an accepted `documents.create` implies, in one store
  /// transaction, including rewriting the parent inside every queued commit's
  /// encoded payload.
  private func finishCreate(
    document: DocumentRecord, convexId: String, serverRootNodeId: String
  ) async throws {
    try await store.finishOfflineCreate(
      documentLocalId: document.localId, convexId: convexId,
      serverRootNodeId: serverRootNodeId,
      rewritePayloadNodeIds: { raw, oldRoot, newRoot in
        // EVERY node-id reference, not just the parent: a queued pointer move
        // targets `nodeId`, and the server does not check that a pointer target
        // exists, so sending the deleted local root silently corrupts the head.
        guard var payload = try? OutboxPayload.decode(raw) else { return raw }
        var changed = false
        if payload.parentNodeId == oldRoot {
          payload.parentNodeId = newRoot
          changed = true
        }
        if payload.nodeId == oldRoot {
          payload.nodeId = newRoot
          changed = true
        }
        return changed ? payload.encoded : raw
      })
  }

  /// Pull whatever the other client wrote. "Is their head above mine or beside
  /// it?" cannot be answered without their nodes, and guessing loses a branch.
  private func pullRemoteNodes(document: DocumentRecord) async throws {
    guard let convexId = document.convexId else { return }
    let remoteNodes = try await transport.listNodes(documentId: convexId, sinceCreatedAt: nil)
    try await store.mergeRemoteNodes(
      documentLocalId: document.localId,
      nodes: remoteNodes.map { $0.record(documentLocalId: document.localId) })
  }

  private func handleSendFailure(job: OutboxJob, jobId: Int64, error: any Error) async {
    let attempts = job.attempts + 1
    let description = String(describing: error)
    let refusal = error as? ServerRefusal

    // A refusal the server decides deterministically will be decided the same
    // way forever. Retrying it blocks everything behind it in this document's
    // queue; deleting it would destroy the text. It is parked, with the reason.
    if let refusal, refusal.isTerminal {
      await parkUnsendableJob(
        job: job, jobId: jobId, reason: "\(refusal.code.rawValue): \(refusal.message)")
      return
    }

    // A Clerk token lives 60 seconds and can expire between two jobs of a long
    // drain. Force a re-auth before backing off, or the retry fails identically.
    // The CODE is the authority; the substring match is the fallback for plain
    // errors, which carry no structured data at all.
    if refusal?.code == .unauthenticated
      || (refusal == nil
        && (description.localizedCaseInsensitiveContains("unauthenticated")
          || description.localizedCaseInsensitiveContains("auth")))
    {
      // Sockets down first: this is the one path that replaces the bridge.
      await reauthenticateQuiesced()
    }

    let delay = outboxBackoff(attempts: attempts)
    try? await store.failJob(id: jobId, error: description, retryAfter: delay)
    try? await store.setSyncState(
        documentLocalId: job.documentLocalId, .failed)
    emit(.syncStateChanged(localId: job.documentLocalId, state: .failed))
    logger.error("outbox job \(jobId) failed (attempt \(attempts)): \(description, privacy: .public)")

    // Wake the loop when the backoff elapses instead of waiting for a keystroke.
    scheduleRetry(jobId: jobId, after: delay)
  }

  private func scheduleRetry(jobId: Int64, after delay: Double) {
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
