import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { assertNotDeleting } from "./accountGuard";
import { AI_CONSENT_VERSION } from "./ai/consent";
import { aiError } from "./ai/errors";
import { syncBlobReferences } from "./blobReferences";
import {
	MARKDOWN_TOO_LARGE_MESSAGE,
	MAX_MARKDOWN_LENGTH,
	requireOwnedDocument,
	requireUserId,
	utf8Length,
} from "./documents";
import {
	applyAcceptedHunks,
	type DiffGranularity,
	diffRuns,
	groupHunks,
	materialize,
	parsePatch,
	type ServerNode,
} from "./history";

type QueryCtx = GenericQueryCtx<import("./_generated/dataModel").DataModel>;
type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

const selectionValidator = v.union(
	v.object({ anchor: v.number(), head: v.number() }),
	v.null(),
);

/**
 * Synthetic attribution for AI-authored review feedback (plan 011). MUST stay in
 * sync with `lib/ai/review.ts` (`AI_REVIEWER_AUTHOR_ID` / `AI_CHAT_MODEL`) —
 * Convex function modules can't import from `lib/` (the bundle is self-contained),
 * so these are duplicated literals, not imports. The AI branch's `reviewerUserId`
 * is this synthetic id (there is no Clerk user for the AI), and its nodes carry an
 * `ai:review:<model>` origin so `listOpenBranches` can label + count them.
 */
const AI_REVIEWER_AUTHOR_ID = "ai-reviewer";
const AI_REVIEW_MODEL = "z-ai/glm-5.2";
/** Origin prefix on AI branch nodes — mirrors `aiReviewOrigin()` in lib/ai/review.ts. */
const AI_REVIEW_ORIGIN_PREFIX = "ai:review:";

/** Role rank for access comparisons. Owner outranks all grantees. */
const ROLE_RANK = { commenter: 1, suggester: 2, owner: 3 } as const;
type AccessRole = keyof typeof ROLE_RANK;
type GranteeRole = "commenter" | "suggester";

async function usersAreBlocked(
	ctx: QueryCtx | MutationCtx,
	left: string,
	right: string,
): Promise<boolean> {
	if (left === right || right === AI_REVIEWER_AUTHOR_ID) return false;
	const [leftBlocks, rightBlocks] = await Promise.all([
		ctx.db
			.query("userBlocks")
			.withIndex("by_blocker_blocked", (q) =>
				q.eq("blockerUserId", left).eq("blockedUserId", right),
			)
			.unique(),
		ctx.db
			.query("userBlocks")
			.withIndex("by_blocker_blocked", (q) =>
				q.eq("blockerUserId", right).eq("blockedUserId", left),
			)
			.unique(),
	]);
	return leftBlocks !== null || rightBlocks !== null;
}

function toServerNode(row: Doc<"docNodes">): ServerNode {
	return {
		nodeId: row.nodeId,
		parentNodeId: row.parentNodeId,
		patch: row.patch,
		snapshot: row.snapshot,
	};
}

/** Rough word count for the accept write; the client recomputes precisely. */
function roughWordCount(markdown: string): number {
	const trimmed = markdown.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Prettify a model id's last path segment into a short display label —
 * `"z-ai/glm-5.2"` → `"GLM 5.2"`. Duplicated from `modelLabel` in lib/ai/review.ts
 * (Convex modules can't import from lib/), kept identical so the AI reviewer's name
 * matches between the review surface and the AI review panel.
 */
function aiModelLabel(model: string): string {
	const last = model.split("/").pop() ?? model;
	return last
		.replace(/[-_]+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean)
		.map((token) => (/^[a-z]+$/i.test(token) ? token.toUpperCase() : token))
		.join(" ");
}

/**
 * Resolve the caller's access to a document: owner outranks all grantees,
 * otherwise an invite-based share (by resolved user id, falling back to email).
 *
 * Throws `"Document not found"` (the SAME message as requireOwnedDocument) when
 * the caller lacks `minRole`, so existence is never leaked to non-grantees.
 *
 * In a mutation ctx an email-matched share with no `granteeUserId` is patched to
 * cache the caller's id (resolve-on-first-access). A query ctx cannot write, so
 * it skips the patch and resolves lazily on the next mutation.
 */
export async function requireDocumentAccess(
	ctx: QueryCtx | MutationCtx,
	documentId: Id<"documents">,
	minRole: AccessRole,
): Promise<{ doc: Doc<"documents">; role: AccessRole; userId: string }> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new Error("Unauthenticated");
	const userId = identity.subject;
	const email = (identity.email ?? "").toLowerCase();

	const doc = await ctx.db.get(documentId);
	if (!doc) throw new Error("Document not found");

	// This helper reads the identity itself rather than going through
	// `documents.requireUserId`, so it needs its own deletion guard. Both sides
	// matter: a reviewer whose account is being deleted must stop writing, and
	// nobody may append to a document whose OWNER is being deleted (the purge
	// would leave the new rows orphaned).
	await assertNotDeleting(ctx, userId);
	if (doc.userId !== userId) await assertNotDeleting(ctx, doc.userId);

	if (doc.userId === userId) {
		return { doc, role: "owner", userId };
	}

	// Prefer a share already bound to this user id.
	let share = await ctx.db
		.query("documentShares")
		.withIndex("by_grantee_user", (q) => q.eq("granteeUserId", userId))
		.filter((q) => q.eq(q.field("documentId"), documentId))
		.unique();

	// Fall back to an email-matched, not-yet-resolved invite.
	if (!share && email) {
		share = await ctx.db
			.query("documentShares")
			.withIndex("by_grantee_email", (q) => q.eq("granteeEmail", email))
			.filter((q) => q.eq(q.field("documentId"), documentId))
			.unique();

		// Cache the resolution on first access — mutation ctx only (queries can't write).
		if (share && share.granteeUserId === undefined && "insert" in ctx.db) {
			await (ctx as MutationCtx).db.patch(share._id, { granteeUserId: userId });
		}
	}

	if (!share) throw new Error("Document not found");
	if (await usersAreBlocked(ctx, userId, doc.userId)) {
		throw new Error("Document not found");
	}

	const role: GranteeRole = share.role;
	if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
		throw new Error("Document not found");
	}
	return { doc, role, userId };
}

