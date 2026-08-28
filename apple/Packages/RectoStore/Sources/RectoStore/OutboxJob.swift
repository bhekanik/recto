import Foundation
import GRDB
import RectoHistory

/// What an outbox row asks `RectoSync` to send.
public enum OutboxKind: String, Codable, Sendable, DatabaseValueConvertible {
  /// `documents.create` for a document minted offline.
  case createDocument
  /// `documents.commitEdit` — node + head + markdown in one server transaction.
  case commitEdit
  /// `documents.updateCurrentNodeId` — an undo/redo/navigate pointer move with
  /// no new node.
  case pointerMove
  /// `documents.updateMarkdown` — the debounced draft save.
  case draftSave
  case rename
  case remove
  /// `writingStats.record`.
  case writingStats
}

/// One queued mutation. Rows drain **strictly in `id` order per document**:
/// `documents.lastCommit` remembers exactly one `clientMutationId`, so only the
/// most recent commit is replay-safe (see `convex/documents.ts`). An outbox that
/// pipelined commits and later replayed an older one would be told `diverged`
/// instead of getting its original answer.
public struct OutboxJob: Codable, Sendable, FetchableRecord, MutablePersistableRecord, Equatable {
  public static let databaseTableName = "outbox"

  public var id: Int64?
  public var documentLocalId: String
  public var kind: OutboxKind
  /// Idempotency key (a ULID). Survives retries unchanged — that is the whole
  /// point of it.
  public var clientMutationId: String
  /// The head this job was built on. `commitEdit` sends it as
  /// `expectedHeadNodeId`; the conflict rules compare against it.
  public var baseHeadNodeId: String?
  public var payload: String
  public var attempts: Int
  public var lastError: String?
  /// Exponential backoff: not eligible before this instant.
  public var nextAttemptAt: Double
  public var createdAt: Double

  public init(
    id: Int64? = nil,
    documentLocalId: String,
    kind: OutboxKind,
    clientMutationId: String,
    baseHeadNodeId: String? = nil,
    payload: String,
    attempts: Int = 0,
    lastError: String? = nil,
    nextAttemptAt: Double = 0,
    createdAt: Double
  ) {
    self.id = id
    self.documentLocalId = documentLocalId
    self.kind = kind
    self.clientMutationId = clientMutationId
    self.baseHeadNodeId = baseHeadNodeId
    self.payload = payload
    self.attempts = attempts
    self.lastError = lastError
    self.nextAttemptAt = nextAttemptAt
    self.createdAt = createdAt
  }

  public mutating func didInsert(_ inserted: InsertionSuccess) {
    id = inserted.rowID
  }
}

/// Backoff schedule for a failed drain: 1s, 2s, 4s … capped at 5 minutes, with
/// ±20% jitter so a fleet of devices coming back online does not synchronise.
public func outboxBackoff(attempts: Int, jitter: Double = Double.random(in: 0.8...1.2)) -> Double {
  let base = min(pow(2, Double(max(attempts - 1, 0))), 300)
  return base * jitter
}
