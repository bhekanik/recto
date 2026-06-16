import { applyPatch } from "./patch";

export type DocNodeSelection = { anchor: number; head: number } | null;

/** A materializable undo-tree node (mirrors the docNodes row shape). */
export type DocNode = {
	nodeId: string;
	parentNodeId: string | null;
	patch: string;
	snapshot?: string;
	selection?: DocNodeSelection;
	origin?: string;
	createdAt?: number;
};

/**
 * Reconstruct the canonical Markdown at a node: walk up to the nearest ancestor
 * carrying a `snapshot` (the root always has one, so this terminates), then
 * replay each `patch` forward down to the target (blueprint 03 §4.3, 07 §5.1).
 */
export function materialize(
	targetNodeId: string,
	nodesById: Map<string, DocNode>,
): string {
	const chain: DocNode[] = [];
	let current = nodesById.get(targetNodeId);
	if (!current) throw new Error(`Unknown node: ${targetNodeId}`);

	while (current) {
		chain.unshift(current);
		if (current.snapshot != null) break; // reached a snapshot base
		if (current.parentNodeId == null) break; // reached root
		current = nodesById.get(current.parentNodeId);
	}

	const base = chain[0];
	if (!base) throw new Error("Empty materialization chain");

	let markdown = base.snapshot ?? "";
	for (let i = 1; i < chain.length; i++) {
		const node = chain[i];
		if (node) markdown = applyPatch(markdown, node.patch);
	}
	return markdown;
}

/** Build a nodeId → node map from a flat node list. */
export function indexNodes(nodes: DocNode[]): Map<string, DocNode> {
	return new Map(nodes.map((n) => [n.nodeId, n]));
}

/**
 * Union-merge two append-only node sets by nodeId. Because nodes are immutable
 * and ULID-keyed, this is a conflict-free set union (blueprint 07 §7, ADR-10).
 */
export function unionMerge(a: DocNode[], b: DocNode[]): DocNode[] {
	const map = new Map<string, DocNode>();
	for (const node of [...a, ...b]) map.set(node.nodeId, node);
	return [...map.values()];
}

/** Children adjacency (parentNodeId → child nodeIds), for the visualizer tree. */
export function childrenByParent(
	nodes: DocNode[],
): Map<string | null, string[]> {
	const map = new Map<string | null, string[]>();
	const sorted = [...nodes].sort(
		(a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
	);
	for (const node of sorted) {
		const list = map.get(node.parentNodeId) ?? [];
		list.push(node.nodeId);
		map.set(node.parentNodeId, list);
	}
	return map;
}

/** The set of nodeIds on the path from root to the given node (the live spine). */
export function ancestorChain(
	nodeId: string,
	nodesById: Map<string, DocNode>,
): Set<string> {
	const chain = new Set<string>();
	let current: DocNode | undefined = nodesById.get(nodeId);
	while (current) {
		chain.add(current.nodeId);
		if (current.parentNodeId == null) break;
		current = nodesById.get(current.parentNodeId);
	}
	return chain;
}

/** Distance (depth) of a node from the root, for indentation in the tree view. */
export function depthOf(
	nodeId: string,
	nodesById: Map<string, DocNode>,
): number {
	let depth = 0;
	let current = nodesById.get(nodeId);
	while (current?.parentNodeId != null) {
		depth += 1;
		current = nodesById.get(current.parentNodeId);
	}
	return depth;
}
