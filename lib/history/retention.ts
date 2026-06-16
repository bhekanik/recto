import { ancestorChain, type DocNode, indexNodes } from "./materialize";

/** Default recency window for retention — generous, so normal use never prunes. */
export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The set of nodeIds to KEEP (blueprint 07 §8, 03 §6). A node is kept if ANY of:
 *  1. it is on the live spine (currentNodeId or an ancestor of it),
 *  2. it is tagged by a version (or an ancestor of a tagged node),
 *  3. it is recent (within the recency window),
 *  4. it is an ancestor of any kept node (so its snapshot chain stays intact).
 * Everything else is a deep, abandoned branch — safe to prune as whole subtrees.
 */
export function computeKeepSet(
	nodes: DocNode[],
	currentNodeId: string,
	taggedNodeIds: Iterable<string>,
	now: number,
	retentionMs: number = RETENTION_WINDOW_MS,
): Set<string> {
	const byId = indexNodes(nodes);
	const keep = new Set<string>();

	// Live spine.
	for (const id of ancestorChain(currentNodeId, byId)) keep.add(id);

	// Tagged nodes and their ancestor chains.
	for (const tag of taggedNodeIds) {
		if (byId.has(tag)) for (const id of ancestorChain(tag, byId)) keep.add(id);
	}

	// Recent nodes.
	for (const node of nodes) {
		if ((node.createdAt ?? 0) >= now - retentionMs) keep.add(node.nodeId);
	}

	// Ancestors of every kept node (materialization chain integrity).
	for (const id of [...keep]) {
		for (const ancestorId of ancestorChain(id, byId)) keep.add(ancestorId);
	}

	return keep;
}

/** NodeIds eligible for pruning (the complement of the keep-set). */
export function computePrunable(
	nodes: DocNode[],
	currentNodeId: string,
	taggedNodeIds: Iterable<string>,
	now: number,
	retentionMs: number = RETENTION_WINDOW_MS,
): Set<string> {
	const keep = computeKeepSet(
		nodes,
		currentNodeId,
		taggedNodeIds,
		now,
		retentionMs,
	);
	return new Set(nodes.map((n) => n.nodeId).filter((id) => !keep.has(id)));
}
