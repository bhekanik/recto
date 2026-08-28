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
	})
		.index("by_user", ["userId"])
		.index("by_user_updated", ["userId", "updatedAt"]),

	workspaces: defineTable({
		userId: v.string(),
		paneTree: v.string(),
		openDocumentIds: v.array(v.id("documents")),
		activePaneId: v.string(),
		perPaneViewState: v.string(),
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
		.index("by_document_reviewer", ["documentId", "reviewerUserId"]),

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
	}).index("by_document", ["documentId"]),

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