// ---------------------------------------------------------------------------
// Phase A — sharing / ACL (invite by email, see shared docs)
// ---------------------------------------------------------------------------

const granteeRoleValidator = v.union(
	v.literal("commenter"),
	v.literal("suggester"),
);

/**
 * Owner shares one document with an invited email at a given role. Owner-only.
 * The email is lowercased + trimmed; sharing with oneself or an empty email is
 * rejected. Idempotent on (documentId, granteeEmail): a repeat invite updates the
 * existing row's role rather than inserting a duplicate.
 */
export const addShare = mutation({
	args: {
		documentId: v.id("documents"),
		email: v.string(),
		role: granteeRoleValidator,
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const identity = await ctx.auth.getUserIdentity();
		const ownerUserId = identity?.subject ?? (await requireUserId(ctx));
		const ownerEmail = (identity?.email ?? "").toLowerCase().trim();

		const email = args.email.toLowerCase().trim();
		if (!email) throw new Error("An email address is required.");
		if (email === ownerEmail) {
			throw new Error("You already have full access to your own document.");
		}

		// Upsert by (documentId, granteeEmail) — small N per document, scan the
		// document's shares in memory rather than add a composite index.
		const existing = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const match = existing.find((s) => s.granteeEmail === email);
		if (match) {
			if (match.role !== args.role) {
				await ctx.db.patch(match._id, { role: args.role });
			}
			return { shareId: match._id, updated: true };
		}

		const shareId = await ctx.db.insert("documentShares", {
			documentId: args.documentId,
			ownerUserId,
			granteeEmail: email,
			role: args.role,
			createdAt: Date.now(),
		});
		return { shareId, updated: false };
	},
});

/** List a document's shares. Owner-only. */
export const listShares = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const rows = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		return rows.map((row) => ({
			_id: row._id,
			granteeEmail: row.granteeEmail,
			granteeUserId: row.granteeUserId,
			role: row.role,
			createdAt: row.createdAt,
		}));
	},
});

/**
 * Revoke a share. Owner-only. Deletes only the ACL row — the reviewer's existing
 * branches/comments are intentionally LEFT in place so the owner can still review
 * and accept work done before revocation (plan 010 Maintenance: a "purge on
 * revoke" would be a separate, explicit feature).
 */
export const revokeShare = mutation({
	args: { shareId: v.id("documentShares") },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const share = await ctx.db.get(args.shareId);
		if (!share || share.ownerUserId !== userId) {
			throw new Error("Share not found");
		}
		await ctx.db.delete(args.shareId);
		return { revoked: true };
	},
});

/**
 * Documents shared WITH the caller (as a grantee). Gathers shares by resolved
 * user id AND by email (covers an invite not yet bound to a user id — queries
 * can't write, so the binding is resolved lazily on the first mutation via
 * requireDocumentAccess). Returns owner-doc metadata flagged shared + role.
 */
export const listSharedWithMe = query({
	args: {},
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error("Unauthenticated");
		const userId = identity.subject;
		const email = (identity.email ?? "").toLowerCase();

		const byUser = await ctx.db
			.query("documentShares")
			.withIndex("by_grantee_user", (q) => q.eq("granteeUserId", userId))
			.collect();
		const byEmail = email
			? await ctx.db
					.query("documentShares")
					.withIndex("by_grantee_email", (q) => q.eq("granteeEmail", email))
					.collect()
			: [];

		// De-dupe by share id (a row resolved to this user can also match by email).
		const seen = new Set<string>();
		const shares: Doc<"documentShares">[] = [];
		for (const s of [...byUser, ...byEmail]) {
			if (seen.has(s._id)) continue;
			// Don't surface the caller's own documents as "shared with me".
			if (s.ownerUserId === userId) continue;
			if (await usersAreBlocked(ctx, userId, s.ownerUserId)) continue;
			seen.add(s._id);
			shares.push(s);
		}

		const docs: {
			_id: Id<"documents">;
			title: string;
			wordCount: number;
			updatedAt: number;
			role: GranteeRole;
			ownerUserId: string;
			shared: true;
		}[] = [];
		for (const share of shares) {
			const doc = await ctx.db.get(share.documentId);
			if (!doc) continue; // skip docs deleted since the invite
			docs.push({
				_id: doc._id,
				title: doc.title,
				wordCount: doc.wordCount,
				updatedAt: doc.updatedAt,
				role: share.role,
				ownerUserId: share.ownerUserId,
				shared: true,
			});
		}
		docs.sort((a, b) => b.updatedAt - a.updatedAt);
		return docs;
	},
});

/**
 * Whether a document the CALLER is involved with is currently shared — the gate
 * the client reads to disable AI on a shared-for-review document (plan 010
 * cross-cutting rule). Returns null when the doc isn't visible to the caller (so
 * a query for a doc you can't see never throws / leaks existence).
 *
 * - Owner side: `shared` is true when the doc has ≥1 active documentShares row.
 * - Reviewer side: a grantee always sees `shared: true` (they opened a shared doc).
 */
export const documentShareState = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) return null;
		const userId = identity.subject;
		const email = (identity.email ?? "").toLowerCase();

		const doc = await ctx.db.get(args.documentId);
		if (!doc) return null;

		if (doc.userId === userId) {
			const shares = await ctx.db
				.query("documentShares")
				.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
				.collect();
			const visibleShares: typeof shares = [];
			for (const share of shares) {
				if (
					share.granteeUserId &&
					(await usersAreBlocked(ctx, userId, share.granteeUserId))
				) {
					continue;
				}
				visibleShares.push(share);
			}
			return {
				role: "owner" as const,
				shareCount: visibleShares.length,
				shared: visibleShares.length > 0,
			};
		}

		// Grantee? Resolve via user id, then email (read-only — no lazy patch here).
		let share = await ctx.db
			.query("documentShares")
			.withIndex("by_grantee_user", (q) => q.eq("granteeUserId", userId))
			.filter((q) => q.eq(q.field("documentId"), args.documentId))
			.first();
		if (!share && email) {
			share = await ctx.db
				.query("documentShares")
				.withIndex("by_grantee_email", (q) => q.eq("granteeEmail", email))
				.filter((q) => q.eq(q.field("documentId"), args.documentId))
				.first();
		}
		if (!share || (await usersAreBlocked(ctx, userId, share.ownerUserId))) {
			return null;
		}
		return { role: share.role, shareCount: 1, shared: true };
	},
});

