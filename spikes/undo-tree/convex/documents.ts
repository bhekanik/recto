import { v } from "convex/values";
import { mutation } from "./_generated/server";

/** Create throwaway document with root node. */
export const createDocument = mutation({
	args: { markdown: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const markdown = args.markdown ?? "";
		const now = Date.now();
		const rootNodeId = crypto.randomUUID();

		const documentId = await ctx.db.insert("documents", {
			markdown,
			currentNodeId: rootNodeId,
			updatedAt: now,
		});

		await ctx.db.insert("docNodes", {
			documentId,
			nodeId: rootNodeId,
			parentNodeId: null,
			patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
			snapshot: markdown,
			selection: null,
			origin: "spike-server",
			createdAt: now,
		});

		return { documentId, rootNodeId };
	},
});

/** LWW pointer write — reconciled by updatedAt. */
export const updateCurrentNodeId = mutation({
	args: {
		documentId: v.id("documents"),
		currentNodeId: v.string(),
		updatedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const doc = await ctx.db.get(args.documentId);
		if (!doc) throw new Error("Document not found");

		if (args.updatedAt >= doc.updatedAt) {
			await ctx.db.patch(args.documentId, {
				currentNodeId: args.currentNodeId,
				updatedAt: args.updatedAt,
			});
			return { applied: true, currentNodeId: args.currentNodeId };
		}

		return { applied: false, currentNodeId: doc.currentNodeId };
	},
});

/** Update markdown snapshot on document (spike helper). */
export const updateMarkdown = mutation({
	args: {
		documentId: v.id("documents"),
		markdown: v.string(),
		updatedAt: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.documentId, {
			markdown: args.markdown,
			updatedAt: args.updatedAt,
		});
	},
});
