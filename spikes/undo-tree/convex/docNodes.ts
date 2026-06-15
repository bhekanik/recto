import { v } from "convex/values";
import { applyPatch } from "../src/patch.ts";
import { mutation, query } from "./_generated/server";

type DocNodeRow = {
	nodeId: string;
	parentNodeId: string | null;
	patch: string;
	snapshot?: string;
};

type DbCtx = {
	db: {
		query: (table: "docNodes") => {
			withIndex: (
				name: string,
				fn: (q: { eq: (field: string, value: string) => unknown }) => unknown,
			) => { collect: () => Promise<DocNodeRow[]> };
		};
		get: (id: string) => Promise<{
			currentNodeId: string;
			markdown: string;
			updatedAt: number;
		} | null>;
		insert: (
			table: "docNodes",
			doc: Record<string, unknown>,
		) => Promise<string>;
		patch: (id: string, fields: Record<string, unknown>) => Promise<void>;
	};
};

/** Walk chain and replay patches from nearest snapshot. */
function materializeFromNodes(
	targetNodeId: string,
	nodes: DocNodeRow[],
): string {
	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	const chain: DocNodeRow[] = [];
	let current = byId.get(targetNodeId);
	if (!current) throw new Error(`Unknown node: ${targetNodeId}`);

	while (current) {
		chain.unshift(current);
		if (
			current.snapshot != null &&
			current.parentNodeId != null &&
			chain.length > 1
		) {
			break;
		}
		if (current.parentNodeId == null) break;
		current = byId.get(current.parentNodeId);
	}

	let root = chain[0];
	while (root && root.snapshot == null && root.parentNodeId != null) {
		const parent = byId.get(root.parentNodeId);
		if (!parent) break;
		chain.unshift(parent);
		root = parent;
	}

	const snapshotNode = chain.find((n) => n.snapshot != null) ?? chain[0];
	if (!snapshotNode) throw new Error("Empty chain");

	let markdown = snapshotNode.snapshot ?? "";
	const startIdx = chain.indexOf(snapshotNode);

	for (let i = startIdx + 1; i < chain.length; i++) {
		const node = chain[i];
		if (!node) continue;
		markdown = applyPatch(markdown, node.patch);
	}

	return markdown;
}

async function loadNodes(ctx: DbCtx, documentId: string) {
	return await ctx.db
		.query("docNodes")
		.withIndex("by_document", (q) => q.eq("documentId", documentId))
		.collect();
}

/** Append-only node insert — idempotent on (documentId, nodeId). */
export const append = mutation({
	args: {
		documentId: v.id("documents"),
		nodeId: v.string(),
		parentNodeId: v.union(v.string(), v.null()),
		patch: v.string(),
		snapshot: v.optional(v.string()),
		selection: v.union(
			v.object({ anchor: v.number(), head: v.number() }),
			v.null(),
		),
		origin: v.string(),
		createdAt: v.number(),
	},
	handler: async (ctx, args) => {
		const dbCtx = ctx as unknown as DbCtx;
		const documentId = args.documentId as string;
		const nodes = await loadNodes(dbCtx, documentId);
		const existing = nodes.find((n) => n.nodeId === args.nodeId);

		if (existing) return { nodeId: args.nodeId, duplicate: true };

		await dbCtx.db.insert("docNodes", {
			documentId,
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

/** List all nodes for a document (union-merge verification). */
export const listByDocument = query({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		return await loadNodes(ctx as unknown as DbCtx, args.documentId as string);
	},
});

/** Materialize markdown at a node — replay from nearest snapshot. */
export const materializeAt = query({
	args: {
		documentId: v.id("documents"),
		nodeId: v.string(),
	},
	handler: async (ctx, args) => {
		const nodes = await loadNodes(
			ctx as unknown as DbCtx,
			args.documentId as string,
		);
		const markdown = materializeFromNodes(args.nodeId, nodes);
		return { nodeId: args.nodeId, markdown };
	},
});

/** Stub additive restore — fork forward by appending chosen state. */
export const restoreForkForward = mutation({
	args: {
		documentId: v.id("documents"),
		sourceNodeId: v.string(),
		origin: v.string(),
	},
	handler: async (ctx, args) => {
		const dbCtx = ctx as unknown as DbCtx;
		const documentId = args.documentId as string;
		const nodes = await loadNodes(dbCtx, documentId);
		const doc = await dbCtx.db.get(documentId);
		if (!doc) throw new Error("Document not found");

		const markdown = materializeFromNodes(args.sourceNodeId, nodes);
		const parentNodeId = doc.currentNodeId;
		const parentMaterialized = materializeFromNodes(parentNodeId, nodes);
		const newNodeId = crypto.randomUUID();
		const now = Date.now();
		const patch = JSON.stringify({
			from: 0,
			to: parentMaterialized.length,
			insert: markdown,
		});

		await dbCtx.db.insert("docNodes", {
			documentId,
			nodeId: newNodeId,
			parentNodeId,
			patch,
			selection: null,
			origin: args.origin,
			createdAt: now,
		});

		await dbCtx.db.patch(documentId, {
			currentNodeId: newNodeId,
			markdown,
			updatedAt: now,
		});

		return { newNodeId, markdown };
	},
});
