import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { authComponent } from "./auth";

type QueryCtx = GenericQueryCtx<import("./_generated/dataModel").DataModel>;
type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

/** Resolve authenticated user id or throw. */
async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
	const user = await authComponent.getAuthUser(ctx);
	if (!user) {
		throw new Error("Unauthenticated");
	}
	return user._id;
}

/** Assert document belongs to caller. */
async function requireOwnedDocument(
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

/** Create a new document scoped to the authenticated user. */
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

		return { documentId, rootNodeId };
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
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);

		if (doc.updatedAt !== args.expectedUpdatedAt) {
			return { updatedAt: doc.updatedAt, stale: true };
		}

		const updatedAt = Date.now();
		await ctx.db.patch(args.documentId, {
			markdown: args.markdown,
			wordCount: args.wordCount,
			updatedAt,
		});

		return { updatedAt, stale: false };
	},
});
