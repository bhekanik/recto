import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwnedDocument } from "./documents";

const kindValidator = v.union(v.literal("auto"), v.literal("manual"));

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

		// Tag must point at a node that exists in THIS document — a phantom nodeId
		// would later break materialization ("Unknown node"). Safe to check: the
		// client tags currentNodeId on a long debounce / a navigated (existing)
		// node, so the appending write has long since landed.
		const node = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.nodeId),
			)
			.unique();
		if (!node) throw new Error("Node not found");

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
