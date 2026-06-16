import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — generous backstop

type Node = Pick<Doc<"docNodes">, "nodeId" | "parentNodeId" | "createdAt">;

/** NodeIds on the path from a node up to the root (inclusive). */
function ancestorChain(nodeId: string, byId: Map<string, Node>): Set<string> {
	const chain = new Set<string>();
	let current = byId.get(nodeId);
	while (current) {
		chain.add(current.nodeId);
		if (current.parentNodeId == null) break;
		current = byId.get(current.parentNodeId);
	}
	return chain;
}

/** Keep: spine + tagged-chains + recent + ancestors-of-kept (blueprint 07 §8). */
function computeKeepSet(
	nodes: Node[],
	currentNodeId: string,
	taggedNodeIds: Set<string>,
	now: number,
): Set<string> {
	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	const keep = new Set<string>();

	for (const id of ancestorChain(currentNodeId, byId)) keep.add(id);
	for (const tag of taggedNodeIds) {
		if (byId.has(tag)) for (const id of ancestorChain(tag, byId)) keep.add(id);
	}
	for (const node of nodes) {
		if (node.createdAt >= now - RETENTION_WINDOW_MS) keep.add(node.nodeId);
	}
	for (const id of [...keep]) {
		for (const ancestorId of ancestorChain(id, byId)) keep.add(ancestorId);
	}
	return keep;
}

/**
 * Scheduled retention sweep — prunes deep, abandoned, old branches while keeping
 * the live spine, every tagged node, and everything recent. Append-only-safe: it
 * only deletes whole abandoned subtrees, never rewrites a surviving node, and
 * never orphans a snapshot a survivor depends on (ancestor chains are kept).
 */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const docs = await ctx.db.query("documents").collect();
		let pruned = 0;

		for (const doc of docs) {
			const nodes = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", doc._id))
				.collect();
			if (nodes.length === 0) continue;

			const versions = await ctx.db
				.query("versions")
				.withIndex("by_document", (q) => q.eq("documentId", doc._id))
				.collect();
			const tagged = new Set(versions.map((v) => v.nodeId));

			const keep = computeKeepSet(nodes, doc.currentNodeId, tagged, now);
			for (const node of nodes) {
				if (!keep.has(node.nodeId)) {
					await ctx.db.delete(node._id);
					pruned += 1;
				}
			}
		}

		return { pruned };
	},
});
