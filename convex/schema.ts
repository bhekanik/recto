import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Phase 1 — documents; Phase 3 — workspaces. users owned by Better Auth component. */
export default defineSchema({
	documents: defineTable({
		userId: v.string(),
		title: v.string(),
		markdown: v.string(),
		wordCount: v.number(),
		currentNodeId: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
		// Which head the stored `markdown` belongs to. Without it a client cannot
		// tell a draft saved ahead of the head (safe to show) from text a legacy
		// headless save left under someone else's branch (not safe to promote
		// into the DAG). Absent means "unknown provenance" — never trusted.
		markdownHeadNodeId: v.optional(v.string()),
		// Monotonic counter bumped by every write that moves currentNodeId. Clients
		// order pointer observations by this instead of updatedAt: two writes can
		// share a millisecond, and a markdown-only write bumps updatedAt without
		// moving the pointer at all. Optional: rows predating it read as 0.
		pointerRevision: v.optional(v.number()),
		// Result of the most recent documents.commitEdit, keyed by the caller's
		// clientMutationId so a retried commit (offline outbox, flaky network)
		// replays the original answer instead of being read as a divergence.
		// Optional: rows written before commitEdit existed have none.
		lastCommit: v.optional(
			v.object({
				clientMutationId: v.string(),
				headNodeId: v.string(),
				updatedAt: v.number(),
				pointerRevision: v.optional(v.number()),
			}),
		),
		// Client-chosen idempotency key for creation. An offline client mints the
		// document locally and only later reaches `documents.create`; without a key
		// a retried create makes a second document holding the same text. Optional:
		// documents created by the web (online, one call) have none.
		documentUuid: v.optional(v.string()),
		// The nodeId of this document's root node. Stored because a replayed
		// `create` has to hand the caller back the same root it got the first
		// time, and `currentNodeId` has usually moved on by then; finding it by
		// walking `docNodes` for `parentNodeId === null` would scan the whole
		// history. Optional: rows created before this field have none.
		rootNodeId: v.optional(v.string()),
	})
		.index("by_user", ["userId"])
		.index("by_user_updated", ["userId", "updatedAt"])
		.index("by_user_uuid", ["userId", "documentUuid"]),

	/**
	 * Pane layout, per user AND per device (plan 023 §4.1(3)). A Mac's four-way
	 * split is not a layout an iPhone can show, so a single shared row made every
	 * device fight over one tree; each device now owns its own row and "Resume
	 * from <device> layout" is an explicit action (`workspaces.listForUser` +
	 * `getForDevice`), never an implicit overwrite.
	 *
	 * Two row shapes live here during the migration. The LEGACY row (no
	 * `deviceId`, columns spelled out) is what the deployed web client reads and
	 * writes through `workspaces.get/save`; the DEVICE row (`deviceId` +
	 * `deviceClass` + `json`) is the shape every client moves to. The legacy
	 * columns are optional so device rows can omit them, not because a legacy row
	 * may lack them. A user has at most one legacy row and one row per device.
	 */
	workspaces: defineTable({
		userId: v.string(),
		updatedAt: v.number(),
		// Device rows only.
		deviceId: v.optional(v.string()),
		deviceClass: v.optional(
			v.union(
				v.literal("mac"),
				v.literal("ipad"),
				v.literal("iphone"),
				v.literal("web"),
			),
		),
		// Device rows only: the serialized layout, opaque to the server. A JSON
		// string rather than columns because each device class shapes its own
		// layout (panes on the Mac, a tab stack on iPhone) and the server has no
		// business validating either.
		json: v.optional(v.string()),
		// Legacy row only.
		paneTree: v.optional(v.string()),
		openDocumentIds: v.optional(v.array(v.id("documents"))),
		activePaneId: v.optional(v.string()),
		perPaneViewState: v.optional(v.string()),
	})
		.index("by_user", ["userId"])
		.index("by_user_device", ["userId", "deviceId"]),

	/**
	 * The writer's synced preferences, one row per user (plan 023 §4.1(2)). An
	 * opaque JSON object so adding a setting needs no migration: the shape is the
	 * client's contract with itself, and a client that does not know a key leaves
	 * it alone rather than dropping it (`settings.save` merges nothing — the
	 * client sends the whole object it read).
	 *
	 * Deliberately NOT every setting. Preferences about the machine you are
	 * sitting at — light/dark, text zoom, which panels are open — stay in device
	 * storage; see docs/blueprint/10-sync-persistence.md §8 for the split.
	 */
	settings: defineTable({
		userId: v.string(),
		json: v.string(),
		updatedAt: v.number(),
	}).index("by_user", ["userId"]),

	// Append-only branching undo-tree DAG; nodes are immutable (blueprint 03 §2, 07).
	docNodes: defineTable({
		documentId: v.id("documents"),
		nodeId: v.string(), // client-generated ULID; globally unique
		parentNodeId: v.union(v.string(), v.null()), // null only on the root
		patch: v.string(), // delta of canonical Markdown vs parent's materialized state
		snapshot: v.optional(v.string()), // occasional full snapshot (root + every Nth)
		selection: v.union(
			v.object({ anchor: v.number(), head: v.number() }),
			v.null(),
		),
		origin: v.string(), // device/client id that created the node
		createdAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_document_node", ["documentId", "nodeId"]),

	// Tagged versions — named references into docNodes (blueprint 03 §2, 08).
	versions: defineTable({
		documentId: v.id("documents"),
		nodeId: v.string(), // the docNodes.nodeId this version points at
		label: v.string(),
		kind: v.union(v.literal("auto"), v.literal("manual")),
		createdAt: v.number(),
	}).index("by_document", ["documentId"]),

	// Invite-based per-document ACL (plan 010). Owner shares one document with an
	// invited email; once that email signs in, granteeUserId is resolved & cached.
	documentShares: defineTable({
		documentId: v.id("documents"),
		ownerUserId: v.string(),
		granteeEmail: v.string(), // lowercased at write time
		granteeUserId: v.optional(v.string()), // resolved on first access by that user
		role: v.union(v.literal("commenter"), v.literal("suggester")),
		createdAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_grantee_email", ["granteeEmail"])
		.index("by_grantee_user", ["granteeUserId"]),

	// A reviewer's shadow suggestion branch off the owner's tree (plan 010).
	// headNodeId advances as the reviewer appends; status drives the review surface.
	// Reject = status "rejected" (the abandoned branch is pruned by retention).
	reviewBranches: defineTable({
		documentId: v.id("documents"),
		reviewerUserId: v.string(),
		baseNodeId: v.string(), // owner's currentNodeId when the branch opened
		headNodeId: v.string(), // latest reviewer node on this branch
		status: v.union(
			v.literal("open"),
			v.literal("accepted"),
			v.literal("rejected"),
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_document_reviewer", ["documentId", "reviewerUserId"])
		// Account deletion has to find every branch a user opened on SOMEONE
		// ELSE's document, where the documentId is not known up front.
		.index("by_reviewer", ["reviewerUserId"]),

	// Anchored comments on a shared document (plan 010, Phase B). Anchor stores the
	// quoted text + position hint; re-located by search so it survives edits.
	comments: defineTable({
		documentId: v.id("documents"),
		authorUserId: v.string(),
		authorName: v.string(),
		anchor: v.object({
			quote: v.string(), // exact quoted substring of canonical markdown
			prefix: v.string(), // up to ~32 chars before the quote (disambiguator)
			suffix: v.string(), // up to ~32 chars after the quote
			offsetHint: v.number(), // char offset at anchor time (tie-breaker only)
		}),
		body: v.string(),
		threadParentId: v.optional(v.id("comments")),
		resolved: v.boolean(),
		createdAt: v.number(),
	})
		.index("by_document", ["documentId"])
		// Same reason as reviewBranches.by_reviewer: a user's comments on other
		// people's documents are only reachable by author.
		.index("by_author", ["authorUserId"]),

	// RAG over the writer's own drafts (plan 009, Phase C): paragraph-windowed
	// chunks of each document with their embedding. The vectorIndex dimensions
	// MUST equal AI_EMBEDDING_DIM in lib/ai/config.ts (1536 — verified for
	// openai/text-embedding-3-small via OpenRouter). Changing the model means a new
	// index + a full re-embed.
	docChunks: defineTable({
		userId: v.string(),
		documentId: v.id("documents"),
		charStart: v.number(),
		charEnd: v.number(),
		text: v.string(),
		embedding: v.array(v.float64()),
		// The document's currentNodeId when this chunk was embedded — lets the cron
		// skip documents that haven't changed since their last embed.
		embeddedNodeId: v.string(),
		updatedAt: v.number(),
	})
		.index("by_document", ["documentId"])
		// A vector index cannot be queried as a plain range, so account deletion
		// needs an ordinary index to sweep one user's chunks.
		.index("by_user", ["userId"])
		.vectorIndex("by_embedding", {
			vectorField: "embedding",
			dimensions: 1536,
			filterFields: ["userId"],
		}),

	// Per-user daily writing aggregates (local-date keyed) — powers the streak and
	// the optional daily goal. Single-user; scoped by userId. (plan 002)
	writingStats: defineTable({
		userId: v.string(),
		date: v.string(), // local calendar date "YYYY-MM-DD", computed client-side
		words: v.number(), // max words-written observed for this day (monotonic; see writingStats.record)
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_date", ["userId", "date"]),
});
