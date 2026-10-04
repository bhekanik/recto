import Foundation
import GRDB

public struct OverflowMutation: Codable, Equatable, Sendable {
  public let id: String
  public let markdown: String
  public let generation: Int
  public let expectedRevision: Int
}

public struct OverflowRecord: Codable, FetchableRecord, PersistableRecord, Equatable, Sendable {
  public static let databaseTableName = "document_overflow"
  public var documentLocalId: String
  public var markdown = ""
  public var generation = 0
  public var acknowledgedGeneration = 0
  public var revision = 0
  public var pending: String?
  public var remoteMarkdown: String?
  public var remoteRevision: Int?
  public var syncError: String?
  public var observedMarkdown: String?
  public var observedRevision: Int?
  public var isDirty: Bool { generation != acknowledgedGeneration || pending != nil }
}

public enum OverflowError: Error, LocalizedError {
  case tooLarge
  case changed
  public var errorDescription: String? {
    switch self {
    case .tooLarge: "Overflow can hold up to 64 KiB of notes."
    case .changed: "Overflow changed in another pane. Your edit was not saved; try again."
    }
  }
}

extension RectoStore {
  public func documentsWithUnsyncedOverflow() throws -> [DocumentRecord] {
    try writer.read { db in
      try DocumentRecord.fetchAll(db, sql: """
        SELECT documents.* FROM documents JOIN document_overflow
          ON document_overflow.documentLocalId = documents.localId
        WHERE (document_overflow.generation != document_overflow.acknowledgedGeneration
          OR document_overflow.pending IS NOT NULL) AND document_overflow.remoteMarkdown IS NULL
        """)
    }
  }

  static func hasUnsyncedOverflow(_ db: Database, localId: String) throws -> Bool {
    guard let row = try OverflowRecord.fetchOne(db, key: localId) else { return false }
    return row.isDirty || row.remoteMarkdown != nil
  }

  public func setOverflowSyncError(localId: String, message: String?) throws {
    try performLocalMutation {
      try writer.write { db in
        guard try DocumentRecord.fetchOne(db, key: localId) != nil else { return }
        var row = try OverflowRecord.fetchOne(db, key: localId) ?? OverflowRecord(documentLocalId: localId)
        row.syncError = message
        try row.save(db)
      }
    }
  }

  /// Synchronous so an editor never acknowledges text that has only reached memory.
  public nonisolated func overflow(localId: String) throws -> OverflowRecord {
    try writer.read { db in
      guard try DocumentRecord.fetchOne(db, key: localId) != nil else {
        throw StoreError.documentNotFound(localId)
      }
      return try OverflowRecord.fetchOne(db, key: localId) ?? OverflowRecord(documentLocalId: localId)
    }
  }

  public nonisolated func saveOverflow(localId: String, markdown: String, expectedGeneration: Int) throws -> OverflowRecord {
    guard markdown.utf8.count <= 65_536 else { throw OverflowError.tooLarge }
    return try performLocalMutation {
      try writer.write { db in
        guard try DocumentRecord.fetchOne(db, key: localId) != nil else { throw StoreError.documentNotFound(localId) }
        var row = try OverflowRecord.fetchOne(db, key: localId) ?? OverflowRecord(documentLocalId: localId)
        guard row.generation == expectedGeneration else { throw OverflowError.changed }
        if !(row.markdown as NSString).isEqual(to: markdown) {
          row.markdown = markdown
          row.generation += 1
          try row.save(db)
        }
        return row
      }
    }
  }

  /// The persisted request is immutable until a reply resolves its outcome.
  public func prepareOverflowMutation(localId: String) throws -> OverflowMutation? {
    try performLocalMutation {
      try writer.write { db in
        guard var row = try OverflowRecord.fetchOne(db, key: localId), row.remoteMarkdown == nil else { return nil }
        if let pending = row.pending { return try JSONDecoder().decode(OverflowMutation.self, from: Data(pending.utf8)) }
        guard row.isDirty else { return nil }
        let mutation = OverflowMutation(id: UUID().uuidString, markdown: row.markdown, generation: row.generation, expectedRevision: row.revision)
        row.pending = String(decoding: try JSONEncoder().encode(mutation), as: UTF8.self)
        try row.update(db)
        return mutation
      }
    }
  }

