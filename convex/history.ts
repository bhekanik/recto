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

/** A decoded, validated contiguous text patch. */
export type TextPatch = { from: number; to: number; insert: string };

/**
 * Parse + validate a `docNodes.patch` string against a parent's materialized
 * markdown. Returns the decoded patch, or `null` if it is malformed: not valid
 * JSON, missing/non-integer `from`/`to`, `insert` not a string, or `from`/`to`
 * out of range for `parentLength` (must satisfy 0 ≤ from ≤ to ≤ parentLength).
 *
 * Used at the WRITE boundary (review.reviewerAppend) to reject bad patches before
 * they land in the owner's node graph, and by applyPatch for defensive read-time
 * parsing of any pre-existing malformed row.
 */
export function parsePatch(
	patchRaw: string,
	parentLength: number,
): TextPatch | null {
	let decoded: unknown;
	try {
		decoded = JSON.parse(patchRaw);
	} catch {
		return null;
	}
	if (typeof decoded !== "object" || decoded === null) return null;
	const { from, to, insert } = decoded as Record<string, unknown>;
	if (typeof from !== "number" || !Number.isInteger(from)) return null;
	if (typeof to !== "number" || !Number.isInteger(to)) return null;
	if (typeof insert !== "string") return null;
	if (from < 0 || to < from || to > parentLength) return null;
	return { from, to, insert };
}

/** Apply a contiguous text patch to a parent's materialized markdown. */
export function applyPatch(parentMarkdown: string, patchRaw: string): string {
	// Validate against the parent so a malformed/out-of-range patch throws a clean
	// error rather than an opaque JSON SyntaxError or a silently wrong slice. This
	// is defensive: review.reviewerAppend already rejects bad patches at write time,
	// so a valid node graph never reaches the throw.
	const patch = parsePatch(patchRaw, parentMarkdown.length);
	if (!patch) throw new Error("Malformed patch");
	return (
		parentMarkdown.slice(0, patch.from) +
		patch.insert +
		parentMarkdown.slice(patch.to)
	);
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
