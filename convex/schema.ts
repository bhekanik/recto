import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Phase 1 — documents; Phase 3 — workspaces. users owned by Better Auth component. */
export default defineSchema({
	documents: defineTable({
		userId: v.string(),
		title: v.string(),
		// Optional during rollout. Missing means manual so an old title is never
		// replaced by a derived one before the bounded backfill reaches it.
		titleMode: v.optional(v.union(v.literal("derived"), v.literal("manual"))),
		markdown: v.string(),
		// Overflow is independent of prose history so older text-only clients preserve it.
		overflowMarkdown: v.optional(v.string()),
		overflowRevision: v.optional(v.number()),
		lastOverflowCommit: v.optional(
			v.object({
				clientMutationId: v.string(),
				requestHash: v.string(),
				revision: v.number(),
			}),
		),
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

	// Consent is server-owned. Synced settings are opaque and client-writable.
	aiConsents: defineTable({
		userId: v.string(),
		version: v.number(),
		acceptedAt: v.number(),
	}).index("by_user", ["userId"]),

	aiCredentials: defineTable({
		userId: v.string(),
		provider: v.literal("openrouter"),
		ciphertext: v.bytes(),
		iv: v.bytes(),
		keyVersion: v.literal(1),
		last4: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_provider", ["userId", "provider"]),

	aiCredentialIntents: defineTable({
		// Keep this row after removal so an in-flight provider call cannot restore a key.
		userId: v.string(),
		generation: v.number(),
		updatedAt: v.number(),
	}).index("by_user", ["userId"]),

	aiOAuthSessions: defineTable({
		userId: v.string(),
		generation: v.number(),
		stateHash: v.string(),
		verifierCiphertext: v.bytes(),
		verifierIv: v.bytes(),
		keyVersion: v.literal(1),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_state_hash", ["stateHash"]),

	aiRuns: defineTable({
		userId: v.string(),
		requestId: v.string(),
		kind: v.union(
			v.literal("transform"),
			v.literal("review"),
			v.literal("embed"),
		),
		documentId: v.id("documents"),
		sourceNodeId: v.string(),
		sourceHash: v.string(),
		sourceMarkdown: v.optional(v.string()),
		requestHash: v.string(),
		model: v.string(),
		status: v.union(
			v.literal("reserved"),
			v.literal("provider_started"),
			v.literal("succeeded"),
			v.literal("failed"),
			v.literal("cancelled"),
			v.literal("outcome_unknown"),
		),
		keySource: v.optional(v.union(v.literal("byok"), v.literal("house"))),
		output: v.optional(v.string()),
		errorCode: v.optional(v.string()),
		langsmithRunId: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
		providerStartedAt: v.optional(v.number()),
		consentAcceptedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		acknowledgedAt: v.optional(v.number()),
		applicable: v.optional(v.boolean()),
	})
		.index("by_user_request", ["userId", "requestId"])
		.index("by_user_created", ["userId", "createdAt"])
		.index("by_user_document_kind_updated", [
			"userId",
			"documentId",
			"kind",
			"updatedAt",
		])
		.index("by_user_document_kind_source_updated", [
			"userId",
			"documentId",
			"kind",
			"sourceNodeId",
			"updatedAt",
		])
		.index("by_document", ["documentId"])
		.index("by_status_updated", ["status", "updatedAt"]),

	aiActiveRuns: defineTable({
		userId: v.string(),
		documentId: v.id("documents"),
		kind: v.union(v.literal("transform"), v.literal("review")),
		runId: v.id("aiRuns"),
		sourceNodeId: v.string(),
		updatedAt: v.number(),
	})
		.index("by_user_document_kind_source", [
			"userId",
			"documentId",
			"kind",
			"sourceNodeId",
		])
		.index("by_document", ["documentId"])
		.index("by_user", ["userId"]),

	// Provider usage is append-only and idempotent on runId. Provider-started
	// uncertainty has no row because inventing zero cost would undercount spend.
	aiUsage: defineTable({
		userId: v.string(),
		runId: v.id("aiRuns"),
		// One review run can make several provider calls. Optional keeps deployed
		// rows readable; missing means the original single call at index zero.
		callIndex: v.optional(v.number()),
		kind: v.union(
			v.literal("transform"),
			v.literal("review"),
			v.literal("embed"),
		),
		model: v.string(),
		promptTokens: v.number(),
		completionTokens: v.number(),
		reasoningTokens: v.number(),
		costMicros: v.number(),
		keySource: v.union(v.literal("byok"), v.literal("house")),
		latencyMs: v.number(),
		langsmithRunId: v.optional(v.string()),
		documentId: v.optional(v.id("documents")),
		createdAt: v.number(),
	})
		.index("by_run", ["runId"])
		.index("by_run_call", ["runId", "callIndex"])
		.index("by_user_created", ["userId", "createdAt"])
		.index("by_document", ["documentId"]),

	embeddingHealthState: defineTable({
		name: v.literal("global"),
		staleCount: v.number(),
		scannedCount: v.number(),
		sweepCursor: v.optional(v.string()),
		pendingStaleCount: v.optional(v.number()),
		pendingScannedCount: v.optional(v.number()),
		hasCompletedSweep: v.optional(v.boolean()),
		updatedAt: v.number(),
	}).index("by_name", ["name"]),

	// The document row disappears in the user-facing deletion transaction. This
	// durable job row keeps the bounded dependent-row cleanup recoverable.
	aiDocumentDeletions: defineTable({
		documentId: v.id("documents"),
		userId: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_user", ["userId"]),

	commentReports: defineTable({
		commentId: v.id("comments"),
		documentId: v.id("documents"),
		reporterUserId: v.string(),
		reportedUserId: v.string(),
		reason: v.string(),
		status: v.union(v.literal("open"), v.literal("resolved")),
		createdAt: v.number(),
		resolvedAt: v.optional(v.number()),
	})
		.index("by_comment_reporter", ["commentId", "reporterUserId"])
		.index("by_document", ["documentId"])
		.index("by_reporter", ["reporterUserId"])
		.index("by_reported", ["reportedUserId"])
		.index("by_status_created", ["status", "createdAt"]),

	userBlocks: defineTable({
		blockerUserId: v.string(),
		blockedUserId: v.string(),
		createdAt: v.number(),
	})
		.index("by_blocker_blocked", ["blockerUserId", "blockedUserId"])
		.index("by_blocked", ["blockedUserId"]),

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
		// Who authored this node, when that is someone other than the document's
		// owner. Written by review.reviewerAppend; `origin` already carries
		// `review:<userId>` but a string prefix is not an index, and account
		// deletion has to find one reviewer's nodes across every document they
		// ever suggested on. Absent on owner-authored nodes, and on reviewer
		// nodes written before this field (see migrations.backfillNodeAuthors).
		authorUserId: v.optional(v.string()),
		// Which review branch this suggestion node belongs to. Retained for branch
		// attribution and older rows backfilled by migrations.backfillNodeBranches;
		// account deletion does not use branch status because partial acceptance
		// cannot prove which suggestion content became the owner's.
		branchId: v.optional(v.id("reviewBranches")),
	})
		.index("by_document", ["documentId"])
		.index("by_document_node", ["documentId", "nodeId"])
		.index("by_author_document", ["authorUserId", "documentId"]),

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
		.index("by_grantee_user", ["granteeUserId"])
		.index("by_owner_grantee_user", ["ownerUserId", "granteeUserId"]),

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

	/**
	 * Ownership for stored blobs (ADR-21). `_storage` rows carry no owner, so
	 * without this the only way to attribute a file was "whose markdown mentions
	 * its URL" — which deletes someone else's file the moment a URL is shared,
	 * and misses files referenced only from history or never referenced in
	 * markdown at all (a generated `.docx`). Written when an upload or an export
	 * completes; pre-existing files are attributed by
	 * `migrations.backfillBlobOwners`.
	 */
	blobs: defineTable({
		storageId: v.id("_storage"),
		ownerUserId: v.string(),
		kind: v.union(v.literal("upload"), v.literal("export")),
		createdAt: v.number(),
	})
		.index("by_owner", ["ownerUserId"])
		.index("by_storage", ["storageId"]),

	legacyUploadGrants: defineTable({
		token: v.string(),
		userId: v.string(),
		expiresAt: v.number(),
	})
		.index("by_token", ["token"])
		.index("by_user", ["userId"])
		.index("by_expires", ["expiresAt"]),

	legacyUploadCutovers: defineTable({
		name: v.string(),
		safeAfter: v.number(),
	}).index("by_name", ["name"]),

	/**
	 * An account deletion in flight (ADR-21). Its existence is what makes
	 * deletion atomic across the many transactions it takes: every user-facing
	 * mutation refuses while it is present, so a stale tab or an offline native
	 * client holding a still-valid JWT cannot recreate rows behind the purge.
	 *
	 * It outlives the deletion itself by `TOMBSTONE_RETENTION_MS`, because a
	 * Clerk session token stays valid for up to a minute after the user is gone
	 * and a queued mutation can still land in that window.
	 */
	accountDeletions: defineTable({
		userId: v.string(),
		/** From the JWT at request time; the purge needs it after the user is gone. */
		granteeEmail: v.optional(v.string()),
		startedAt: v.number(),
		updatedAt: v.number(),
		/**
		 * `blobs` -> `rows` -> `identity` -> `purged`. Also the answer to "is a
		 * 404 from Clerk a wrong-instance secret or a legitimate retry?": only
		 * from `identity` onward has this deployment actually asked Clerk to
		 * delete the user.
		 */
		phase: v.union(
			v.literal("blobs"),
			v.literal("rows"),
			v.literal("identity"),
			v.literal("purged"),
		),
		/** When the tombstone may be swept. Set once the deletion finishes. */
		expiresAt: v.optional(v.number()),
		blobSurveyStorageCursor: v.optional(v.number()),
	})
		.index("by_user", ["userId"])
		.index("by_expires", ["expiresAt"]),

	/**
	 * Current reference index plus migration progress. `blobRefSources` stores
	 * the exact tokens in one document/node, while `blobRefs` keeps one counted
	 * row per token and owner for account-deletion lookups.
	 *
	 * `migrations.backfillBlobOwners` used to read every document AND every
	 * history node on each 64-file batch, which is exactly the shape that blows
	 * the per-transaction read limits on any real corpus. Building the reference
	 * rows first, in bounded passes with persisted progress, makes the claim
	 * step a bounded index lookup per file. The reference rows stay current after
	 * the backfill so deletion never relies on a stale corpus scan.
	 */
	blobRefs: defineTable({
		/** The `/api/storage/<token>` segment, or a raw `_storage` id. */
		token: v.string(),
		ownerUserId: v.string(),
		count: v.optional(v.number()),
	})
		.index("by_token", ["token"])
		.index("by_token_owner", ["token", "ownerUserId"]),

	blobRefSources: defineTable({
		ownerUserId: v.string(),
		source: v.union(v.literal("document"), v.literal("node")),
		sourceId: v.string(),
		tokens: v.array(v.string()),
	})
		.index("by_source", ["source", "sourceId"])
		.index("by_owner", ["ownerUserId"]),

	migrationProgress: defineTable({
		name: v.string(),
		cursor: v.union(v.number(), v.string()),
		done: v.boolean(),
		updatedAt: v.number(),
	}).index("by_name", ["name"]),
});
