/**
 * The patch-from-AI-result path (plan 009, Phase A). Pure: splices an AI-rewritten
 * span back into the full document. The grouping controller then turns the
 * returned document into an undo-tree node via `computePatch`, so an AI edit is a
 * child node — reversible by `undo()` — exactly like a hand edit.
 */

export type TransformRange = { from: number; to: number };

/**
 * Replace `doc[from..to)` with `aiText`. Throws on an invalid range so a bad
 * selection can never silently corrupt the document (the caller aborts).
 *
 * `applyTransform(doc, range, aiText) === doc.slice(0, from) + aiText + doc.slice(to)`
 */
export function applyTransform(
	doc: string,
	range: TransformRange,
	aiText: string,
): string {
	const { from, to } = range;
	if (!Number.isInteger(from) || !Number.isInteger(to)) {
		throw new Error("applyTransform: range bounds must be integers");
	}
	if (from < 0 || to > doc.length || from > to) {
		throw new Error(
			`applyTransform: range out of bounds (from=${from}, to=${to}, len=${doc.length})`,
		);
	}
	return doc.slice(0, from) + aiText + doc.slice(to);
}