/**
 * Reviewer suggestion append. APPEND-ONLY, access-gated at "suggester".
 * Inserts an immutable docNode (idempotent on (documentId, nodeId), origin
 * `review:<reviewerUserId>`) and opens-or-advances the caller's reviewBranches
 * row. NEVER patches the documents row — this is the isolation boundary that
 * keeps the owner's markdown / currentNodeId untouched (plan 010).
 */
export const reviewerAppend = mutation({
	args: {
		documentId: v.id("documents"),
		branchId: v.optional(v.id("reviewBranches")),
		nodeId: v.string(),
		parentNodeId: v.string(),
		patch: v.string(),
		snapshot: v.optional(v.string()),
		selection: selectionValidator,
		createdAt: v.number(),
	},
	handler: async (ctx, args) => {
		const { doc, userId } = await requireDocumentAccess(
			ctx,
			args.documentId,
			"suggester",
		);

		// Idempotent append — exactly like docNodes.append, tagged review:<userId>.
		let mustInsertNode = false;
		const existing = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.nodeId),
			)
			.unique();
		if (!existing) {
			// A suggester writes client-supplied node data into the OWNER's docNodes
			// table — validate it before it can corrupt the owner's tree or DoS the
			// owner's review surface on materialize (security hardening).

			// (a) parentNodeId must reference an existing node IN THIS document.
			const parent = await ctx.db
				.query("docNodes")
				.withIndex("by_document_node", (q) =>
					q.eq("documentId", args.documentId).eq("nodeId", args.parentNodeId),
				)
				.unique();
			if (!parent) throw new Error("Parent node not found");

			// (c) Bound patch + snapshot length (same cap as documents.updateMarkdown).
			if (utf8Length(args.patch) > MAX_MARKDOWN_LENGTH) {
				throw new Error(MARKDOWN_TOO_LARGE_MESSAGE);
			}
			if (
				args.snapshot !== undefined &&
				utf8Length(args.snapshot) > MAX_MARKDOWN_LENGTH
			) {
				throw new Error(MARKDOWN_TOO_LARGE_MESSAGE);
			}

			// (b) Patch must be well-formed: parse-safe JSON with integer from/to within
			// the parent's materialized markdown bounds and a string insert. Keep
			// applyPatch strict — reject here so a bad patch never lands in the table.
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
				.collect();
			const parentMarkdown = materialize(parent.nodeId, rows.map(toServerNode));
			if (parsePatch(args.patch, parentMarkdown.length) === null) {
				throw new Error("Malformed patch");
			}

			// Inserted below, once the branch it belongs to is known — the node
			// carries `branchId` so account deletion can decide per branch rather
			// than per (document, reviewer) (ADR-21).
			mustInsertNode = true;
		}

		// Open-or-advance this reviewer's branch row (status "open").
		const now = Date.now();
		let branch = args.branchId ? await ctx.db.get(args.branchId) : null;
		if (branch && branch.documentId !== args.documentId) branch = null;

		if (!branch) {
			// One open branch per (document, reviewer) for v1 — reuse if present.
			branch = await ctx.db
				.query("reviewBranches")
				.withIndex("by_document_reviewer", (q) =>
					q.eq("documentId", args.documentId).eq("reviewerUserId", userId),
				)
				.filter((q) => q.eq(q.field("status"), "open"))
				.first();
		}

		const branchId = branch
			? branch._id
			: await ctx.db.insert("reviewBranches", {
					documentId: args.documentId,
					reviewerUserId: userId,
					baseNodeId: doc.currentNodeId,
					headNodeId: args.nodeId,
					status: "open",
					createdAt: now,
					updatedAt: now,
				});
		if (branch) {
			await ctx.db.patch(branch._id, {
				headNodeId: args.nodeId,
				updatedAt: now,
			});
		}

		// The node insert waited for the branch id. Both writes are in the same
		// transaction, so a node can never exist without the branch it names.
		if (mustInsertNode) {
			const nodeRowId = await ctx.db.insert("docNodes", {
				documentId: args.documentId,
				nodeId: args.nodeId,
				parentNodeId: args.parentNodeId,
				patch: args.patch,
				snapshot: args.snapshot,
				selection: args.selection,
				origin: `review:${userId}`,
				// Indexed attribution, alongside the `review:<userId>` origin string
				// the review surface already reads. Account deletion has to find one
				// reviewer's suggestion nodes across every document they ever
				// suggested on, and a prefix match is not an index (ADR-21).
				authorUserId: userId,
				branchId,
				createdAt: args.createdAt,
			});
			await syncBlobReferences(ctx, doc.userId, "node", nodeRowId, [
				args.patch,
				args.snapshot ?? "",
			]);
		}

		return { nodeId: args.nodeId, branchId };
	},
});

/**
 * Owner-callable AI suggestion branch (plan 011, Phase B). The OWNER runs the AI
 * reviewer on their OWN un-shared document; the AI's surviving `quote→replacement`
 * edits have already been merged client-side (lib/ai/review-apply.ts) into the
 * full `branchMarkdown`. This creates/replaces the AI review branch:
 *
 *   - Append ONE immutable docNode parented at the document's CURRENT node, with a
 *     patch current→`branchMarkdown` + `snapshot: branchMarkdown` (one-hop
 *     materialization, mirroring versions.restore / acceptBranch's additive shape)
 *     and origin `ai:review:<model>`.
 *   - Upsert a `reviewBranches` row with `reviewerUserId = AI_REVIEWER_AUTHOR_ID`,
 *     `baseNodeId = current`, `headNodeId = new node`, `status:"open"`.
 *
 * ISOLATION INVARIANT (same as reviewerAppend): it NEVER patches the
 * `documents` row — the owner's live markdown / currentNodeId only change on
 * Accept (acceptBranch). One AI branch per document for v1: any prior OPEN AI
 * branch is marked "rejected" before the new one opens (keeps the surface to a
 * single, latest AI suggestion set; old nodes are pruned by retention).
 *
 * Authorized via `requireOwnedDocument` — NOT the suggester-gated reviewerAppend.
 * The caller is the authenticated owner; the *attributed* branch reviewer is the
 * synthetic AI id (there is no Clerk user for the AI).
 */
