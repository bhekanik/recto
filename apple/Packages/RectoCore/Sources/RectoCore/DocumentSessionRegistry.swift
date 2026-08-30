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
      if freezeNewSession { await session.freeze() }
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
    if isFrozen { await ingress.freezeAndDrain() }
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
  public func freezeAndFlushAll() async {
    // Registry-wide first and synchronously, so sessions opened during the
    // awaits below are born frozen too.
    isFrozen = true
    for ingress in ingresses.values { await ingress.freezeAndDrain() }
    for session in sessions.values { await session.freeze() }
    for session in sessions.values { try? await session.flush() }
  }

  public func resumeAll() async {
    var resumed: Set<ObjectIdentifier> = []
    while let session = sessions.values.first(where: { !resumed.contains(ObjectIdentifier($0)) }) {
      resumed.insert(ObjectIdentifier(session))
      await session.resume()
    }
    isFrozen = false
    for ingress in Array(ingresses.values) { await ingress.resume() }
  }

  /// Empty and drop every session, after an identity change has purged the
  /// mirror they were reading.
  ///
  /// Dropping them from the map is not enough on its own — a window holds its
  /// own reference — so each session also clears its state and finishes its
  /// stream. The registry stays frozen: the new identity is published first,
  /// and `resumeAll()` is what lets windows open fresh sessions.
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

  public var openDocumentIds: [String] { Array(sessions.keys) }
}

extension DocumentSession {
  /// No windows are holding this session any more.
  var isIdle: Bool { holderCount == 0 }
}
