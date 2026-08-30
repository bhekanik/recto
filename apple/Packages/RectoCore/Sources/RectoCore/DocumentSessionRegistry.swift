import Foundation
import RectoHistory
import RectoAuth
import RectoStore
import RectoSync

public protocol EditorIngressCoordinating: Sendable {
  func drain() async
  func freezeAndDrain() async
  func resume() async
  func invalidate() async
}

/// One `DocumentSession` per document per process.
///
/// Readers share one actor. Only one editable full-snapshot ingress may exist
/// for a document; independent editors cannot merge stale whole-document text.
public actor DocumentSessionRegistry: EditSessionCoordinating {
  public nonisolated let store: RectoStore
  private let sync: SyncEngine?
  private let origin: String
  private let countWords: @Sendable (String) -> Int
  private let beforeFreezePass: (@Sendable () async -> Void)?
  private let beforeSessionResume: (@Sendable (String) async -> Void)?
  private var sessions: [String: DocumentSession] = [:]
  private var ingresses: [UUID: any EditorIngressCoordinating] = [:]
  private var ingressDocumentIds: [UUID: String] = [:]
  /// Holder counts live here, not behind an await on the session, so
  /// check-and-remove is never split across a suspension.
  private var holders: [String: Int] = [:]
  /// Editing is refused registry-wide while sign-out decides.
  ///
  /// Freezing the sessions that happen to exist is not enough: a window opening
  /// after the freeze got an unfrozen session and could write between the final
  /// unsynced count and the purge. The flag is set before the first await, so
  /// there is no window to slip through.
  private var isFrozen = false
  private struct ActiveFreeze {
    let token: EditSessionFreezeToken
    let storeGeneration: Int
  }
  private var activeFreeze: ActiveFreeze?
  private var freezePassActive = false
  private var freezePassWaiters: [CheckedContinuation<Void, Never>] = []
  private var freezeWorkCount = 0
  private var freezeWorkWaiters: [CheckedContinuation<Void, Never>] = []
  /// A reopen can refreeze a session while `resumeAll()` is suspended on another
  /// session. The generation makes that pass repeat before editors are exposed.
  private var sessionFreezeGeneration = 0

  public init(
    store: RectoStore,
    sync: SyncEngine?,
    origin: String,
    countWords: @escaping @Sendable (String) -> Int = RectoWordCount.plainText
  ) {
    self.store = store
    self.sync = sync
    self.origin = origin
    self.countWords = countWords
    self.beforeFreezePass = nil
    self.beforeSessionResume = nil
  }

  init(
    store: RectoStore,
    sync: SyncEngine?,
    origin: String,
    countWords: @escaping @Sendable (String) -> Int = RectoWordCount.plainText,
    beforeFreezePass: (@Sendable () async -> Void)? = nil,
    beforeSessionResume: @escaping @Sendable (String) async -> Void
  ) {
    self.store = store
    self.sync = sync
    self.origin = origin
    self.countWords = countWords
    self.beforeFreezePass = beforeFreezePass
    self.beforeSessionResume = beforeSessionResume
  }

  /// The session for a document, opening it if this is the first holder.
  /// Every caller must pair this with `release`.
  ///
  /// The map is written BEFORE the first `await`, so two concurrent first opens
  /// cannot each construct a session (and each start an event listener).
  public func session(for documentLocalId: String) async throws -> DocumentSession {
    let session: DocumentSession
    if let existing = sessions[documentLocalId] {
      session = existing
    } else {
      session = DocumentSession(
        documentLocalId: documentLocalId, store: store, sync: sync, origin: origin,
        countWords: countWords)
      sessions[documentLocalId] = session
    }
    holders[documentLocalId, default: 0] += 1
    // Frozen BEFORE the first await, so a session created during a sign-out
    // cannot accept an edit that the final unsynced count has already missed.
    let freezeNewSession = isFrozen
    do {
      if freezeNewSession {
        sessionFreezeGeneration += 1
        await freezeSession(session)
      }
      try await session.open()
    } catch {
      // A failed open must not leave a holder or a half-built session behind: a
      // later successful open would then reach count two and its single release
      // would never perform the final close.
      if releaseHolder(documentLocalId), holders[documentLocalId] == nil {
        sessions[documentLocalId] = nil
      }
      throw error
    }
    return session
  }

  /// Drop one holder. The session flushes and tears down when the last one goes.
  ///
  /// The holder count is decremented synchronously, before any await, so an
  /// open arriving during the close cannot be lost between a check and a removal.
  public func release(_ documentLocalId: String) async {
    guard let session = sessions[documentLocalId] else { return }
    let isLast = releaseHolder(documentLocalId)
    await session.close()
    // Only drop the map entry if nobody re-opened while we were closing.
    if isLast, holders[documentLocalId] == nil { sessions[documentLocalId] = nil }
  }

  public func registerIngress(
    for documentLocalId: String, _ ingress: any EditorIngressCoordinating
  ) async throws -> UUID {
    guard !ingressDocumentIds.values.contains(documentLocalId) else {
      throw SessionError.editableHolderExists(documentLocalId)
    }
    let id = UUID()
    ingresses[id] = ingress
    ingressDocumentIds[id] = documentLocalId
    if isFrozen { await freezeIngress(ingress) }
    return id
  }

  public func unregisterIngress(_ id: UUID) async {
    guard let ingress = ingresses.removeValue(forKey: id) else { return }
    ingressDocumentIds[id] = nil
    await ingress.drain()
  }

  /// Returns true when that was the last holder.
  @discardableResult
  private func releaseHolder(_ documentLocalId: String) -> Bool {
    guard let count = holders[documentLocalId] else { return true }
    if count <= 1 {
      holders[documentLocalId] = nil
      return true
    }
    holders[documentLocalId] = count - 1
    return false
  }

  /// Flush every open document — app termination, background, log out.
  public func flushAll() async {
    for ingress in ingresses.values { await ingress.drain() }
    for session in sessions.values { try? await session.flush() }
  }

  /// Stop accepting edits and flush. Sign-out cannot honestly count unsynced
  /// work while an open document can still write into the gap.
  public func freezeAndFlushAll() async -> EditSessionFreezeToken {
    await acquireFreezePass()
    defer { releaseFreezePass() }
    await beforeFreezePass?()
    await waitForFreezeWork()
    // Registry-wide first and synchronously, so sessions opened during the
    // awaits below are born frozen too.
    let token = EditSessionFreezeToken()
    isFrozen = true
    activeFreeze = ActiveFreeze(token: token, storeGeneration: store.freezeLocalMutations())
    for ingress in ingresses.values { await freezeIngress(ingress) }
    for session in sessions.values { await freezeSession(session) }
    for session in sessions.values { try? await session.flush() }
    await waitForFreezeWork()
    return token
  }

  @discardableResult
  public func resumeAll(after freeze: EditSessionFreezeToken) async -> Bool {
    guard owns(freeze) else { return false }
    while true {
      await waitForFreezeWork()
      guard owns(freeze) else { return false }
      let generation = sessionFreezeGeneration
      let sessionSnapshot = Array(sessions.values)
      let ingressSnapshot = ingresses
      for session in sessionSnapshot {
        guard owns(freeze) else { return false }
        await beforeSessionResume?(session.documentLocalId)
        guard owns(freeze) else { return false }
        await session.resume()
        guard owns(freeze) else { return false }
      }
      for ingress in ingressSnapshot.values {
        guard owns(freeze) else { return false }
        await ingress.resume()
        guard owns(freeze) else { return false }
      }
      await waitForFreezeWork()
      guard owns(freeze) else { return false }
      let resumedSessions = Set(sessionSnapshot.map(ObjectIdentifier.init))
      let currentSessions = Set(sessions.values.map(ObjectIdentifier.init))
      if generation == sessionFreezeGeneration,
        resumedSessions == currentSessions,
        Set(ingressSnapshot.keys) == Set(ingresses.keys)
      {
        break
      }
    }

    guard let activeFreeze, activeFreeze.token == freeze else { return false }
    isFrozen = false
    self.activeFreeze = nil
    store.resumeLocalMutations(frozenAt: activeFreeze.storeGeneration)
    return true
  }

  private func owns(_ freeze: EditSessionFreezeToken) -> Bool {
    isFrozen && activeFreeze?.token == freeze
  }

  private func acquireFreezePass() async {
    guard freezePassActive else {
      freezePassActive = true
      return
    }
    await withCheckedContinuation { freezePassWaiters.append($0) }
  }

  private func releaseFreezePass() {
    guard !freezePassWaiters.isEmpty else {
      freezePassActive = false
      return
    }
    freezePassWaiters.removeFirst().resume()
  }

  private func freezeSession(_ session: DocumentSession) async {
    freezeWorkCount += 1
    await session.freeze()
    finishFreezeWork()
  }

  private func freezeIngress(_ ingress: any EditorIngressCoordinating) async {
    freezeWorkCount += 1
    await ingress.freezeAndDrain()
    finishFreezeWork()
  }

  private func finishFreezeWork() {
    freezeWorkCount -= 1
    guard freezeWorkCount == 0 else { return }
    let waiters = freezeWorkWaiters
    freezeWorkWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func waitForFreezeWork() async {
    while freezeWorkCount > 0 {
      await withCheckedContinuation { freezeWorkWaiters.append($0) }
    }
  }

  /// Empty and drop every session, after an identity change has purged the
  /// mirror they were reading.
  ///
  /// Dropping them from the map is not enough on its own — a window holds its
  /// own reference — so each session also clears its state and finishes its
  /// stream. The registry stays frozen: the new identity is published first,
  /// and the owning `resumeAll(after:)` is what lets windows open fresh sessions.
  public func invalidateAll() async {
    isFrozen = true
    let invalidated = Array(sessions.values)
    let invalidatedIngresses = Array(ingresses.values)
    sessions.removeAll()
    holders.removeAll()
    ingresses.removeAll()
    ingressDocumentIds.removeAll()
    for ingress in invalidatedIngresses { await ingress.invalidate() }
    for session in invalidated { await session.invalidate() }
  }

  /// Whether new sessions are currently born frozen.
  public var isFrozenForTesting: Bool { isFrozen }
  var freezePassWaiterCountForTesting: Int { freezePassWaiters.count }
  var freezeWorkCountForTesting: Int { freezeWorkCount }

  public var openDocumentIds: [String] { Array(sessions.keys) }
}

extension DocumentSession {
  /// No windows are holding this session any more.
  var isIdle: Bool { holderCount == 0 }
}
