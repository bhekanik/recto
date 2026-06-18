import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireOwnedDocument } from "./documents";
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
