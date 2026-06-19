import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

type QueryCtx = GenericQueryCtx<import("./_generated/dataModel").DataModel>;
type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

/**
 * Max stored markdown/snapshot length, guarding the Convex ~1 MiB per-value
 * ceiling (blueprint 03 §5). Book-length manuscripts are an explicit non-goal;
 * fail loudly rather than let Convex reject the whole mutation opaquely. Shared
 * by documents.updateMarkdown and review.ts (suggester/AI branch writes).
 */
export const MAX_MARKDOWN_LENGTH = 950_000;
export const MARKDOWN_TOO_LARGE_MESSAGE =
	"Document exceeds the ~1 MiB size limit; split it into multiple documents.";

/** Resolve the authenticated Clerk user id (JWT subject) or throw. */
export async function requireUserId(
	ctx: QueryCtx | MutationCtx,
): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error("Unauthenticated");
	}
	return identity.subject;
}

/** Assert document belongs to caller. */
export async function requireOwnedDocument(
	ctx: QueryCtx | MutationCtx,
	documentId: Id<"documents">,
): Promise<Doc<"documents">> {
	const userId = await requireUserId(ctx);
	const doc = await ctx.db.get(documentId);
	if (!doc || doc.userId !== userId) {
		throw new Error("Document not found");
	}
	return doc;
}

/** List documents for the authenticated user (metadata only). */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const rows = await ctx.db
			.query("documents")
			.withIndex("by_user_updated", (q) => q.eq("userId", userId))
			.order("desc")
			.collect();

		return rows.map((row) => ({
			_id: row._id,
			title: row.title,
			wordCount: row.wordCount,
			updatedAt: row.updatedAt,
		}));
	},
});

/** Get one document including markdown body. */
export const get = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const doc = await ctx.db.get(args.documentId);
		if (!doc || doc.userId !== userId) return null;

		return {
			_id: doc._id,
			title: doc.title,
			markdown: doc.markdown,
			wordCount: doc.wordCount,
			currentNodeId: doc.currentNodeId,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
		};
	},
});

/** Create a new document and its root undo-tree node, in one transaction. */
export const create = mutation({
	args: { title: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const now = Date.now();
		const rootNodeId = crypto.randomUUID();
		const title = args.title?.trim() || "Untitled";

		const documentId = await ctx.db.insert("documents", {
			userId,
			title,
			markdown: "",
			wordCount: 0,
			currentNodeId: rootNodeId,
			createdAt: now,
			updatedAt: now,
		});

		// Root node: full snapshot (empty), no parent (blueprint 03 §3.1, 07 §3.2).
		await ctx.db.insert("docNodes", {
			documentId,
			nodeId: rootNodeId,
			parentNodeId: null,
			patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
			snapshot: "",
			selection: null,
			origin: "server",
			createdAt: now,
		});

		return { documentId, rootNodeId };
	},
});

/**
 * Delete a document and cascade-delete everything keyed by_document: history
 * (docNodes + versions) plus the review collaboration rows (documentShares +
 * reviewBranches + comments, plan 010). Each lives in separate rows indexed
 * by_document, deleted in batches to respect the per-transaction write ceiling
 * (blueprint 03 §5).
 */
export const remove = mutation({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);

		const nodes = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		for (const node of nodes) await ctx.db.delete(node._id);

		const versions = await ctx.db
			.query("versions")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		for (const version of versions) await ctx.db.delete(version._id);

		const shares = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		for (const share of shares) await ctx.db.delete(share._id);

		const branches = await ctx.db
			.query("reviewBranches")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		for (const branch of branches) await ctx.db.delete(branch._id);

		const comments = await ctx.db
			.query("comments")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		for (const comment of comments) await ctx.db.delete(comment._id);

		await ctx.db.delete(args.documentId);
	},
});

/**
 * Move the undo-tree pointer (last-write-wins by updatedAt). The materialized
 * markdown for the target node is written alongside so an idle reader hydrates
 * the right text (blueprint 07 §5, 03 §3.1; ADR-10 LWW pointer).
 */
export const updateCurrentNodeId = mutation({
	args: {
		documentId: v.id("documents"),
		currentNodeId: v.string(),
		markdown: v.string(),
		wordCount: v.number(),
		updatedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		// Same ~1 MiB guard as updateMarkdown — the materialized markdown is stored
		// on the documents row here too. (Node-existence of currentNodeId is NOT
		// checked: the client appends the node fire-and-forget and writes this
		// pointer on a debounce, so a strict check would race a legitimate write.)
		if (args.markdown.length > MAX_MARKDOWN_LENGTH) {
			throw new Error(MARKDOWN_TOO_LARGE_MESSAGE);
		}

		if (args.updatedAt < doc.updatedAt) {
			return { applied: false, currentNodeId: doc.currentNodeId };
		}
		const updatedAt = Date.now();
		await ctx.db.patch(args.documentId, {
			currentNodeId: args.currentNodeId,
			markdown: args.markdown,
			wordCount: args.wordCount,
			updatedAt,
		});
		return { applied: true, currentNodeId: args.currentNodeId, updatedAt };
	},
});

/** Rename a document title. */
export const rename = mutation({
	args: {
		documentId: v.id("documents"),
		title: v.string(),
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		await ctx.db.patch(args.documentId, {
			title: args.title.trim() || "Untitled",
			updatedAt: Date.now(),
		});
	},
});

/** Debounced autosave with stale-version guard. */
export const updateMarkdown = mutation({
	args: {
		documentId: v.id("documents"),
		markdown: v.string(),
		wordCount: v.number(),
		expectedUpdatedAt: v.number(),
		title: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);

		// Guard the Convex ~1 MiB per-value ceiling (blueprint 03 §5). Book-length
		// manuscripts are an explicit non-goal; fail loudly rather than let Convex
		// reject the whole mutation opaquely. The editor keeps the text locally.
		if (args.markdown.length > MAX_MARKDOWN_LENGTH) {
			throw new Error(MARKDOWN_TOO_LARGE_MESSAGE);
		}

		if (doc.updatedAt !== args.expectedUpdatedAt) {
			return { updatedAt: doc.updatedAt, stale: true };
		}

		const updatedAt = Date.now();
		const patch: {
			markdown: string;
			wordCount: number;
			updatedAt: number;
			title?: string;
		} = {
			markdown: args.markdown,
			wordCount: args.wordCount,
			updatedAt,
		};
		if (args.title !== undefined) {
			patch.title = args.title.trim() || "Untitled";
		}

		await ctx.db.patch(args.documentId, patch);

		return { updatedAt, stale: false };
	},
});
