import Foundation
import GRDB

enum Migrations {
  /// Named so a test can migrate a database only as far as v1 and then run the
  /// rest over real rows, which is the path an upgrading user takes.
  static let v1 = "v1-core"
  static let v2 = "v2-pointer-revision"
  static let v3 = "v3-draft-provenance"
  static let v4 = "v4-queue-barrier"
  static let v5 = "v5-editor-ingress"
  static let v6 = "v6-title-mode"

  static func migrator() -> DatabaseMigrator {
    // Deliberately NOT `eraseDatabaseOnSchemaChange`, even in DEBUG: BK
    // daily-drives a Debug build from N6 on, and the outbox holds offline work
    // that exists nowhere else. Schema changes get a real migration.
    var migrator = DatabaseMigrator()

    migrator.registerMigration(v1) { db in
      try db.create(table: "documents") { t in
        t.primaryKey("localId", .text)
        t.column("convexId", .text).unique()
        t.column("title", .text).notNull()
        t.column("markdown", .text).notNull()
        t.column("draftMarkdown", .text)
        t.column("draftSelectionAnchor", .integer)
        t.column("draftSelectionHead", .integer)
        t.column("wordCount", .integer).notNull()
        t.column("localHeadNodeId", .text).notNull()
        t.column("remoteHeadNodeId", .text)
        t.column("remoteUpdatedAt", .double)
        t.column("syncState", .text).notNull()
        t.column("divergedRemoteHeadNodeId", .text)
        t.column("updatedAt", .double).notNull()
        t.column("createdAt", .double).notNull()
        t.column("deletedAt", .double)
      }
      try db.create(indexOn: "documents", columns: ["updatedAt"])

      try db.create(table: "doc_nodes") { t in
        t.column("documentLocalId", .text).notNull()
          .references("documents", onDelete: .cascade)
        t.column("nodeId", .text).notNull()
        t.column("parentNodeId", .text)
        t.column("patch", .text).notNull()
        t.column("snapshot", .text)
        t.column("selectionAnchor", .integer)
        t.column("selectionHead", .integer)
        t.column("origin", .text).notNull()
        t.column("createdAt", .double).notNull()
        t.column("materialized", .text)
        t.column("materializedAt", .double)
        t.column("synced", .boolean).notNull().defaults(to: false)
        t.primaryKey(["documentLocalId", "nodeId"])
      }
      try db.create(indexOn: "doc_nodes", columns: ["documentLocalId", "createdAt"])
      // Drives the "which of my nodes has the server not seen?" query the
      // ancestor-upload path in §4.4 runs.
      try db.create(indexOn: "doc_nodes", columns: ["documentLocalId", "synced"])

      try db.create(table: "versions") { t in
        t.column("documentLocalId", .text).notNull()
          .references("documents", onDelete: .cascade)
        t.column("versionId", .text).notNull()
        t.column("nodeId", .text).notNull()
        t.column("label", .text).notNull()
        t.column("kind", .text).notNull()
        t.column("createdAt", .double).notNull()
        t.primaryKey(["documentLocalId", "versionId"])
      }

      try db.create(table: "comments") { t in
        t.primaryKey("commentId", .text)
        t.column("documentLocalId", .text).notNull()
          .references("documents", onDelete: .cascade)
        t.column("authorUserId", .text).notNull()
        t.column("authorName", .text).notNull()
        t.column("anchorQuote", .text).notNull()
        t.column("anchorPrefix", .text).notNull()
        t.column("anchorSuffix", .text).notNull()
        t.column("anchorOffsetHint", .integer).notNull()
        t.column("body", .text).notNull()
        t.column("threadParentId", .text)
        t.column("resolved", .boolean).notNull()
        t.column("createdAt", .double).notNull()
      }
      try db.create(indexOn: "comments", columns: ["documentLocalId"])

      try db.create(table: "review_branches") { t in
        t.primaryKey("branchId", .text)
        t.column("documentLocalId", .text).notNull()
          .references("documents", onDelete: .cascade)
        t.column("reviewerUserId", .text).notNull()
        t.column("baseNodeId", .text).notNull()
        t.column("headNodeId", .text).notNull()
        t.column("status", .text).notNull()
        t.column("createdAt", .double).notNull()
        t.column("updatedAt", .double).notNull()
      }
      try db.create(indexOn: "review_branches", columns: ["documentLocalId"])

      try db.create(table: "writing_stats") { t in
        t.primaryKey("date", .text)
        t.column("words", .integer).notNull()
        t.column("updatedAt", .double).notNull()
        t.column("dirty", .boolean).notNull().defaults(to: true)
      }

      try db.create(table: "settings") { t in
        t.primaryKey("key", .text)
        t.column("json", .text).notNull()
        t.column("updatedAt", .double).notNull()
        t.column("dirty", .boolean).notNull().defaults(to: true)
      }

      try db.create(table: "ai_runs") { t in
        t.primaryKey("runId", .text)
        t.column("documentLocalId", .text).references("documents", onDelete: .cascade)
        t.column("kind", .text).notNull()
        t.column("requestJSON", .text).notNull()
        t.column("responseJSON", .text)
        t.column("status", .text).notNull()
        t.column("createdAt", .double).notNull()
      }

      try db.create(table: "outbox") { t in
        t.autoIncrementedPrimaryKey("id")
        t.column("documentLocalId", .text).notNull()
        t.column("kind", .text).notNull()
        // The server's replay window keys on this; a duplicate would make a
        // retry look like a new mutation.
        t.column("clientMutationId", .text).notNull().unique()
        t.column("baseHeadNodeId", .text)
        t.column("payload", .text).notNull()
        t.column("attempts", .integer).notNull().defaults(to: 0)
        t.column("lastError", .text)
        t.column("nextAttemptAt", .double).notNull().defaults(to: 0)
        t.column("createdAt", .double).notNull()
      }
      // No FK to documents: a delete job has to outlive the row it deletes.
      try db.create(indexOn: "outbox", columns: ["documentLocalId", "id"])

      try db.create(table: "window_state") { t in
        t.primaryKey("windowId", .text)
        t.column("json", .text).notNull()
        t.column("updatedAt", .double).notNull()
      }
    }

    // Additive: the server's pointer revision is a monotonic counter, unlike
    // `updatedAt`, so it settles which of two pointer writes is newer without
    // trusting either device's clock (`documents.pointerRevision`, PR #1).
    migrator.registerMigration(v2) { db in
      try db.alter(table: "documents") { t in
        t.add(column: "remotePointerRevision", .double)
      }
    }

    // Additive. `markdownHeadNodeId` is the server's provenance stamp for the
    // stored body; `draftRevision` is the token a scheduled write must still
    // match to be allowed to land.
    migrator.registerMigration(v3) { db in
      try db.alter(table: "documents") { t in
        t.add(column: "remoteMarkdownHeadNodeId", .text)
        t.add(column: "draftRevision", .integer).notNull().defaults(to: 0)
      }
    }

    // The divergence barrier has to outlive the process: `stop()` used to drop
    // it, and the next launch drained the pointer move queued behind a conflict.
    migrator.registerMigration(v4) { db in
      try db.alter(table: "documents") { t in
        t.add(column: "queueBlockedReason", .text)
      }
      // Backfill. A v3 database can already hold an unresolved divergence with
      // work queued behind it; adding a nullable column would leave that row
      // looking drainable on the very next launch.
      try db.execute(
        sql: "UPDATE documents SET queueBlockedReason = 'diverged' WHERE syncState = 'diverged'")
      // A local `nil` pointer revision means "never observed", but the wire
      // decodes an absent revision as 0 — so `0 > nil` would read an unchanged
      // legacy pointer as newer than itself. Normalise the baseline.
      try db.execute(
        sql: "UPDATE documents SET remotePointerRevision = 0 WHERE remotePointerRevision IS NULL")
    }

    migrator.registerMigration(v5) { db in
      try db.alter(table: "documents") { t in
        t.add(column: "editorIngressRevision", .integer)
      }
    }

    migrator.registerMigration(v6) { db in
      try db.alter(table: "documents") { t in
        // Existing names may be user-chosen. Preserve them until the writer
        // explicitly opts into a derived title by creating a new document.
        t.add(column: "titleMode", .text).notNull().defaults(to: TitleMode.manual.rawValue)
        t.add(column: "remoteTitleUpdatedAt", .double)
      }
    }

    return migrator
  }
}
