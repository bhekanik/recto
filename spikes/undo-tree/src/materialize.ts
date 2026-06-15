import { applyPatch } from "./patch.ts";

export type DocNode = {
	nodeId: string;
	parentNodeId: string | null;
	patch: string;
	snapshot?: string;
};

/** Walk to nearest snapshot ancestor, replay patches forward to target. */
export function materialize(
	targetNodeId: string,
	nodesById: Map<string, DocNode>,
): string {
	const chain: DocNode[] = [];
	let current = nodesById.get(targetNodeId);
	if (!current) throw new Error(`Unknown node: ${targetNodeId}`);

	while (current) {
		chain.unshift(current);
		if (current.snapshot != null && current.parentNodeId == null) break;
		if (current.snapshot != null && chain.length > 1) break;
		if (current.parentNodeId == null) break;
		current = nodesById.get(current.parentNodeId);
	}

	// Walk up further until we hit a snapshot if the chain root has no snapshot.
	let root = chain[0];
	while (root && root.snapshot == null && root.parentNodeId != null) {
		const parent = nodesById.get(root.parentNodeId);
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

/** Build node map from flat node list. */
export function indexNodes(nodes: DocNode[]): Map<string, DocNode> {
	return new Map(nodes.map((n) => [n.nodeId, n]));
}

/** Union-merge two node sets by nodeId (immutable append-only). */
export function unionMerge(a: DocNode[], b: DocNode[]): DocNode[] {
	const map = new Map<string, DocNode>();
	for (const node of [...a, ...b]) {
		map.set(node.nodeId, node);
	}
	return [...map.values()];
}