  public func acknowledgeOverflow(localId: String, mutation: OverflowMutation, revision: Int, latestMarkdown: String? = nil, latestRevision: Int? = nil) throws {
    try performLocalMutation {
      try writer.write { db in
        guard var row = try OverflowRecord.fetchOne(db, key: localId),
          let pending = row.pending,
          try JSONDecoder().decode(OverflowMutation.self, from: Data(pending.utf8)).id == mutation.id else { return }
        row.pending = nil
        row.revision = revision
        row.acknowledgedGeneration = mutation.generation
        let observedIsNewer = (row.observedRevision ?? -1) > (latestRevision ?? -1)
        let newestRevision = observedIsNewer ? row.observedRevision : latestRevision
        let newestMarkdown = observedIsNewer ? row.observedMarkdown : latestMarkdown
        if let newestRevision, let newestMarkdown, newestRevision > revision {
          Self.applyOverflowRemote(&row, markdown: newestMarkdown, revision: newestRevision)
        }
        row.observedMarkdown = nil
        row.observedRevision = nil
        try row.update(db)
      }
    }
  }

  public func receiveOverflow(localId: String, markdown: String, revision: Int, rejectedMutation: String? = nil) throws {
    try performLocalMutation {
      try writer.write { db in
        guard try DocumentRecord.fetchOne(db, key: localId) != nil else { return }
        var row = try OverflowRecord.fetchOne(db, key: localId) ?? OverflowRecord(documentLocalId: localId)
        if let rejectedMutation {
          guard let pending = row.pending,
            try JSONDecoder().decode(OverflowMutation.self, from: Data(pending.utf8)).id == rejectedMutation else { return }
          row.pending = nil
        } else if row.pending != nil {
          if revision > row.revision, revision >= (row.observedRevision ?? -1) {
            row.observedMarkdown = markdown
            row.observedRevision = revision
            try row.save(db)
          }
          return
        }
        let observedIsNewer = (row.observedRevision ?? -1) > revision
        let latestMarkdown = observedIsNewer ? row.observedMarkdown ?? markdown : markdown
        let latestRevision = observedIsNewer ? row.observedRevision ?? revision : revision
        guard latestRevision >= row.revision else { return }
        if row.isDirty, rejectedMutation != nil, latestRevision == row.revision {
          row.remoteMarkdown = latestMarkdown
          row.remoteRevision = latestRevision
        } else {
          Self.applyOverflowRemote(&row, markdown: latestMarkdown, revision: latestRevision)
        }
        row.observedMarkdown = nil
        row.observedRevision = nil
        try row.save(db)
      }
    }
  }

  private static func applyOverflowRemote(_ row: inout OverflowRecord, markdown: String, revision: Int) {
    if row.isDirty {
      if revision > row.revision, revision >= (row.remoteRevision ?? -1) {
        row.remoteMarkdown = markdown
        row.remoteRevision = revision
      }
    } else {
      if !(row.markdown as NSString).isEqual(to: markdown) { row.generation += 1 }
      row.markdown = markdown
      row.acknowledgedGeneration = row.generation
      row.revision = revision
    }
  }

  /// Both buffers remain durable until the writer explicitly chooses one.
  public nonisolated func resolveOverflow(localId: String, keepLocal: Bool, expectedGeneration: Int) throws -> OverflowRecord {
    try performLocalMutation {
      try writer.write { db in
        guard var row = try OverflowRecord.fetchOne(db, key: localId),
          let remote = row.remoteMarkdown, let revision = row.remoteRevision else { throw OverflowError.changed }
        guard row.generation == expectedGeneration else { throw OverflowError.changed }
        row.revision = revision
        row.remoteMarkdown = nil
        row.remoteRevision = nil
        row.generation += 1
        if !keepLocal {
          row.markdown = remote
          row.acknowledgedGeneration = row.generation
        }
        try row.update(db)
        return row
      }
    }
  }
}
