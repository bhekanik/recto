import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { removeBlobReferences } from "./blobReferences";

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

/**
 * Keep: spine + tagged-chains + protected-chains + recent + ancestors-of-kept
 * (blueprint 07 §8). `protectedNodeIds` are open review-branch heads/bases
 * (plan 014) — an open branch is a reviewer's un-actioned work, so its full
 * ancestor chain is kept exactly like a tagged version's.
 */
function computeKeepSet(
	nodes: Node[],
	currentNodeId: string,
	taggedNodeIds: Set<string>,
	protectedNodeIds: Set<string>,
	now: number,
): Set<string> {
	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	const keep = new Set<string>();

	for (const id of ancestorChain(currentNodeId, byId)) keep.add(id);
	for (const tag of taggedNodeIds) {
		if (byId.has(tag)) for (const id of ancestorChain(tag, byId)) keep.add(id);
	}
	for (const pid of protectedNodeIds) {
		if (byId.has(pid)) for (const id of ancestorChain(pid, byId)) keep.add(id);
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
 * the live spine, every tagged node, every OPEN review branch, and everything
 * recent. Append-only-safe: it only deletes whole abandoned subtrees, never
 * rewrites a surviving node, and never orphans a snapshot a survivor depends on
 * (ancestor chains are kept).
 *
 * Review-branch lifecycle (plan 014):
 * - OPEN branches are protected — their head + base ancestor chains join the
 *   keep-set, so a reviewer's un-actioned work survives however idle it is.
 * - CLOSED (accepted/rejected) `reviewBranches` rows are GC'd once `updatedAt`
 *   ages past the retention window. Their nodes carry no protection (rejected
 *   nodes never had any; accepted content lives on the owner's spine via the
 *   review-accept merge node), so the node prune below reclaims the abandoned
 *   subtree naturally.
 */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const docs = await ctx.db.query("documents").collect();
		let pruned = 0;
		let prunedBranchRows = 0;

		for (const doc of docs) {
			const branches = await ctx.db
				.query("reviewBranches")
				.withIndex("by_document", (q) => q.eq("documentId", doc._id))
				.collect();

			// GC closed branch rows older than the retention window.
			for (const branch of branches) {
				if (
					branch.status !== "open" &&
					branch.updatedAt < now - RETENTION_WINDOW_MS
				) {
					await ctx.db.delete(branch._id);
					prunedBranchRows += 1;
				}
			}

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

			// Protect open branches. The head's ancestor chain normally covers the
			// base (branches grow by appending children from the base), but the write
			// path (review.reviewerAppend) only validates that a node's parent EXISTS
			// in the document — it doesn't enforce descent from the base — so protect
			// the base chain too rather than trust the client.
			const protectedNodeIds = new Set<string>();
			for (const branch of branches) {
				if (branch.status === "open") {
					protectedNodeIds.add(branch.headNodeId);
					protectedNodeIds.add(branch.baseNodeId);
				}
			}

			const keep = computeKeepSet(
				nodes,
				doc.currentNodeId,
				tagged,
				protectedNodeIds,
				now,
			);
			for (const node of nodes) {
				if (!keep.has(node.nodeId)) {
					await removeBlobReferences(ctx, "node", node._id);
					await ctx.db.delete(node._id);
					pruned += 1;
				}
			}
		}

		return { pruned, prunedBranchRows };
	},
});