export const aiSuggestBranch = mutation({
	args: {
		documentId: v.id("documents"),
		/** The full AI-edited markdown that becomes the branch head. */
		branchMarkdown: v.string(),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);

		// Bound the AI branch head like documents.updateMarkdown — it is written to
		// docNodes.snapshot and guards the same Convex ~1 MiB per-value ceiling.
		if (utf8Length(args.branchMarkdown) > MAX_MARKDOWN_LENGTH) {
			throw new Error(MARKDOWN_TOO_LARGE_MESSAGE);
		}

		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const nodes = rows.map(toServerNode);
		const currentMarkdown = materialize(doc.currentNodeId, nodes);

		const now = Date.now();

		// One AI branch per document for v1 — close any prior OPEN AI branch so the
		// review surface shows only the latest AI suggestion set.
		const priorOpen = await ctx.db
			.query("reviewBranches")
			.withIndex("by_document_reviewer", (q) =>
				q
					.eq("documentId", args.documentId)
					.eq("reviewerUserId", AI_REVIEWER_AUTHOR_ID),
			)
			.filter((q) => q.eq(q.field("status"), "open"))
			.collect();
		for (const branch of priorOpen) {
			await ctx.db.patch(branch._id, { status: "rejected", updatedAt: now });
		}

		// Append the AI branch head off the owner's CURRENT node — append-only, never
		// touches the documents row (the isolation boundary).
		const newNodeId = crypto.randomUUID();
		const nodeRowId = await ctx.db.insert("docNodes", {
			documentId: args.documentId,
			nodeId: newNodeId,
			parentNodeId: doc.currentNodeId,
			patch: JSON.stringify({
				from: 0,
				to: currentMarkdown.length,
				insert: args.branchMarkdown,
			}),
			snapshot: args.branchMarkdown,
			selection: null,
			origin: `${AI_REVIEW_ORIGIN_PREFIX}${AI_REVIEW_MODEL}`,
			createdAt: now,
		});
		await syncBlobReferences(ctx, doc.userId, "node", nodeRowId, [
			JSON.stringify({
				from: 0,
				to: currentMarkdown.length,
				insert: args.branchMarkdown,
			}),
			args.branchMarkdown,
		]);

		const branchId = await ctx.db.insert("reviewBranches", {
			documentId: args.documentId,
			reviewerUserId: AI_REVIEWER_AUTHOR_ID,
			baseNodeId: doc.currentNodeId,
			headNodeId: newNodeId,
			status: "open",
			createdAt: now,
			updatedAt: now,
		});

		return { branchId, nodeId: newNodeId };
	},
});

const aiCommentValidator = v.object({
	anchor: v.object({
		quote: v.string(),
		prefix: v.string(),
		suffix: v.string(),
		offsetHint: v.number(),
	}),
	body: v.string(),
});

/** Atomically materialize one provider review against the exact reserved head. */
export const applyAiReview = internalMutation({
	args: {
		userId: v.string(),
		documentId: v.id("documents"),
		sourceNodeId: v.string(),
		sourceText: v.string(),
		comments: v.array(aiCommentValidator),
		branchMarkdown: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await assertNotDeleting(ctx, args.userId);
		const doc = await ctx.db.get(args.documentId);
		if (!doc || doc.userId !== args.userId) {
			aiError("document_not_found", "Document not found");
		}
		if (doc.currentNodeId !== args.sourceNodeId) {
			aiError(
				"document_changed",
				"The document changed before review application.",
			);
		}
		if (doc.markdown !== args.sourceText) {
			aiError(
				"document_changed",
				"The draft changed before review application.",
			);
		}
		const deletion = await ctx.db
			.query("aiDocumentDeletions")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.unique();
		if (deletion) aiError("document_not_found", "Document not found");
		const share = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.first();
		if (share) aiError("document_shared", "AI is disabled on shared documents");
		const consent = await ctx.db
			.query("aiConsents")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		if (consent?.version !== AI_CONSENT_VERSION) {
			aiError(
				"ai_consent_required",
				"Accept the current AI consent notice first.",
			);
		}

		for (const comment of args.comments) {
			const body = comment.body.trim();
			if (!body) continue;
			await ctx.db.insert("comments", {
				documentId: args.documentId,
				authorUserId: AI_REVIEWER_AUTHOR_ID,
				authorName: `AI · ${aiModelLabel(AI_REVIEW_MODEL)}`,
				anchor: comment.anchor,
				body,
				resolved: false,
				createdAt: Date.now(),
			});
		}

		let branchId: Id<"reviewBranches"> | null = null;
		if (
			args.branchMarkdown !== undefined &&
			args.branchMarkdown !== args.sourceText
		) {
			if (utf8Length(args.branchMarkdown) > MAX_MARKDOWN_LENGTH) {
				throw new Error(MARKDOWN_TOO_LARGE_MESSAGE);
			}
			const now = Date.now();
			const priorOpen = await ctx.db
				.query("reviewBranches")
				.withIndex("by_document_reviewer", (q) =>
					q
						.eq("documentId", args.documentId)
						.eq("reviewerUserId", AI_REVIEWER_AUTHOR_ID),
				)
				.filter((q) => q.eq(q.field("status"), "open"))
				.take(101);
			if (priorOpen.length > 100) {
				throw new Error("Too many open AI review branches.");
			}
			for (const branch of priorOpen) {
				await ctx.db.patch(branch._id, { status: "rejected", updatedAt: now });
			}
			const newNodeId = crypto.randomUUID();
			const patch = JSON.stringify({
				from: 0,
				to: args.sourceText.length,
				insert: args.branchMarkdown,
			});
			const nodeRowId = await ctx.db.insert("docNodes", {
				documentId: args.documentId,
				nodeId: newNodeId,
				parentNodeId: args.sourceNodeId,
				patch,
				snapshot: args.branchMarkdown,
				selection: null,
				origin: `${AI_REVIEW_ORIGIN_PREFIX}${AI_REVIEW_MODEL}`,
				createdAt: now,
			});
			await syncBlobReferences(ctx, doc.userId, "node", nodeRowId, [
				patch,
				args.branchMarkdown,
			]);
			branchId = await ctx.db.insert("reviewBranches", {
				documentId: args.documentId,
				reviewerUserId: AI_REVIEWER_AUTHOR_ID,
				baseNodeId: args.sourceNodeId,
				headNodeId: newNodeId,
				status: "open",
				createdAt: now,
				updatedAt: now,
			});
		}
		return { commentsPlaced: args.comments.length, branchId };
	},
});

