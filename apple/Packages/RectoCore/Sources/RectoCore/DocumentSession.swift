import Foundation
import OSLog
import RectoHistory
import RectoStore
import RectoSync

/// What the editor and the UI read.
public struct DocumentState: Sendable, Equatable {
  public var localId: String
  public var convexId: String?
  public var title: String
  /// The text the editor should show: the pending draft when there is one,
  /// otherwise the materialized head.
  public var markdown: String
  public var head: String
  public var wordCount: Int
  public var syncState: SyncState
  public var divergence: Divergence?
  public var canUndo: Bool
  public var canRedo: Bool
}

/// Two heads that neither reaches the other. Both stay in the DAG; the UI's
/// compare sheet decides (plan 023 §4.4).
public struct Divergence: Sendable, Equatable {
  public var localHeadNodeId: String
  public var remoteHeadNodeId: String
  /// Nearest common ancestor — the base a three-way compare needs.
  public var baseNodeId: String?
}

public enum SessionError: Error, Equatable, Sendable {
  case notOpen
  case editableHolderExists(String)
  /// The session is frozen while sign-out decides what to do with unsent work.
  case frozen
  /// The mirror this session was reading has been purged by an identity change.
  /// Ask the registry for a new session; this one will never work again.
  case invalidated
  case documentMissing(String)
}

/// Word counting is injected: the canonical counter parses Markdown (it counts
/// prose, not syntax) and that parser is W8's Swift port of `lib/markdown`.
public enum RectoWordCount {
  /// `countWordsFromPlainText` from `lib/markdown/count-words.ts`, exactly.
  /// Over-counts Markdown syntax, so it is a stand-in until W8 lands — never the
  /// long-term answer for a number the server stores.
  public static let plainText: @Sendable (String) -> Int = { text in
    text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
  }
}

