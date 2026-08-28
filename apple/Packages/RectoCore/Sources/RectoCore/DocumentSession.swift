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
/// One instance per document per process — see `DocumentSessionRegistry`; two
/// Mac windows on the same document share this actor, which is what makes the
/// orchestrator's "same document in two windows" decision safe.
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

  /// How many windows currently hold this session.
  var holderCount: Int { openCount }

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
    openCount += 1
    guard controller == nil else { return }

    try await reload()
    guard let document else { throw SessionError.documentMissing(documentLocalId) }

    let markdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: document.localHeadNodeId)
    controller = GroupingController(
      rootNodeId: document.localHeadNodeId,
      rootMarkdown: markdown,
      // Resume the snapshot cadence where the branch left it, so a relaunch does
      // not restart the every-50 counter and unbound the replay length.
      depthSinceSnapshot: depthSinceSnapshot(document.localHeadNodeId, nodesById))

    if let sync {
      await sync.openDocument(localId: documentLocalId)
      eventTask = Task { [weak self] in
        for await event in await sync.events {
          guard let self else { break }
          await self.handle(event)
        }
      }
    }
    publish()
  }

  /// Release one holder. The session shuts down when the last window closes,
  /// after flushing.
  public func close() async {
    openCount = max(openCount - 1, 0)
    guard openCount == 0 else { return }
    try? await flush()
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
    guard controller != nil, let document else { throw SessionError.notOpen }
    let timestamp = now()
    let commits = controller!.record(
      markdown: markdown, selection: selection, structural: structural, now: timestamp)

    var head = document.localHeadNodeId
    for commit in commits {
      head = try await persist(commit, base: head, at: timestamp)
    }

    try await reload()
    scheduleIdleCommit()
    scheduleDraftSave(markdown: markdown, selection: selection)
    publish()
    if !commits.isEmpty { await sync?.requestDrain() }
  }

  /// The idle boundary elapsed (500 ms since the last keystroke).
  public func tickIdle() async throws {
    guard controller != nil, let document else { return }
    guard let commit = controller!.tick() else { return }
    _ = try await persist(commit, base: document.localHeadNodeId, at: now())
    try await reload()
    publish()
    await sync?.requestDrain()
  }

  /// Force-commit the pending draft and push the queue. Called on background,
  /// window close, scene disconnect and mode switch.
  public func flush() async throws {
    idleTask?.cancel()
    idleTask = nil
    draftTask?.cancel()
    draftTask = nil

    if controller != nil, let document, let commit = controller!.flush() {
      _ = try await persist(commit, base: document.localHeadNodeId, at: now())
      try await reload()
      publish()
    }
    await sync?.requestDrain()
  }

  private func persist(_ commit: GroupCommit, base: String, at timestamp: Double) async throws
    -> String
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

    _ = try await store.commit(
      documentLocalId: documentLocalId, node: node, markdown: commit.markdown, wordCount: words,
      expectedHeadNodeId: base, job: job, now: timestamp)
    return commit.nodeId
  }

  // MARK: - Navigation

  /// Move to the parent node. Returns false at the root.
  @discardableResult
  public func undo() async throws -> Bool {
    try await flush()
    guard let document, let parent = nodesById[document.localHeadNodeId]?.parentNodeId,
      nodesById[parent] != nil
    else { return false }
    try await navigate(to: parent)
    return true
  }

  /// Move to the most recently created child — vim's behaviour, and the web's.
  @discardableResult
  public func redo() async throws -> Bool {
    try await flush()
    guard let document, let target = children(of: document.localHeadNodeId).last else {
      return false
    }
    try await navigate(to: target)
    return true
  }

  /// Jump anywhere in the DAG. A pointer move: it never grows the tree.
  public func navigate(to nodeId: String) async throws {
    guard controller != nil, nodesById[nodeId] != nil else { return }
    // Commit any pending draft first, so we branch from a real node rather than
    // mid-edit text that would be lost.
    if let document, let commit = controller!.flush() {
      _ = try await persist(commit, base: document.localHeadNodeId, at: now())
      try await reload()
    }

    let markdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: nodeId)
    let words = countWords(markdown)
    let timestamp = now()
    let job = OutboxJob(
      documentLocalId: documentLocalId,
      kind: .pointerMove,
      clientMutationId: ulid(),
      baseHeadNodeId: nodeId,
      payload: OutboxPayload(nodeId: nodeId, markdown: markdown, wordCount: words).encoded,
      createdAt: timestamp)

    _ = try await store.moveHead(
      documentLocalId: documentLocalId, to: nodeId, markdown: markdown, wordCount: words,
      job: job, now: timestamp)
    controller!.setCurrent(
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

  /// Keep the local branch: re-commit the local head's text onto the remote head
  /// so the server's pointer catches up. Both branches stay in the DAG.
  public func resolveDivergenceKeepingLocal() async throws {
    // The divergence is written by the sync engine on its own actor; the
    // session hears about it through an event that may not have arrived yet.
    try await reload()
    guard let document, let remoteHead = document.divergedRemoteHeadNodeId,
      nodesById[remoteHead] != nil
    else { return }
    let localMarkdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: document.localHeadNodeId)
    let remoteMarkdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: remoteHead)

    controller?.setCurrent(
      nodeId: remoteHead, markdown: remoteMarkdown,
      depthSinceSnapshot: depthSinceSnapshot(remoteHead, nodesById))
    try await store.setSyncState(
      documentLocalId: documentLocalId, .pending, divergedRemoteHeadNodeId: .some(nil))
    _ = try await store.moveHead(
      documentLocalId: documentLocalId, to: remoteHead, markdown: remoteMarkdown,
      wordCount: countWords(remoteMarkdown), job: nil, clearDivergence: true, now: now())
    try await reload()
    // Re-applying the local text as a new child of the remote head is exactly a
    // structural edit: one node, parented where the server is.
    try await applyLocalChange(markdown: localMarkdown, selection: nil, structural: true)
  }

  /// Take the server's branch. The local branch stays reachable in the history
  /// panel — nothing is deleted.
  public func resolveDivergenceKeepingRemote() async throws {
    try await reload()
    guard let document, let remoteHead = document.divergedRemoteHeadNodeId,
      nodesById[remoteHead] != nil
    else { return }
    let markdown = try await store.materializedMarkdown(
      documentLocalId: documentLocalId, nodeId: remoteHead)
    _ = try await store.moveHead(
      documentLocalId: documentLocalId, to: remoteHead, markdown: markdown,
      wordCount: countWords(markdown), job: nil, clearDivergence: true, now: now())
    controller?.setCurrent(
      nodeId: remoteHead, markdown: markdown,
      depthSinceSnapshot: depthSinceSnapshot(remoteHead, nodesById))
    try await reload()
    publish()
  }

  // MARK: - Private

  private func handle(_ event: SyncEvent) async {
    switch event {
    case .documentChanged(let localId), .syncStateChanged(let localId, _):
      guard localId == documentLocalId else { return }
    case .diverged(let localId, _, _):
      guard localId == documentLocalId else { return }
    case .libraryChanged:
      return
    }
    try? await reload()
    // A remote head adoption re-materialized the head under us; the controller
    // has to be repositioned or the next commit would patch against stale text.
    if let document, controller?.currentNodeId != document.localHeadNodeId,
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

  private func scheduleIdleCommit() {
    guard schedulesTimers, let deadline = controller?.idleDeadline else { return }
    idleTask?.cancel()
    let delay = max(deadline - now(), 0)
    idleTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(delay)))
      guard !Task.isCancelled else { return }
      try? await self?.tickIdle()
    }
  }

  private func scheduleDraftSave(markdown: String, selection: NodeSelection?) {
    guard schedulesTimers else { return }
    draftTask?.cancel()
    draftTask = Task { [weak self] in
      try? await Task.sleep(for: Self.draftDebounce)
      guard !Task.isCancelled else { return }
      await self?.writeDraft(markdown: markdown, selection: selection)
    }
  }

  /// The debounced draft row plus the server-side draft save.
  func writeDraft(markdown: String, selection: NodeSelection?) async {
    guard let document else { return }
    let words = countWords(markdown)
    let job = OutboxJob(
      documentLocalId: documentLocalId,
      kind: .draftSave,
      clientMutationId: ulid(),
      baseHeadNodeId: document.localHeadNodeId,
      payload: OutboxPayload(markdown: markdown, wordCount: words).encoded,
      createdAt: now())
    try? await store.saveDraft(
      documentLocalId: documentLocalId, markdown: markdown, selection: selection,
      wordCount: words, job: job, now: now())
    try? await reload()
    publish()
    await sync?.requestDrain()
  }
}