/**
 * Owner-only. Materialize the branch head and the owner's current node so
 * the review surface can word-diff them (branch-head vs. live-current).
 */
export const getBranchDiff = query({
	args: {
		documentId: v.id("documents"),
		branchId: v.id("reviewBranches"),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		const branch = await ctx.db.get(args.branchId);
		if (!branch || branch.documentId !== args.documentId) {
			throw new Error("Branch not found");
		}

		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const nodes = rows.map(toServerNode);

		const branchMarkdown = materialize(branch.headNodeId, nodes);
		const currentMarkdown = materialize(doc.currentNodeId, nodes);
		return { branchMarkdown, currentMarkdown };
	},
});

/**
 * Owner-only ACCEPT — additive merge forward, mirroring versions.restore.
 * Materialize the branch head, append a NEW node parented at the owner's CURRENT
 * tip (so concurrent owner edits are preserved), write that markdown, advance
 * currentNodeId. Old history is untouched. Marks the branch "accepted".
 */
export const acceptBranch = mutation({
	args: {
		documentId: v.id("documents"),
		branchId: v.id("reviewBranches"),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		const branch = await ctx.db.get(args.branchId);
		if (!branch || branch.documentId !== args.documentId) {
			throw new Error("Branch not found");
		}

		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const nodes = rows.map(toServerNode);

		const markdown = materialize(branch.headNodeId, nodes);
		const parentNodeId = doc.currentNodeId;
		const parentMarkdown = materialize(parentNodeId, nodes);
		const newNodeId = crypto.randomUUID();
		const now = Date.now();

		const nodeRowId = await ctx.db.insert("docNodes", {
			documentId: args.documentId,
			nodeId: newNodeId,
			parentNodeId,
			patch: JSON.stringify({
				from: 0,
				to: parentMarkdown.length,
				insert: markdown,
			}),
			snapshot: markdown,
			selection: null,
			origin: "review-accept",
			createdAt: now,
		});
		await syncBlobReferences(ctx, doc.userId, "node", nodeRowId, [
			JSON.stringify({
				from: 0,
				to: parentMarkdown.length,
				insert: markdown,
			}),
			markdown,
		]);

		await ctx.db.patch(args.documentId, {
			currentNodeId: newNodeId,
			markdown,
			wordCount: roughWordCount(markdown),
			updatedAt: now,
			// A pointer move: bump the revision so a client holding the pre-accept
			// revision cannot pass the CAS and overwrite the accepted head, and
			// stamp the body as the materialization of the new head.
			pointerRevision: (doc.pointerRevision ?? 0) + 1,
			markdownHeadNodeId: newNodeId,
		});
		await syncBlobReferences(ctx, doc.userId, "document", args.documentId, [
			markdown,
		]);

		await ctx.db.patch(branch._id, { status: "accepted", updatedAt: now });
		return { newNodeId, markdown };
	},
});

const diffGranularityValidator = v.union(v.literal("word"), v.literal("line"));

/**
 * Owner-only PARTIAL ACCEPT — accept a SUBSET of a branch's diff hunks.
 *
 * Same additive-merge-forward shape as {@link acceptBranch}, but instead of taking
 * the branch head verbatim it reconstructs a partial-merge markdown: it recomputes
 * the `current → branch-head` word/line diff SERVER-SIDE (the SAME `diff` package
 * the review surface renders with) and applies ONLY the hunks in `acceptedHunks`
 * (by stable hunk index). Accepted hunks take the branch's proposed text; every
 * other hunk keeps the owner's current text (the change is discarded). The result
 * is appended as a NEW node parented at the owner's CURRENT tip (preserving any
 * concurrent owner edits) and the documents row is advanced — identical isolation
 * + additive-history guarantees to acceptBranch.
 *
 * SERVER-AUTHORITATIVE: the client sends only hunk INDICES (+ the granularity it
 * displayed), never markdown — the server is the sole writer of merged text into
 * the owner's doc, so a malicious/buggy client can't splice arbitrary content.
 *
 * RESOLUTION SEMANTICS (documented design choice): a partial accept RESOLVES the
 * whole branch — accepted hunks merge forward, every un-accepted hunk is discarded,
 * and the branch is marked `accepted` (it leaves the review surface). This mirrors
 * the existing one-shot accept/reject lifecycle and avoids a "branch stays half
 * open against a moved target" state that would need continuous re-diffing. To
 * apply more of a reviewer's edits later, re-share / re-run the reviewer.
 *
 * Per-edit AI suggestions (Phase B) ride this for free: each AI `quote→replacement`
 * lands at a distinct location, so the branch diff surfaces each as its own hunk —
 * the owner accepts/rejects each AI edit independently via `acceptedHunks`.
 *
 * Edge case: an empty `acceptedHunks` (reject everything) is a valid no-merge that
 * still resolves the branch — equivalent to rejectBranch but recorded as accepted-
 * of-nothing. The reconstructed markdown then equals the owner's current text and
 * the documents row is left untouched (no spurious new node / version churn).
 */