/// One open document (plan 023 §4.3, D-N2).
///
/// Owns the grouping controller, writes every commit as one SQLite transaction
/// (node + head + outbox job), and reflects what the sync engine mirrors back.
/// One instance per document per process — see `DocumentSessionRegistry`.
/// Session state can have multiple readers, but the app permits one editable
/// full-snapshot ingress per document.
public actor DocumentSession {
  /// The draft row is written on every change, debounced, so a crash between
  /// keystroke and node boundary loses nothing (plan 023 §4.3).
  public static let draftDebounce: Duration = .milliseconds(250)

  private let logger = Logger(subsystem: "com.bhekani.recto", category: "session")
  private let store: RectoStore
  private let sync: SyncEngine?
  private let origin: String
  private let countWords: @Sendable (String) -> Int
  private let now: @Sendable () -> Double
  private let schedulesTimers: Bool

  public let documentLocalId: String

  private var controller: GroupingController?
  private var document: DocumentRecord?
  private var nodesById: [String: DocNode] = [:]
  private var stateContinuations: [UUID: AsyncStream<DocumentState>.Continuation] = [:]
  private var idleTask: Task<Void, Never>?
  private var draftTask: Task<Void, Never>?
  private var eventTask: Task<Void, Never>?
  private var openCount = 0
  /// A navigation or divergence resolution is part-way through repositioning the
  /// grouping controller. Actor methods interleave at every `await`, so without
  /// this the sync event handler can re-seed the controller between the head
  /// move and the commit that follows it — and the commit then reads as a
  /// selection-only change and is silently dropped. This is the native shape of
  /// the web's `navigatingRef` guard.
  private var isRepositioning = false
  /// Editing is refused. Set while sign-out decides, so no new text can arrive
  /// between "how much is unsynced?" and the purge that answers it.
  private var isFrozen = false
  /// The mirror this session was reading no longer exists. Terminal.
  private var isInvalidated = false

  /// Tail of the transition queue. Actor isolation does NOT prevent reentrancy:
  /// every `await` is a place another window's keystroke can run a whole edit.
  /// Each state transition awaits its predecessor, so a navigation that suspends
  /// while materializing cannot be overtaken by a commit that then gets stranded.
  private var transitionTail: Task<Void, Never>?

  /// How many windows currently hold this session.
  var holderCount: Int { openCount }

  /// Run `body` only after every transition queued before it has finished.
  ///
  /// `body` is non-escaping, so it runs inline on this actor and can touch the
  /// session's state directly. The queue is a chain of gates: each caller
  /// publishes its own gate as the new tail, waits for the previous one, and
  /// signals on the way out — including when it throws.
  private func withTransition<T>(_ body: () async throws -> T) async rethrows -> T {
    let previous = transitionTail
    let gate = TransitionGate()
    transitionTail = Task { await gate.wait() }
    await previous?.value
    defer { gate.signal() }
    return try await body()
  }

  public init(
    documentLocalId: String,
    store: RectoStore,
    sync: SyncEngine?,
    origin: String,
    countWords: @escaping @Sendable (String) -> Int = RectoWordCount.plainText,
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
    schedulesTimers: Bool = true
  ) {
    self.documentLocalId = documentLocalId
    self.store = store
    self.sync = sync
    self.origin = origin
    self.countWords = countWords
    self.now = now
    self.schedulesTimers = schedulesTimers
  }

  deinit {
    idleTask?.cancel()
    draftTask?.cancel()
    eventTask?.cancel()
  }

  // MARK: - Lifecycle

  /// Load the document, seed the grouping controller, and start mirroring.
  /// Idempotent: a second window on the same document just increments the count.
  public func open() async throws {
    try await withTransition { try await performOpen() }
  }

  private func performOpen() async throws {
    // A handle held across an account switch must not be able to reload: the
    // document id belonged to the previous mirror.
    guard !isInvalidated else { throw SessionError.invalidated }
    // Counted only once the open has actually succeeded. Incrementing first and
    // throwing leaves a holder nobody owns, and the next successful open then
    // needs two releases to reach a final close.
    var didCount = false
    defer { if !didCount { openCount = max(openCount - 1, 0) } }
    openCount += 1
    didCount = false

    // Always re-read, even when a window already has this session open. The sync
    // engine writes head moves and divergences from its own actor and this
    // session only learns about them through an event, so a second window that
    // opened between the write and the event would render a stale snapshot.
    try await reload()
    guard controller == nil else {
      didCount = true
      publish()
      return
    }

    guard let document else { throw SessionError.documentMissing(documentLocalId) }

    let markdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: document.localHeadNodeId)
    var restored = GroupingController(
      rootNodeId: document.localHeadNodeId,
      rootMarkdown: markdown,
      // Resume the snapshot cadence where the branch left it, so a relaunch does
      // not restart the every-50 counter and unbound the replay length.
      depthSinceSnapshot: depthSinceSnapshot(document.localHeadNodeId, nodesById))
    // Text that was persisted but never reached a node boundary. Without this the
    // recovery draft is on disk but invisible: the editor would show the head and
    // the user's last sentences would look lost.
    let recoveredIngress = document.editorIngressRevision != nil
    if let draft = document.draftMarkdown {
      restored.restorePendingDraft(
        markdown: draft, selection: document.draftSelection, now: now())
    }
    controller = restored

    // A synchronous editor ingress can survive a kill before its async worker
    // runs. Promote that recovered draft to a node/outbox job during open so a
    // read-only relaunch will still sync it after connectivity returns.
    if recoveredIngress { try await performFlush() }

    if let sync {
      await sync.openDocument(localId: documentLocalId)
      eventTask = Task { [weak self] in
        for await event in await sync.events {
          guard let self else { break }
          await self.handle(event)
        }
      }
    }
    didCount = true
    publish()
  }

  /// Release one holder. The session shuts down when the last window closes,
  /// after flushing.
  public func close() async {
    await withTransition { await performClose() }
  }

  private func performClose() async {
    openCount = max(openCount - 1, 0)
    guard openCount == 0 else { return }
    try? await performFlush()
    // Re-check: a new window can only have arrived before this transition
    // started, but the flush above suspends, and tearing the controller down
    // under a holder that just opened would leave it with a dead session.
    guard openCount == 0 else { return }
    idleTask?.cancel()
    draftTask?.cancel()
    eventTask?.cancel()
    idleTask = nil
    draftTask = nil
    eventTask = nil
    controller = nil
    if let sync { await sync.closeDocument(localId: documentLocalId) }
  }

  public var states: AsyncStream<DocumentState> {
    AsyncStream { continuation in
      let id = UUID()
      stateContinuations[id] = continuation
      if let state = currentState { continuation.yield(state) }
      continuation.onTermination = { [weak self] _ in
        Task { await self?.removeStateContinuation(id) }
      }
    }
  }

  public var currentState: DocumentState? {
    guard let document else { return nil }
    let head = nodesById[document.localHeadNodeId]
    return DocumentState(
      localId: document.localId,
      convexId: document.convexId,
      title: document.title,
      markdown: controller?.draft ?? document.displayMarkdown,
      head: document.localHeadNodeId,
      wordCount: document.wordCount,
      syncState: document.syncState,
      divergence: document.divergedRemoteHeadNodeId.map {
        Divergence(
          localHeadNodeId: document.localHeadNodeId,
          remoteHeadNodeId: $0,
          baseNodeId: ConflictResolver.commonAncestor(
            document.localHeadNodeId, $0, in: nodesById))
      },
      canUndo: head?.parentNodeId != nil || controller?.hasPendingDraft == true,
      canRedo: !children(of: document.localHeadNodeId).isEmpty)
  }

  private func removeStateContinuation(_ id: UUID) { stateContinuations[id] = nil }

  private func publish() {
    guard let state = currentState else { return }
    for continuation in stateContinuations.values { continuation.yield(state) }
  }

  // MARK: - The edit path

  /// Feed a canonical-Markdown change from the editor.
  ///
  /// Grouping decides whether this closes a node. Every produced commit is one
  /// SQLite transaction — node, head and outbox job together — because a crash
  /// between them would leave a document pointing at a node that does not
  /// describe its text (the local shape of plan 022).
  public func applyLocalChange(
    markdown: String, selection: NodeSelection?, structural: Bool = false
  ) async throws {
    try await withTransition {
      try await performLocalChange(
        markdown: markdown, selection: selection, structural: structural,
        persistedGeneration: nil)
    }
  }

  /// Process a snapshot that the synchronous editor callback already wrote.
  /// A newer callback may supersede it while this actor is suspended; the
  /// generation keeps the older snapshot from clearing the newer draft.
  public func applyPersistedLocalChange(
    markdown: String,
    selection: NodeSelection?,
    structural: Bool = false,
    generation: Int
  ) async throws {
    try await withTransition {
      try await performLocalChange(
        markdown: markdown, selection: selection, structural: structural,
        persistedGeneration: generation)
    }
  }

  /// Refuse further edits. Returns once nothing else will write.
  public func freeze() async {
    await withTransition { isFrozen = true }
  }

  public func resume() async {
    await withTransition { isFrozen = false }
  }

  /// Forget everything this session holds about the mirror, permanently.
  ///
  /// An account switch purges SQLite, but a window that was open across it still
  /// has the previous account's title, markdown, grouping controller and node
  /// map in memory, and the next `publish()` hands them to whoever signed in.
  /// The state stream is finished so the window learns its document is gone,
  /// and the session refuses to open again — the registry mints a fresh one for
  /// the new account.
  public func invalidate() async {
    await withTransition {
      isInvalidated = true
      isFrozen = true
      idleTask?.cancel()
      draftTask?.cancel()
      eventTask?.cancel()
      idleTask = nil
      draftTask = nil
      eventTask = nil
      controller = nil
      document = nil
      nodesById = [:]
      openCount = 0
      for continuation in stateContinuations.values { continuation.finish() }
      stateContinuations.removeAll()
      if let sync { await sync.closeDocument(localId: documentLocalId) }
    }
  }

  /// The guard on every user-triggered mutating transition.
  ///
  /// `EditSessionCoordinating.freezeAndFlushAll()` promises that no session
  /// writes after it returns, and sign-out takes its final unsynced count on
  /// that promise. A navigation, an undo, a divergence resolution or a timer
  /// that still moved the head or queued a job in that window was accepted and
  /// then deleted without anyone consenting.
  ///
  /// `flush()` deliberately does NOT check it: the freeze path itself flushes,
  /// and that flush is how the pending draft reaches the count.
  private func requireWritable() throws {
    guard !isInvalidated else { throw SessionError.invalidated }
    guard !isFrozen else { throw SessionError.frozen }
  }

  private func performLocalChange(
    markdown: String,
    selection: NodeSelection?,
    structural: Bool,
    persistedGeneration: Int?
  ) async throws {
    try requireWritable()
    guard controller != nil else { throw SessionError.notOpen }
    let timestamp = now()

    let generation: Int
    if let persistedGeneration {
      let stored = try await store.document(localId: documentLocalId)
      guard stored?.draftRevision == persistedGeneration,
        stored?.displayMarkdown == markdown
      else {
        try await rebuildControllerFromStore()
        publish()
        return
      }
      if stored?.localHeadNodeId != document?.localHeadNodeId {
        try await rebuildControllerFromStore()
      }
      generation = persistedGeneration
    } else {
      // Write-ahead: the text is on disk BEFORE any in-memory state moves. A
      // crash between here and the commit loses nothing.
      generation = try await store.saveDraft(
        documentLocalId: documentLocalId, markdown: markdown, selection: selection,
        wordCount: countWords(markdown), job: nil, now: timestamp)
    }
    guard let document else { throw SessionError.notOpen }

    // Stage the grouping decision in a copy; the live controller is only
    // replaced once every store write for it has succeeded.
    var staged = controller!
    let commits = staged.record(
      markdown: markdown, selection: selection, structural: structural, now: timestamp)

    var expectedGeneration = generation
    do {
      var head = document.localHeadNodeId
      for commit in commits {
        let persisted = try await persist(
          commit, base: head, expectedDraftRevision: expectedGeneration, at: timestamp)
        head = persisted.localHeadNodeId
        expectedGeneration = persisted.draftRevision
      }
      controller = staged
    } catch {
      // Rebuild from what is actually on disk. Keeping the staged controller
      // would name a parent the store does not have.
      logger.error(
        "commit failed for \(self.documentLocalId, privacy: .public): \(error.localizedDescription, privacy: .public)"
      )
      try? await rebuildControllerFromStore()
      publish()
      switch error {
      case StoreError.staleGeneration, StoreError.headMoved, StoreError.parentMismatch:
        return
      default:
        throw error
      }
    }

    try await reload()
    guard self.document?.draftRevision == expectedGeneration else {
      try await rebuildControllerFromStore()
      publish()
      return
    }
    // The revision the write-ahead save produced, or whatever the commits left
    // behind — either way it is the token a later timer must still match.
    scheduleIdleCommit(generation: expectedGeneration)
    scheduleDraftSave(
      markdown: markdown, selection: selection, generation: expectedGeneration)
    publish()
    if !commits.isEmpty { await sync?.requestDrain() }
  }

  /// Re-seed the controller from the persisted head and draft. The store is the
  /// only thing that survives a crash, so it is the only thing worth trusting
  /// after a failed write.
  private func rebuildControllerFromStore() async throws {
    try await reload()
    guard let document else { return }
    let markdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: document.localHeadNodeId)
    var rebuilt = GroupingController(
      rootNodeId: document.localHeadNodeId,
      rootMarkdown: markdown,
      depthSinceSnapshot: depthSinceSnapshot(document.localHeadNodeId, nodesById))
    if let draft = document.draftMarkdown {
      rebuilt.restorePendingDraft(
        markdown: draft, selection: document.draftSelection, now: now())
    }
    controller = rebuilt
  }

  /// The idle boundary elapsed (500 ms since the last keystroke).
  /// `expectedDraftRevision` is the token the scheduling change captured. A timer
  /// that fires after a newer change has already been persisted must not commit
  /// the older text and clear the newer draft row along with it.
  public func tickIdle(expectedDraftRevision: Int? = nil) async throws {
    try await withTransition {
      try requireWritable()
      guard let document else { return }
      if let expectedDraftRevision, document.draftRevision != expectedDraftRevision { return }
      // Staged: the controller only advances once the node is on disk.
      var staged = controller
      guard let commit = staged?.tick() else { return }
      do {
        _ = try await persist(
          commit, base: document.localHeadNodeId,
          expectedDraftRevision: document.draftRevision, at: now())
        controller = staged
      } catch {
        logger.error(
          "idle commit failed for \(self.documentLocalId, privacy: .public): \(error.localizedDescription, privacy: .public)"
        )
        try? await rebuildControllerFromStore()
        return
      }
      try await reload()
      publish()
      await sync?.requestDrain()
    }
  }

  /// Force-commit the pending draft and push the queue. Called on background,
  /// window close, scene disconnect and mode switch.
  public func flush() async throws {
    try await withTransition { try await performFlush() }
  }

  private func performFlush() async throws {
    idleTask?.cancel()
    idleTask = nil
    draftTask?.cancel()
    draftTask = nil

    // Staged, like every other commit path: the controller only advances once
    // the node is on disk.
    var staged = controller
    if let document, let commit = staged?.flush() {
      _ = try await persist(
        commit, base: document.localHeadNodeId,
        expectedDraftRevision: document.draftRevision, at: now())
      controller = staged
      try await reload()
      publish()
    }
    await sync?.requestDrain()
  }

  private func persist(
    _ commit: GroupCommit,
    base: String,
    expectedDraftRevision: Int? = nil,
    at timestamp: Double
  ) async throws -> DocumentRecord
  {
    let words = countWords(commit.markdown)
    let node = DocNodeRecord(
      documentLocalId: documentLocalId,
      nodeId: commit.nodeId,
      parentNodeId: commit.parentNodeId,
      patch: commit.patch,
      snapshot: commit.snapshot,
      selection: commit.selection,
      origin: origin,
      createdAt: timestamp)
    let job = OutboxJob(
      documentLocalId: documentLocalId,
      kind: .commitEdit,
      clientMutationId: ulid(),
      baseHeadNodeId: commit.parentNodeId,
      payload: OutboxPayload.commit(
        commit, origin: origin, createdAt: timestamp, wordCount: words
      ).encoded,
      createdAt: timestamp)

    return try await store.commit(
      documentLocalId: documentLocalId, node: node, markdown: commit.markdown, wordCount: words,
      expectedHeadNodeId: base, expectedDraftRevision: expectedDraftRevision,
      job: job, now: timestamp)
  }

  // MARK: - Navigation

  /// Move to the parent node. Returns false at the root.
  @discardableResult
  public func undo() async throws -> Bool {
    try await withTransition {
      try requireWritable()
      try await performFlush()
      guard let document, let parent = nodesById[document.localHeadNodeId]?.parentNodeId,
        nodesById[parent] != nil
      else { return false }
      try await performNavigate(to: parent)
      return true
    }
  }

  /// Move to the most recently created child — vim's behaviour, and the web's.
  @discardableResult
  public func redo() async throws -> Bool {
    try await withTransition {
      try requireWritable()
      try await performFlush()
      guard let document, let target = children(of: document.localHeadNodeId).last else {
        return false
      }
      try await performNavigate(to: target)
      return true
    }
  }

  /// Jump anywhere in the DAG. A pointer move: it never grows the tree.
  public func navigate(to nodeId: String) async throws {
    try await withTransition {
      try requireWritable()
      try await performNavigate(to: nodeId)
    }
  }

  private func performNavigate(to nodeId: String) async throws {
    guard controller != nil, nodesById[nodeId] != nil else { return }
    isRepositioning = true
    defer { isRepositioning = false }

    // Commit any pending draft first, so we branch from a real node rather than
    // mid-edit text that would be lost.
    if let document, let commit = controller?.flush() {
      _ = try await persist(
        commit, base: document.localHeadNodeId,
        expectedDraftRevision: document.draftRevision, at: now())
      try await reload()
    }
    guard let base = document?.localHeadNodeId else { return }

    let markdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: nodeId)
    let words = countWords(markdown)
    let timestamp = now()
    let job = OutboxJob(
      documentLocalId: documentLocalId,
      kind: .pointerMove,
      clientMutationId: ulid(),
      baseHeadNodeId: nodeId,
      // The event time, so a retry of this move cannot outrank a later one.
      payload: OutboxPayload(
        nodeId: nodeId, createdAt: timestamp, markdown: markdown, wordCount: words
      ).encoded,
      createdAt: timestamp)

    // Materializing suspended. If the head moved in that window the move is
    // stale, and applying it would strand the newer node's queued commit.
    _ = try await store.moveHead(
      documentLocalId: documentLocalId, to: nodeId, markdown: markdown, wordCount: words,
      expectedHeadNodeId: base, job: job, now: timestamp)
    controller?.setCurrent(
      nodeId: nodeId, markdown: markdown,
      depthSinceSnapshot: depthSinceSnapshot(nodeId, nodesById))
    try await reload()
    publish()
    await sync?.requestDrain()
  }

  /// Caret to restore after a navigation, from the node's stored selection.
  public func selection(at nodeId: String) -> NodeSelection? {
    nodesById[nodeId]?.selection
  }

  // MARK: - Divergence

  /// Keep the local branch: re-commit its text as a child of the remote head so
  /// the server's pointer catches up. Both branches stay in the DAG.
  ///
  /// One store transaction, with the queue held: the old branch's commits become
  /// node-only uploads, its drafts and pointer moves are dropped, the remote head
  /// is adopted, and the rebased commit is queued BEHIND those uploads. Leaving
  /// the old jobs in front is what let them replay against the discarded base and
  /// recreate the divergence the user just resolved.
  public func resolveDivergenceKeepingLocal() async throws {
    try await withTransition {
      try requireWritable()
      isRepositioning = true
      defer { isRepositioning = false }
      try await performResolve(keepingLocal: true)
    }
  }

  /// Take the server's branch. The local branch stays reachable in the history
  /// panel — nothing is deleted — but every queued job that would push its
  /// pointer back is rewritten or dropped in the same transaction.
  public func resolveDivergenceKeepingRemote() async throws {
    try await withTransition {
      try requireWritable()
      isRepositioning = true
      defer { isRepositioning = false }
      try await performResolve(keepingLocal: false)
    }
  }

  private func performResolve(keepingLocal: Bool) async throws {
    // The divergence is written by the sync engine on its own actor; the session
    // hears about it through an event that may not have arrived yet.
    try await reload()
    guard let document, let remoteHead = document.divergedRemoteHeadNodeId,
      nodesById[remoteHead] != nil
    else { return }

    // Everything the choice was made against. Materializing suspends, and
    // another client can advance to a different head in that window; applying
    // the stale choice would adopt the wrong branch AND clear a divergence the
    // user never saw.
    let expectation = RectoStore.ResolutionExpectation(
      localHeadNodeId: document.localHeadNodeId,
      divergedRemoteHeadNodeId: remoteHead,
      remotePointerRevision: document.remotePointerRevision)

    let remoteMarkdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: remoteHead)
    let remoteWords = countWords(remoteMarkdown)

    // Hold the queue so the transaction cannot rewrite a row that is in flight.
    let shouldRelease = await sync?.beginExclusiveQueue(localId: documentLocalId) ?? false
    do {
      if keepingLocal {
        let localMarkdown = try await store.materializedMarkdown(
          documentLocalId: documentLocalId, nodeId: document.localHeadNodeId)
        let timestamp = now()
        let nodeId = ulid()
        let patch = computePatch(remoteMarkdown, localMarkdown)
        let node = DocNodeRecord(
          documentLocalId: documentLocalId, nodeId: nodeId, parentNodeId: remoteHead,
          patch: patch.encoded, snapshot: nil, selection: nil, origin: origin,
          createdAt: timestamp)
        let words = countWords(localMarkdown)
        let job = OutboxJob(
          documentLocalId: documentLocalId, kind: .commitEdit, clientMutationId: ulid(),
          baseHeadNodeId: remoteHead,
          payload: OutboxPayload(
            nodeId: nodeId, parentNodeId: remoteHead, patch: patch.encoded, snapshot: nil,
            selection: nil, origin: origin, createdAt: timestamp, markdown: localMarkdown,
            wordCount: words
          ).encoded,
          createdAt: timestamp)

        try await store.resolveKeepingLocal(
          documentLocalId: documentLocalId, expecting: expectation,
          remoteMarkdown: remoteMarkdown, remoteWordCount: remoteWords,
          rebasedNode: node, rebasedMarkdown: localMarkdown, rebasedWordCount: words,
          rebasedJob: job, now: timestamp)
      } else {
        try await store.resolveKeepingRemote(
          documentLocalId: documentLocalId, expecting: expectation,
          markdown: remoteMarkdown, wordCount: remoteWords, now: now())
      }
    } catch {
      await sync?.endExclusiveQueue(localId: documentLocalId, release: shouldRelease)
      throw error
    }
    await sync?.endExclusiveQueue(localId: documentLocalId, release: shouldRelease)

    try await reload()
    if let settled = self.document {
      let markdown = try await store.materializedMarkdown(
        documentLocalId: documentLocalId, nodeId: settled.localHeadNodeId)
      controller?.setCurrent(
        nodeId: settled.localHeadNodeId, markdown: markdown,
        depthSinceSnapshot: depthSinceSnapshot(settled.localHeadNodeId, nodesById))
    }
    await sync?.releaseDocument(localId: documentLocalId)
    publish()
    await sync?.requestDrain()
  }

  // MARK: - Private

  private func handle(_ event: SyncEvent) async {
    await withTransition { await performHandle(event) }
  }

  private func performHandle(_ event: SyncEvent) async {
    switch event {
    case .documentChanged(let localId), .syncStateChanged(let localId, _):
      guard localId == documentLocalId else { return }
    case .diverged(let localId, _, _):
      guard localId == documentLocalId else { return }
    case .libraryChanged, .unsyncedWorkOnRemovedDocument, .jobUnsendable:
      return
    }
    do {
      try await reload()
    } catch {
      logger.error(
        "reload after a sync event failed: \(error.localizedDescription, privacy: .public)")
      return
    }
    // A remote head adoption re-materialized the head under us; the controller
    // has to be repositioned or the next commit would patch against stale text.
    if !isRepositioning, let document, controller?.currentNodeId != document.localHeadNodeId,
      controller?.hasPendingDraft == false
    {
      let markdown = (try? await store.materializedMarkdown(
        documentLocalId: documentLocalId, nodeId: document.localHeadNodeId))
        ?? document.markdown
      controller?.setCurrent(
        nodeId: document.localHeadNodeId, markdown: markdown,
        depthSinceSnapshot: depthSinceSnapshot(document.localHeadNodeId, nodesById))
    }
    publish()
  }

  private func reload() async throws {
    document = try await store.document(localId: documentLocalId)
    nodesById = indexNodes(try await store.nodes(documentLocalId: documentLocalId).map(\.docNode))
  }

  private func children(of nodeId: String) -> [String] {
    nodesById.values
      .filter { $0.parentNodeId == nodeId }
      .sorted { ($0.createdAt, $0.nodeId) < ($1.createdAt, $1.nodeId) }
      .map(\.nodeId)
  }

  private func scheduleIdleCommit(generation: Int) {
    guard schedulesTimers, let deadline = controller?.idleDeadline else { return }
    idleTask?.cancel()
    let delay = max(deadline - now(), 0)
    idleTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(delay)))
      guard !Task.isCancelled else { return }
      try? await self?.tickIdle(expectedDraftRevision: generation)
    }
  }

  private func scheduleDraftSave(
    markdown: String, selection: NodeSelection?, generation: Int
  ) {
    guard schedulesTimers else { return }
    draftTask?.cancel()
    draftTask = Task { [weak self] in
      try? await Task.sleep(for: Self.draftDebounce)
      guard !Task.isCancelled else { return }
      await self?.writeDraft(
        markdown: markdown, selection: selection, expectedDraftRevision: generation)
    }
  }

  /// The debounced draft row plus the server-side draft save.
  ///
  /// `expectedDraftRevision` is the token captured when this was scheduled. The
  /// store refuses the write if the document has moved on, which is what stops a
  /// 250 ms task from writing change A back over change B.
  func writeDraft(
    markdown: String, selection: NodeSelection?, expectedDraftRevision: Int? = nil
  ) async {
    await withTransition {
      await performWriteDraft(
        markdown: markdown, selection: selection, expectedDraftRevision: expectedDraftRevision)
    }
  }

  private func performWriteDraft(
    markdown: String, selection: NodeSelection?, expectedDraftRevision: Int?
  ) async {
    // A debounce that fires after the freeze is still the user's text arriving
    // late. The draft it holds is already on disk from the write-ahead save.
    guard !isFrozen else { return }
    guard let document else { return }
    let words = countWords(markdown)
    let job = OutboxJob(
      documentLocalId: documentLocalId,
      kind: .draftSave,
      clientMutationId: ulid(),
      baseHeadNodeId: document.localHeadNodeId,
      payload: OutboxPayload(markdown: markdown, wordCount: words).encoded,
      createdAt: now())
    do {
      _ = try await store.saveDraft(
        documentLocalId: documentLocalId, markdown: markdown, selection: selection,
        wordCount: words, job: job, expectedDraftRevision: expectedDraftRevision, now: now())
      try await reload()
    } catch StoreError.staleGeneration {
      // A newer change already landed. Dropping this is the point.
      return
    } catch {
      // The draft row is the crash-recovery guarantee; losing it silently is the
      // one failure the user would never be warned about.
      logger.error(
        "draft save failed for \(self.documentLocalId, privacy: .public): \(error.localizedDescription, privacy: .public)"
      )
    }
    publish()
    await sync?.requestDrain()
  }
}

/// An async gate: one waiter, one signal, no ordering assumptions beyond that.
///
/// This is the serialization primitive `withTransition` chains. It cannot be an
/// actor — the whole point is that waiting on it suspends the caller without
/// releasing anything the caller is protecting.
private final class TransitionGate: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?
  private var signalled = false

  func wait() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if signalled {
        lock.unlock()
        continuation.resume()
        return
      }
      self.continuation = continuation
      lock.unlock()
    }
  }

  func signal() {
    lock.lock()
    signalled = true
    let waiter = continuation
    continuation = nil
    lock.unlock()
    waiter?.resume()
  }
}
