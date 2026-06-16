import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireOwnedDocument } from "./documents";
import { materialize, type ServerNode } from "./history";

const kindValidator = v.union(v.literal("auto"), v.literal("manual"));

function toServerNode(row: Doc<"docNodes">): ServerNode {
	return {
		nodeId: row.nodeId,
		parentNodeId: row.parentNodeId,
		patch: row.patch,
		snapshot: row.snapshot,
	};
}

/** Rough word count for the restore write; the client recomputes precisely. */
function roughWordCount(markdown: string): number {
	const trimmed = markdown.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Tag a node (auto or manual). Pins the node against retention pruning. */
export const create = mutation({
	args: {
		documentId: v.id("documents"),
		nodeId: v.string(),
		label: v.string(),
		kind: kindValidator,
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const versionId = await ctx.db.insert("versions", {
			documentId: args.documentId,
			nodeId: args.nodeId,
			label: args.label.trim() || "Untitled version",
			kind: args.kind,
			createdAt: Date.now(),
		});
		return { versionId };
	},
});

/** List tagged versions, newest first. */
export const list = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const rows = await ctx.db
			.query("versions")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.order("desc")
			.collect();
		return rows.map((row) => ({
			_id: row._id,
			nodeId: row.nodeId,
			label: row.label,
			kind: row.kind,
			createdAt: row.createdAt,
		}));
	},
});

/**
 * Additive restore (D9, blueprint 08 §2): materialize the version's node, append
 * a NEW node whose parent is the CURRENT tip (fork forward), write that markdown,
 * and advance currentNodeId. Old history is untouched — restore never rewinds.
 */
export const restore = mutation({
	args: {
		documentId: v.id("documents"),
		versionId: v.id("versions"),
		origin: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		const version = await ctx.db.get(args.versionId);
		if (!version || version.documentId !== args.documentId) {
			throw new Error("Version not found");
		}

		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		const nodes = rows.map(toServerNode);

		const markdown = materialize(version.nodeId, nodes);
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
			// Snapshot the restored state — a restore is a large jump, so bound replay.
			snapshot: markdown,
			selection: null,
			origin: args.origin ?? "restore",
			createdAt: now,
		});

		await ctx.db.patch(args.documentId, {
			currentNodeId: newNodeId,
			markdown,
			wordCount: roughWordCount(markdown),
			updatedAt: now,
		});

		return { newNodeId, markdown };
	},
});

/** Untag a version. Removes only the versions row — the docNodes node remains. */
export const remove = mutation({
	args: { documentId: v.id("documents"), versionId: v.id("versions") },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const version = await ctx.db.get(args.versionId);
		if (version && version.documentId === args.documentId) {
			await ctx.db.delete(args.versionId);
		}
	},
});

/** Rename a manual version's label in place (the only in-place version mutation). */
export const rename = mutation({
	args: {
		documentId: v.id("documents"),
		versionId: v.id("versions"),
		label: v.string(),
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const version = await ctx.db.get(args.versionId);
		if (version && version.documentId === args.documentId) {
			await ctx.db.patch(args.versionId, {
				label: args.label.trim() || version.label,
			});
		}
	},
});
