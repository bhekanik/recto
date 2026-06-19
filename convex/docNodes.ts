import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireOwnedDocument } from "./documents";

const selectionValidator = v.union(
	v.object({ anchor: v.number(), head: v.number() }),
	v.null(),
);

/** Client-facing node shape (drops Convex `_id`/`_creationTime`/`documentId`). */
function toClientNode(row: Doc<"docNodes">) {
	return {
		nodeId: row.nodeId,
		parentNodeId: row.parentNodeId,
		patch: row.patch,
		snapshot: row.snapshot,
		selection: row.selection,
		origin: row.origin,
		createdAt: row.createdAt,
	};
}

/**
 * Append one immutable node. Idempotent on (documentId, nodeId): a retry or a
 * cross-device union re-send is a no-op; existing nodes are NEVER updated
 * (append-only, D8). Never writes currentNodeId — the pointer is a separate
 * write (documents.updateCurrentNodeId).
 */
export const append = mutation({
	args: {
		documentId: v.id("documents"),
		nodeId: v.string(),
		parentNodeId: v.union(v.string(), v.null()),
		patch: v.string(),
		snapshot: v.optional(v.string()),
		selection: selectionValidator,
		origin: v.string(),
		createdAt: v.number(),
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);

		const existing = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.nodeId),
			)
			.unique();
		if (existing) return { nodeId: args.nodeId, duplicate: true };

		await ctx.db.insert("docNodes", {
			documentId: args.documentId,
			nodeId: args.nodeId,
			parentNodeId: args.parentNodeId,
			patch: args.patch,
			snapshot: args.snapshot,
			selection: args.selection,
			origin: args.origin,
			createdAt: args.createdAt,
		});
		return { nodeId: args.nodeId, duplicate: false };
	},
});

/** DAG hydration + incremental cross-device union-merge (optional sinceCreatedAt). */
export const listSince = query({
	args: {
		documentId: v.id("documents"),
		sinceCreatedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const since = args.sinceCreatedAt;
		const filtered =
			since !== undefined ? rows.filter((r) => r.createdAt > since) : rows;
		return filtered.map(toClientNode);
	},
});

/**
 * Lazily create a root node for a legacy document that predates root-on-create
 * (ADR-17 #1): reuse its existing placeholder currentNodeId as the root nodeId
 * and snapshot its current markdown. Idempotent.
 */
export const ensureRoot = mutation({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		const existing = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.first();
		if (existing) return { created: false, rootNodeId: doc.currentNodeId };

		await ctx.db.insert("docNodes", {
			documentId: args.documentId,
			nodeId: doc.currentNodeId,
			parentNodeId: null,
			patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
			snapshot: doc.markdown,
			selection: null,
			origin: "server",
			createdAt: Date.now(),
		});
		return { created: true, rootNodeId: doc.currentNodeId };
	},
});
