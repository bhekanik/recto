/**
 * Grapheme-cluster boundaries, in UTF-16 code-unit offsets.
 *
 * The vim core clips positions to *code points* — that is upstream behaviour and
 * we do not patch upstream. On a ZWJ family, a flag, a skin-tone modifier or a
 * combining mark that means `x` deletes half a cluster and leaves the rest
 * behind: `a👨‍👩‍👧‍👦b` + `x` gives `a‍👩‍👧‍👦b`, and `NSTextStorage` stores the wreckage
 * without complaint. The N0c spike measured every one of those cases; N3
 * clamping is what makes them survive.
 *
 * `@marijn/find-cluster-break` is the UAX #29 implementation CodeMirror 6 itself
 * uses (`findClusterBreak` in `@codemirror/state` is a one-line re-export of it),
 * so the web lens and the native lens break clusters by identical rules. It is
 * 4 kB, has no dependencies and touches no host globals, which is what lets it
 * into a `JSContext` bundle.
 *
 * Everything here is deliberately *total*: an out-of-range offset clamps rather
 * than throws, because the core hands over `Number.MAX_VALUE` for "end of line"
 * as a matter of course.
 */

import { findClusterBreak } from "@marijn/find-cluster-break";

/**
 * The start of the grapheme cluster containing `offset`, or `offset` itself
 * when it already sits on a boundary.
 *
 * `findClusterBreak(..., false)` always moves back at least one position, so it
 * cannot answer "is this a boundary" on its own; stepping forward from the
 * boundary it returns and comparing does.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
export function clusterStart(text, offset) {
	if (offset <= 0) return 0;
	if (offset >= text.length) return text.length;
	const previous = findClusterBreak(text, offset, false);
	const endOfThatCluster = findClusterBreak(text, previous, true);
	return endOfThatCluster <= offset ? offset : previous;
}

/**
 * The end of the grapheme cluster containing `offset`, or `offset` itself when
 * it already sits on a boundary.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
export function clusterEnd(text, offset) {
	if (offset <= 0) return 0;
	if (offset >= text.length) return text.length;
	const start = clusterStart(text, offset);
	return start === offset ? offset : findClusterBreak(text, start, true);
}

/**
 * One cluster forward from `offset`. Past the end of the string it keeps
 * counting, because the core's motions produce out-of-range positions on
 * purpose (`3l` on a two-character line) and clamp them afterwards.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
export function nextCluster(text, offset) {
	if (offset >= text.length) return offset + 1;
	if (offset < 0) return offset + 1;
	return findClusterBreak(text, offset, true);
}

/**
 * One cluster backward from `offset`. Symmetrically, keeps counting below zero.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
export function previousCluster(text, offset) {
	if (offset <= 0) return offset - 1;
	if (offset > text.length) return offset - 1;
	return findClusterBreak(text, offset, false);
}