export const acceptHunks = mutation({
	args: {
		documentId: v.id("documents"),
		branchId: v.id("reviewBranches"),
		granularity: diffGranularityValidator,
		/** Stable hunk indices to accept (see history.groupHunks). */
		acceptedHunks: v.array(v.number()),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		const branch = await ctx.db.get(args.branchId);
		if (!branch || branch.documentId !== args.documentId) {
			throw new Error("Branch not found");
		}

		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const nodes = rows.map(toServerNode);

		const branchMarkdown = materialize(branch.headNodeId, nodes);
		const parentNodeId = doc.currentNodeId;
		const parentMarkdown = materialize(parentNodeId, nodes);

		// Recompute the diff the owner reviewed (current → branch) at the same
		// granularity, then merge ONLY the accepted hunks. Server is the sole author
		// of the merged text (data safety) — the client supplied no markdown.
		const granularity: DiffGranularity = args.granularity;
		const runs = diffRuns(parentMarkdown, branchMarkdown, granularity);
		const hunks = groupHunks(runs);
		const hunkCount = hunks.length;

		// Reject silently-stale selections: an index out of range means the client's
		// diff drifted from the server's (a concurrent owner edit re-shaped the diff).
		// Fail closed rather than apply the wrong hunk.
		for (const idx of args.acceptedHunks) {
			if (!Number.isInteger(idx) || idx < 0 || idx >= hunkCount) {
				throw new Error(
					"Stale hunk selection — reopen the diff and try again.",
				);
			}
		}

		const merged = applyAcceptedHunks(runs, args.acceptedHunks);

		// Same ~1 MiB cap as every other write into the owner's doc.
		if (utf8Length(merged) > MAX_MARKDOWN_LENGTH) {
			throw new Error(MARKDOWN_TOO_LARGE_MESSAGE);
		}

		const now = Date.now();

		// Nothing actually merged (rejected everything, or the accepted hunks net to
		// the current text) → don't churn a new node; just resolve the branch. This
		// keeps the documents row + history untouched, mirroring rejectBranch's
		// no-op-on-data guarantee.
		if (merged === parentMarkdown) {
			await ctx.db.patch(branch._id, { status: "accepted", updatedAt: now });
			return {
				newNodeId: null,
				markdown: parentMarkdown,
				acceptedCount: args.acceptedHunks.length,
				hunkCount,
			};
		}

		const newNodeId = crypto.randomUUID();
		const nodeRowId = await ctx.db.insert("docNodes", {
			documentId: args.documentId,
			nodeId: newNodeId,
			parentNodeId,
			patch: JSON.stringify({
				from: 0,
				to: parentMarkdown.length,
				insert: merged,
			}),
			snapshot: merged,
			selection: null,
			origin: "review-accept",
			createdAt: now,
		});
		await syncBlobReferences(ctx, doc.userId, "node", nodeRowId, [
			JSON.stringify({
				from: 0,
				to: parentMarkdown.length,
				insert: merged,
			}),
			merged,
		]);

		await ctx.db.patch(args.documentId, {
			currentNodeId: newNodeId,
			markdown: merged,
			wordCount: roughWordCount(merged),
			updatedAt: now,
			pointerRevision: (doc.pointerRevision ?? 0) + 1,
			markdownHeadNodeId: newNodeId,
		});
		await syncBlobReferences(ctx, doc.userId, "document", args.documentId, [
			merged,
		]);

		await ctx.db.patch(branch._id, { status: "accepted", updatedAt: now });
		return {
			newNodeId,
			markdown: merged,
			acceptedCount: args.acceptedHunks.length,
			hunkCount,
		};
	},
});

/**
 * Owner-only REJECT — status flag only, NO node deletion. The retention
 * cron (convex/retention.ts, plan 014) finishes the job once the branch has
 * been closed past the 30-day window: the abandoned branch nodes are pruned and
 * this `reviewBranches` row is GC'd.
 */
export const rejectBranch = mutation({
	args: {
		documentId: v.id("documents"),
		branchId: v.id("reviewBranches"),
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const branch = await ctx.db.get(args.branchId);
		if (!branch || branch.documentId !== args.documentId) {
			throw new Error("Branch not found");
		}
		await ctx.db.patch(branch._id, {
			status: "rejected",
			updatedAt: Date.now(),
		});
		return { rejected: true };
	},
});

// ---------------------------------------------------------------------------
// Phase C — reviewer editing session + owner review surface
// ---------------------------------------------------------------------------

/**
 * Read a shared document FOR A GRANTEE (access ≥ commenter). `documents.get` is
 * owner-only and returns null for a reviewer, so this is the reviewer-side seed
 * source: it materializes the owner's CURRENT node and returns the title +
 * markdown + the base nodeId the reviewer branch will fork from.
 *
 * READ-ONLY: this only resolves the share (lazy granteeUserId binding happens on
 * the first reviewerAppend mutation) and never writes the documents row. The
 * reviewer editor seeds ONCE from this; it must NOT bind its live value to this
 * reactive query (plan 010 "editor owns live state").
 */
export const getReviewerDocument = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		const { doc } = await requireDocumentAccess(
			ctx,
			args.documentId,
			"commenter",
		);
		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const nodes = rows.map(toServerNode);
		let markdown = doc.markdown;
		// Prefer the materialized current node (canonical) but fall back to the
		// stored markdown if the node graph can't be walked (legacy/edge).
		try {
			markdown = materialize(doc.currentNodeId, nodes);
		} catch {
			markdown = doc.markdown;
		}
		return {
			title: doc.title,
			markdown,
			baseNodeId: doc.currentNodeId,
		};
	},
});

/**
 * Owner-only: open review branches for a document, enriched for the review
 * surface — each row carries the latest reviewer node count and the reviewer's
 * display name (resolved from the matching share, falling back to the user id).
 * Only `status:"open"` branches are returned (accepted/rejected are hidden).
 */
