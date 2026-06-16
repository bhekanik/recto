/**
 * Server-side undo-tree materialization (blueprint 03 §4.3, 07 §5.1). Kept
 * self-contained inside convex/ so the function bundle has no cross-directory
 * imports. Mirrors lib/history/{patch,materialize}.ts — both are pure.
 */

export type ServerNode = {
	nodeId: string;
	parentNodeId: string | null;
	patch: string;
	snapshot?: string;
};

/** Apply a contiguous text patch to a parent's materialized markdown. */
export function applyPatch(parentMarkdown: string, patchRaw: string): string {
	const { from, to, insert } = JSON.parse(patchRaw) as {
		from: number;
		to: number;
		insert: string;
	};
	return parentMarkdown.slice(0, from) + insert + parentMarkdown.slice(to);
}

/**
 * Reconstruct the canonical Markdown at a node: walk up to the nearest ancestor
 * with a snapshot (the root always has one), then replay patches forward.
 */
export function materialize(targetNodeId: string, nodes: ServerNode[]): string {
	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	const chain: ServerNode[] = [];
	let current = byId.get(targetNodeId);
	if (!current) throw new Error(`Unknown node: ${targetNodeId}`);

	while (current) {
		chain.unshift(current);
		if (current.snapshot != null) break;
		if (current.parentNodeId == null) break;
		current = byId.get(current.parentNodeId);
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
