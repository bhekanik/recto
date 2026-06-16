/** Compact text patch: a single contiguous replace relative to parent markdown. */
export type TextPatch = {
	from: number;
	to: number;
	insert: string;
};

/** Encode a patch as a JSON string for docNodes.patch storage. */
export function encodePatch(patch: TextPatch): string {
	return JSON.stringify(patch);
}

/** Decode the docNodes.patch field. */
export function decodePatch(raw: string): TextPatch {
	return JSON.parse(raw) as TextPatch;
}

/** Apply a patch to a parent's materialized markdown; returns the child markdown. */
export function applyPatch(parentMarkdown: string, patchRaw: string): string {
	const { from, to, insert } = decodePatch(patchRaw);
	return parentMarkdown.slice(0, from) + insert + parentMarkdown.slice(to);
}

/**
 * Compute the minimal contiguous patch of `next` relative to `parent`
 * (longest common prefix/suffix trim). The contract: applyPatch(parent,
 * encodePatch(computePatch(parent, next))) === next, exactly (blueprint 03 §4.2).
 */
export function computePatch(
	parentMarkdown: string,
	nextMarkdown: string,
): TextPatch {
	let start = 0;
	const max = Math.min(parentMarkdown.length, nextMarkdown.length);
	while (
		start < max &&
		parentMarkdown.charCodeAt(start) === nextMarkdown.charCodeAt(start)
	) {
		start++;
	}
	let endPrev = parentMarkdown.length;
	let endNext = nextMarkdown.length;
	while (
		endPrev > start &&
		endNext > start &&
		parentMarkdown.charCodeAt(endPrev - 1) ===
			nextMarkdown.charCodeAt(endNext - 1)
	) {
		endPrev--;
		endNext--;
	}
	return {
		from: start,
		to: endPrev,
		insert: nextMarkdown.slice(start, endNext),
	};
}

/**
 * Snapshot cadence: a full Markdown snapshot is stored on the root node and
 * every Nth node along a branch, bounding materialization replay length
 * (blueprint 03 §4.2, ADR-16 tuned the spike to 5; production uses a larger
 * cadence to keep snapshot storage modest for article-length documents).
 */
export const SNAPSHOT_EVERY_N = 50;
