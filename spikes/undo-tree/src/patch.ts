/** Compact text patch: single contiguous replace relative to parent markdown. */
export type TextPatch = {
	from: number;
	to: number;
	insert: string;
};

/** Encode patch as JSON string for docNodes.patch storage. */
export function encodePatch(patch: TextPatch): string {
	return JSON.stringify(patch);
}

/** Decode docNodes.patch field. */
export function decodePatch(raw: string): TextPatch {
	return JSON.parse(raw) as TextPatch;
}

/** Apply a patch to parent materialized markdown; returns child markdown. */
export function applyPatch(parentMarkdown: string, patchRaw: string): string {
	const { from, to, insert } = decodePatch(patchRaw);
	return parentMarkdown.slice(0, from) + insert + parentMarkdown.slice(to);
}

/** Compute patch of `next` relative to `parent`. */
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

/** Snapshot cadence for spike B (every N nodes along a branch). */
export const SNAPSHOT_EVERY_N = 5;
