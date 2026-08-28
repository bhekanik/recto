/**
 * Grapheme-cluster boundaries, in UTF-16 code-unit offsets.
 *
 * The vim core clips positions to *code points*, which is not what a reader
 * means by "a character". Left alone that severs anything built from several
 * code points, silently — `NSTextStorage` stores the wreckage without
 * complaint.
 *
 * ## Why `Intl.Segmenter` and nothing else
 *
 * This used to wrap `@marijn/find-cluster-break`, the implementation
 * CodeMirror 6 uses. That was a mistake: it implements Extend, ZWJ and
 * regional indicators, and **not** Hangul jamo sequences, SpacingMark, Prepend
 * or CRLF. `가` (U+1100 U+1161) is one cluster and it reported two, so `x` on
 * `a가b` produced `aᅡb`; `का` and `\r\n` split the same way.
 *
 * `Intl.Segmenter` is ICU's own implementation of UAX #29, present in a bare
 * `JSContext` on macOS 26 and iOS 26 (asserted by `build.ts`'s DOM-free gate,
 * by the JSC parity runner, and on the simulator). There is deliberately **no
 * fallback**: a partial one silently corrupts text, which is the bug being
 * fixed here, and a hand-rolled complete table would be a second UAX #29
 * implementation to keep in step with the ICU one Swift uses on the other side
 * of the bridge. Both sides are gated against Unicode's own
 * `GraphemeBreakTest.txt` instead, which is what makes "they agree" a claim
 * rather than a hope.
 *
 * ## Cost
 *
 * `Segments.containing()` is random access — 2,000 lookups near the end of a
 * 900 kB string are unmeasurable — but *constructing* the `Segments` object is
 * not (0.16 ms each). One keystroke asks several times, so the object is cached
 * against the string it was built from. The cache is a single slot: the text
 * changes rarely relative to how often it is read, and a slot costs nothing to
 * check.
 */

const segmenter =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter("und", { granularity: "grapheme" })
		: null;

if (!segmenter) {
	throw new Error(
		"recto-vim: Intl.Segmenter is required for grapheme clustering and is missing from this JS realm",
	);
}

/** @type {{text: string, segments: Intl.Segments} | null} */
let cache = null;

/** @param {string} text */
function segmentsFor(text) {
	if (cache?.text === text) return cache.segments;
	const segments = segmenter.segment(text);
	cache = { text, segments };
	return segments;
}

/**
 * The cluster containing `offset`, or null when the offset is outside the text.
 *
 * **Never ask `containing()` about a high surrogate.** JavaScriptCore (and Bun)
 * answer inconsistently with their own iteration there: on `a🎩b`, iterating
 * gives segments at [0,1) [1,3) [3,4), but `containing(1)` — the high surrogate
 * of the hat — returns `{index: 0, length: 3}`. Asking about the low surrogate
 * instead returns `{index: 1, length: 2}`, which is right, and every offset
 * inside a cluster resolves to the same cluster anyway. Iterating instead would
 * be correct but costs a full segmentation per keystroke on a large document,
 * where this is a lookup.
 *
 * @param {string} text @param {number} offset
 */
function clusterAt(text, offset) {
	if (offset < 0 || offset >= text.length) return null;
	const unit = text.charCodeAt(offset);
	const probe =
		unit >= 0xd800 && unit <= 0xdbff && offset + 1 < text.length
			? offset + 1
			: offset;
	return segmentsFor(text).containing(probe);
}

/**
 * The start of the grapheme cluster containing `offset`, or `offset` itself
 * when it already sits on a boundary.
 *
 * @param {string} text @param {number} offset @returns {number}
 */
export function clusterStart(text, offset) {
	if (offset <= 0) return 0;
	if (offset >= text.length) return text.length;
	return clusterAt(text, offset)?.index ?? offset;
}

/**
 * The end of the grapheme cluster containing `offset`, or `offset` itself when
 * it already sits on a boundary.
 *
 * @param {string} text @param {number} offset @returns {number}
 */
export function clusterEnd(text, offset) {
	if (offset <= 0) return 0;
	if (offset >= text.length) return text.length;
	const found = clusterAt(text, offset);
	if (!found) return offset;
	return found.index === offset ? offset : found.index + found.segment.length;
}

/**
 * One cluster forward from `offset`. Past the end of the string it keeps
 * counting, because the core's motions produce out-of-range positions on
 * purpose (`3l` on a two-character line) and clamp them afterwards.
 *
 * @param {string} text @param {number} offset @returns {number}
 */
export function nextCluster(text, offset) {
	if (offset < 0) return offset + 1;
	if (offset >= text.length) return offset + 1;
	const found = clusterAt(text, offset);
	if (!found) return offset + 1;
	return found.index + found.segment.length;
}

/**
 * One cluster backward from `offset`. Symmetrically, keeps counting below zero.
 *
 * @param {string} text @param {number} offset @returns {number}
 */
export function previousCluster(text, offset) {
	if (offset <= 0) return offset - 1;
	if (offset > text.length) return offset - 1;
	const start = clusterStart(text, offset);
	if (start < offset) return start;
	// `offset` was already a boundary, so step into the cluster before it.
	return clusterAt(text, offset - 1)?.index ?? offset - 1;
}

/**
 * Every cluster boundary in `text`, ascending, including 0 and `text.length`.
 * Used by the conformance suite and by `r`, which rewrites cluster by cluster.
 *
 * @param {string} text @returns {number[]}
 */
export function clusterBoundaries(text) {
	const boundaries = [0];
	for (const { index, segment } of segmentsFor(text)) {
		boundaries.push(index + segment.length);
	}
	return boundaries;
}

/**
 * The one range that turns `before` into `after`, widened to whole clusters.
 *
 * An input method rewrites its own text and hands back only the result, so the
 * mirror has to work out what changed before it can record it as an edit. A raw
 * code-unit diff is not enough: `🎩` and `🎪` share a high surrogate, so the
 * naive range is half a surrogate pair, and `e` → `é` in NFD would record the
 * combining mark on its own rather than the cluster it belongs to. Both ends are
 * therefore pulled back to an offset that is a boundary in *both* strings, which
 * is what keeps a composed change the same shape as a typed one.
 *
 * @param {string} before @param {string} after
 * @returns {{from: number, to: number, insert: string}}
 */
export function clusterAlignedDiff(before, after) {
	const shortest = Math.min(before.length, after.length);
	let from = 0;
	while (
		from < shortest &&
		before.charCodeAt(from) === after.charCodeAt(from)
	) {
		from++;
	}
	let tail = 0;
	while (
		tail < shortest - from &&
		before.charCodeAt(before.length - 1 - tail) ===
			after.charCodeAt(after.length - 1 - tail)
	) {
		tail++;
	}
	const isBoundary = (text, offset) => clusterStart(text, offset) === offset;
	while (from > 0 && (!isBoundary(before, from) || !isBoundary(after, from))) {
		from--;
	}
	while (
		tail > 0 &&
		(!isBoundary(before, before.length - tail) ||
			!isBoundary(after, after.length - tail))
	) {
		tail--;
	}
	return {
		from,
		to: before.length - tail,
		insert: after.slice(from, after.length - tail),
	};
}