export const listOpenBranches = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);

		const branches = await ctx.db
			.query("reviewBranches")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.filter((q) => q.eq(q.field("status"), "open"))
			.collect();
		if (branches.length === 0) return [];

		// Count this document's nodes per reviewer so the surface can show "N edits"
		// without materializing each branch up front. Human nodes carry origin
		// `review:<userId>`; AI nodes carry `ai:review:<model>` and are counted under
		// the synthetic AI reviewer id (plan 011).
		const nodes = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const countByReviewer = new Map<string, number>();
		let aiNodeCount = 0;
		for (const node of nodes) {
			if (node.origin.startsWith(AI_REVIEW_ORIGIN_PREFIX)) {
				aiNodeCount++;
			} else if (node.origin.startsWith("review:")) {
				const reviewer = node.origin.slice("review:".length);
				countByReviewer.set(reviewer, (countByReviewer.get(reviewer) ?? 0) + 1);
			}
		}
		countByReviewer.set(AI_REVIEWER_AUTHOR_ID, aiNodeCount);

		// Resolve a friendly reviewer name from the share's invited email. The
		// synthetic AI reviewer has no Clerk user / share, so map its id to the AI
		// display name (mirrors AI_REVIEWER_AUTHOR_NAME in lib/ai/review.ts).
		const shares = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const nameByUser = new Map<string, string>();
		nameByUser.set(
			AI_REVIEWER_AUTHOR_ID,
			`AI · ${aiModelLabel(AI_REVIEW_MODEL)}`,
		);
		for (const share of shares) {
			if (share.granteeUserId) {
				nameByUser.set(share.granteeUserId, share.granteeEmail);
			}
		}

		branches.sort((a, b) => b.updatedAt - a.updatedAt);
		return branches.map((branch) => ({
			_id: branch._id,
			reviewerUserId: branch.reviewerUserId,
			reviewerName:
				nameByUser.get(branch.reviewerUserId) ?? branch.reviewerUserId,
			baseNodeId: branch.baseNodeId,
			headNodeId: branch.headNodeId,
			nodeCount: countByReviewer.get(branch.reviewerUserId) ?? 0,
			createdAt: branch.createdAt,
			updatedAt: branch.updatedAt,
		}));
	},
});

/**
 * Owner-only: whether a document the owner owns has any OPEN review branches —
 * the cheap gate the studio reads to show a subtle "has feedback" indicator and
 * to gate the "Open review surface" action. Returns 0 for a doc with no open
 * branches (or one the caller doesn't own — same null-safe shape as the owner
 * branch listing, but a non-owner simply gets a thrown access error upstream so
 * this is only ever called for owned docs).
 */
export const openBranchCount = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const branches = await ctx.db
			.query("reviewBranches")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.filter((q) => q.eq(q.field("status"), "open"))
			.collect();
		return branches.length;
	},
});

// ---------------------------------------------------------------------------
// Phase B — comments (anchored, cross-lens, threaded, resolvable)
// ---------------------------------------------------------------------------

const anchorValidator = v.object({
	quote: v.string(),
	prefix: v.string(),
	suffix: v.string(),
	offsetHint: v.number(),
});

/**
 * Add an anchored comment. The CALLER must have at least `commenter` access
 * (owner / suggester pass too). PROGRAMMATIC author seam for plan 011 (cross-cutting
 * rule b): the *attributed* author is separate from the *caller*.
 *
 * - Human path: omit `author` → the comment is attributed to the caller, with a
 *   display name from the Clerk identity (name → email → "Reviewer").
 * - AI / owner-attributed path: pass `author: { authorName, authorId }` to attribute
 *   the comment to a non-caller (e.g. a synthetic AI reviewer `"AI · <model>"`).
 *   This override is **owner-only** — a reviewer cannot spoof another author, but the
 *   owner (and plan 011's AI path, which runs as the owner over their own un-shared
 *   doc) can. Authorization (≥ commenter) still gates the caller regardless.
 */
export const addComment = mutation({
	args: {
		documentId: v.id("documents"),
		anchor: anchorValidator,
		body: v.string(),
		threadParentId: v.optional(v.id("comments")),
		// Optional explicit author override — honored ONLY when the caller is the
		// document owner (the programmatic AI-reviewer seam for plan 011).
		author: v.optional(
			v.object({ authorName: v.string(), authorId: v.string() }),
		),
	},
	handler: async (ctx, args) => {
		const { role, userId } = await requireDocumentAccess(
			ctx,
			args.documentId,
			"commenter",
		);

		const body = args.body.trim();
		if (!body) throw new Error("A comment body is required.");

		const identity = await ctx.auth.getUserIdentity();
		const callerName =
			(identity?.name as string | undefined) ?? identity?.email ?? "Reviewer";

		// Attribute to the caller by default; honor an explicit override ONLY for the
		// owner so a reviewer can never spoof another author.
		let authorUserId = userId;
		let authorName = callerName;
		if (args.author) {
			if (role !== "owner") {
				throw new Error(
					"Only the document owner can attribute a comment to another author.",
				);
			}
			authorUserId = args.author.authorId;
			authorName = args.author.authorName;
		}

		// A reply must belong to the same document and be a top-level comment (one
		// level of threading — replies-to-replies collapse onto the root thread).
		if (args.threadParentId) {
			const parent = await ctx.db.get(args.threadParentId);
			if (!parent || parent.documentId !== args.documentId) {
				throw new Error("Parent comment not found");
			}
			if (parent.threadParentId) {
				throw new Error("Cannot reply to a reply");
			}
		}

		const commentId = await ctx.db.insert("comments", {
			documentId: args.documentId,
			authorUserId,
			authorName,
			anchor: args.anchor,
			body,
			threadParentId: args.threadParentId,
			resolved: false,
			createdAt: Date.now(),
		});
		return { commentId };
	},
});

/** List a document's comments (oldest first). Access ≥ commenter. */
export const listComments = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		const { userId } = await requireDocumentAccess(
			ctx,
			args.documentId,
			"commenter",
		);
		const rows = await ctx.db
			.query("comments")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const visible = [];
		for (const row of rows) {
			if (!(await usersAreBlocked(ctx, userId, row.authorUserId))) {
				visible.push(row);
			}
		}
		visible.sort((a, b) => a.createdAt - b.createdAt);
		return visible.map((c) => ({
			_id: c._id,
			authorUserId: c.authorUserId,
			authorName: c.authorName,
			anchor: c.anchor,
			body: c.body,
			threadParentId: c.threadParentId,
			resolved: c.resolved,
			createdAt: c.createdAt,
		}));
	},
});

