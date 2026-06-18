import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireOwnedDocument, requireUserId } from "./documents";
import { materialize, type ServerNode } from "./history";

type QueryCtx = GenericQueryCtx<import("./_generated/dataModel").DataModel>;
type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

const selectionValidator = v.union(
	v.object({ anchor: v.number(), head: v.number() }),
	v.null(),
);

/** Role rank for access comparisons. Owner outranks all grantees. */
const ROLE_RANK = { commenter: 1, suggester: 2, owner: 3 } as const;
type AccessRole = keyof typeof ROLE_RANK;
type GranteeRole = "commenter" | "suggester";

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
			return {
				role: "owner" as const,
				shareCount: shares.length,
				shared: shares.length > 0,
			};
		}

		// Grantee? Resolve via user id, then email (read-only — no lazy patch here).
		let share = await ctx.db
			.query("documentShares")
			.withIndex("by_grantee_user", (q) => q.eq("granteeUserId", userId))
			.filter((q) => q.eq(q.field("documentId"), args.documentId))
			.unique();
		if (!share && email) {
			share = await ctx.db
				.query("documentShares")
				.withIndex("by_grantee_email", (q) => q.eq("granteeEmail", email))
				.filter((q) => q.eq(q.field("documentId"), args.documentId))
				.unique();
		}
		if (!share) return null;
		return { role: share.role, shareCount: 1, shared: true };
	},
});

/**
 * SPIKE: reviewer suggestion append. APPEND-ONLY, access-gated at "suggester".
 * Inserts an immutable docNode (idempotent on (documentId, nodeId), origin
 * `review:<reviewerUserId>`) and opens-or-advances the caller's reviewBranches
 * row. NEVER patches the documents row — this is the isolation boundary that
 * keeps the owner's markdown / currentNodeId untouched (plan 010 SPIKE #4).
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
		const existing = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.nodeId),
			)
			.unique();
		if (!existing) {
			await ctx.db.insert("docNodes", {
				documentId: args.documentId,
				nodeId: args.nodeId,
				parentNodeId: args.parentNodeId,
				patch: args.patch,
				snapshot: args.snapshot,
				selection: args.selection,
				origin: `review:${userId}`,
				createdAt: args.createdAt,
			});
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

		if (branch) {
			await ctx.db.patch(branch._id, {
				headNodeId: args.nodeId,
				updatedAt: now,
			});
			return { nodeId: args.nodeId, branchId: branch._id };
		}

		const branchId = await ctx.db.insert("reviewBranches", {
			documentId: args.documentId,
			reviewerUserId: userId,
			baseNodeId: doc.currentNodeId,
			headNodeId: args.nodeId,
			status: "open",
			createdAt: now,
			updatedAt: now,
		});
		return { nodeId: args.nodeId, branchId };
	},
});

/**
 * SPIKE: owner-only. Materialize the branch head and the owner's current node so
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
 * SPIKE: owner-only ACCEPT — additive merge forward, mirroring versions.restore.
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

		await ctx.db.insert("docNodes", {
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

		await ctx.db.patch(args.documentId, {
			currentNodeId: newNodeId,
			markdown,
			wordCount: roughWordCount(markdown),
			updatedAt: now,
		});

		await ctx.db.patch(branch._id, { status: "accepted", updatedAt: now });
		return { newNodeId, markdown };
	},
});

/**
 * SPIKE: owner-only REJECT — status flag only, NO node deletion. The abandoned
 * branch subtree is pruned later by the retention cron (plan 010).
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
