/** Minimal contiguous change via longest common prefix/suffix trim. */
export function diffRanges(
	prev: string,
	next: string,
): { from: number; to: number; insert: string } {
	let start = 0;
	const max = Math.min(prev.length, next.length);
	while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) {
		start++;
	}

	let endPrev = prev.length;
	let endNext = next.length;
	while (
		endPrev > start &&
		endNext > start &&
		prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
	) {
		endPrev--;
		endNext--;
	}

	return { from: start, to: endPrev, insert: next.slice(start, endNext) };
}