export const reportComment = mutation({
	args: { commentId: v.id("comments"), reason: v.string() },
	handler: async (ctx, args) => {
		const comment = await ctx.db.get(args.commentId);
		if (!comment) throw new Error("Comment not found");
		const { userId } = await requireDocumentAccess(
			ctx,
			comment.documentId,
			"commenter",
		);
		if (comment.authorUserId === userId) {
			throw new Error("You cannot report your own comment.");
		}
		const reason = args.reason.trim();
		if (!reason || reason.length > 2_000) {
			throw new Error("A report reason is required.");
		}
		const existing = await ctx.db
			.query("commentReports")
			.withIndex("by_comment_reporter", (q) =>
				q.eq("commentId", args.commentId).eq("reporterUserId", userId),
			)
			.unique();
		if (existing) return { reportId: existing._id, duplicate: true as const };
		const reportId = await ctx.db.insert("commentReports", {
			commentId: args.commentId,
			documentId: comment.documentId,
			reporterUserId: userId,
			reportedUserId: comment.authorUserId,
			reason,
			status: "open",
			createdAt: Date.now(),
		});
		return { reportId, duplicate: false as const };
	},
});

const BLOCKED_SHARE_CLEANUP_BATCH = 128;

export const cleanupBlockedShares = internalMutation({
	args: { blockerUserId: v.string(), blockedUserId: v.string() },
	handler: async (ctx, args) => {
		const block = await ctx.db
			.query("userBlocks")
			.withIndex("by_blocker_blocked", (q) =>
				q
					.eq("blockerUserId", args.blockerUserId)
					.eq("blockedUserId", args.blockedUserId),
			)
			.unique();
		if (!block) return { revoked: 0, complete: true as const };
		const [blockedAsGrantee, blockerAsGrantee] = await Promise.all([
			ctx.db
				.query("documentShares")
				.withIndex("by_owner_grantee_user", (q) =>
					q
						.eq("ownerUserId", args.blockerUserId)
						.eq("granteeUserId", args.blockedUserId),
				)
				.take(BLOCKED_SHARE_CLEANUP_BATCH + 1),
			ctx.db
				.query("documentShares")
				.withIndex("by_owner_grantee_user", (q) =>
					q
						.eq("ownerUserId", args.blockedUserId)
						.eq("granteeUserId", args.blockerUserId),
				)
				.take(BLOCKED_SHARE_CLEANUP_BATCH + 1),
		]);
		const shares = [
			...blockedAsGrantee.slice(0, BLOCKED_SHARE_CLEANUP_BATCH),
			...blockerAsGrantee.slice(0, BLOCKED_SHARE_CLEANUP_BATCH),
		];
		for (const share of shares) await ctx.db.delete(share._id);
		const complete =
			blockedAsGrantee.length <= BLOCKED_SHARE_CLEANUP_BATCH &&
			blockerAsGrantee.length <= BLOCKED_SHARE_CLEANUP_BATCH;
		if (!complete) {
			await ctx.scheduler.runAfter(
				0,
				internal.review.cleanupBlockedShares,
				args,
			);
		}
		return { revoked: shares.length, complete };
	},
});

export const blockUser = mutation({
	args: { userId: v.string() },
	handler: async (ctx, args) => {
		const blockerUserId = await requireUserId(ctx);
		const blockedUserId = args.userId.trim();
		if (
			!blockedUserId ||
			blockedUserId === blockerUserId ||
			blockedUserId === AI_REVIEWER_AUTHOR_ID
		) {
			throw new Error("Invalid user to block.");
		}
		const existing = await ctx.db
			.query("userBlocks")
			.withIndex("by_blocker_blocked", (q) =>
				q.eq("blockerUserId", blockerUserId).eq("blockedUserId", blockedUserId),
			)
			.unique();
		if (!existing) {
			await ctx.db.insert("userBlocks", {
				blockerUserId,
				blockedUserId,
				createdAt: Date.now(),
			});
		}
		await ctx.scheduler.runAfter(0, internal.review.cleanupBlockedShares, {
			blockerUserId,
			blockedUserId,
		});
		return { blocked: true as const };
	},
});

/**
 * Resolve or unresolve a comment. Allowed for the comment's AUTHOR or the document
 * OWNER (any other grantee is rejected). Resolving the thread root resolves the
 * whole thread implicitly via the panel's grouping — replies keep their own flag.
 */
export const setCommentResolved = mutation({
	args: { commentId: v.id("comments"), resolved: v.boolean() },
	handler: async (ctx, args) => {
		const comment = await ctx.db.get(args.commentId);
		if (!comment) throw new Error("Comment not found");
		const { role, userId } = await requireDocumentAccess(
			ctx,
			comment.documentId,
			"commenter",
		);
		if (comment.authorUserId !== userId && role !== "owner") {
			throw new Error("Only the author or the document owner can do that.");
		}
		await ctx.db.patch(args.commentId, { resolved: args.resolved });
		return { resolved: args.resolved };
	},
});

/**
 * Delete a comment. Allowed for the comment's AUTHOR or the document OWNER. When a
 * thread root is deleted, its replies are deleted too (no dangling threads).
 */
export const removeComment = mutation({
	args: { commentId: v.id("comments") },
	handler: async (ctx, args) => {
		const comment = await ctx.db.get(args.commentId);
		if (!comment) throw new Error("Comment not found");
		const { role, userId } = await requireDocumentAccess(
			ctx,
			comment.documentId,
			"commenter",
		);
		if (comment.authorUserId !== userId && role !== "owner") {
			throw new Error("Only the author or the document owner can do that.");
		}

		// Cascade replies when deleting a thread root.
		if (!comment.threadParentId) {
			const replies = await ctx.db
				.query("comments")
				.withIndex("by_document", (q) => q.eq("documentId", comment.documentId))
				.filter((q) => q.eq(q.field("threadParentId"), args.commentId))
				.collect();
			for (const reply of replies) await ctx.db.delete(reply._id);
		}

		await ctx.db.delete(args.commentId);
		return { removed: true };
	},
});
