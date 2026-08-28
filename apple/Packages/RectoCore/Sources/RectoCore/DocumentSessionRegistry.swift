import Foundation
import RectoHistory
import RectoAuth
import RectoStore
import RectoSync

/// One `DocumentSession` per document per process.
///
/// The orchestrator's decision (§0) allows the same document in two Mac windows.
/// That is only safe if both windows drive the *same* actor: two sessions would
/// each hold their own `GroupingController` seeded at the same head and would
/// commit sibling nodes for the same keystrokes, forking the tree on every
/// character. The registry is what makes "shared state" true rather than
/// hopeful.
public actor DocumentSessionRegistry: EditSessionCoordinating {
  private let store: RectoStore
  private let sync: SyncEngine?
  private let origin: String
  private let countWords: @Sendable (String) -> Int
  private var sessions: [String: DocumentSession] = [:]
  /// Holder counts live here, not behind an await on the session, so
  /// check-and-remove is never split across a suspension.
  private var holders: [String: Int] = [:]

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
    do {
      try await session.open()
    } catch {
      releaseHolder(documentLocalId)
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
    for session in sessions.values { try? await session.flush() }
  }

  /// Stop accepting edits and flush. Sign-out cannot honestly count unsynced
  /// work while an open document can still write into the gap.
  public func freezeAndFlushAll() async {
    for session in sessions.values { await session.freeze() }
    for session in sessions.values { try? await session.flush() }
  }

  public func resumeAll() async {
    for session in sessions.values { await session.resume() }
  }

  public var openDocumentIds: [String] { Array(sessions.keys) }
}

extension DocumentSession {
  /// No windows are holding this session any more.
  var isIdle: Bool { holderCount == 0 }
}
