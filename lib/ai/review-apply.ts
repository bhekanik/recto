/**
 * Pure edit application for the AI reviewer (plan 011, Phase B). Turns the AI's
 * resolved `quote → replacement` suggestions into a new markdown string that
 * becomes the AI suggestion BRANCH head — the owner reviews the branch's
 * word-level diff and accepts/rejects it in plan 010's review surface, exactly
 * like a human reviewer's branch.
 *
 * Anchoring reuses plan 010's `locateAnchor` verbatim (the SAME locator humans'
 * comments + suggestions use). The load-bearing contracts:
 *   - Unlocatable edits are DROPPED and COUNTED, never mis-applied.
 *   - Overlapping edits never both apply — the later (by start offset) overlapping
 *     edit is DROPPED and COUNTED.
 *   - Surviving edits are spliced RIGHT-TO-LEFT (descending start offset) so each
 *     splice never invalidates an earlier offset.
 * Pure + thoroughly unit-tested (lib/ai/review-apply.test.ts).
 */

import { type CommentAnchor, locateAnchor } from "@/lib/review/anchor";

/** An edit whose anchor was located in the markdown, ready to splice. */
export type ResolvedEdit = {
	/** Inclusive start offset of the span to replace. */
	from: number;
	/** Exclusive end offset of the span to replace. */
	to: number;
	/** The text spliced in over `[from, to)`. */
	replacement: string;
};

/**
 * Resolve one suggestion's anchor against `markdown` via plan 010's `locateAnchor`.
 * Returns the located span + replacement, or `null` when the quote can't be
 * relocated with confidence (the caller counts these as dropped — never applied).
 */
export function resolveEdit(
	markdown: string,
	anchor: CommentAnchor,
	replacement: string,
): ResolvedEdit | null {
	const range = locateAnchor(markdown, anchor);
	if (!range) return null;
	return { from: range.from, to: range.to, replacement };
}

/** Two half-open ranges overlap when each starts before the other ends. */
function overlaps(a: ResolvedEdit, b: ResolvedEdit): boolean {
	return a.from < b.to && b.from < a.to;
}

/**
 * Apply a batch of AI suggestions to `markdown`, resolving each anchor via
 * `resolveEdit` (→ `locateAnchor`). Drops + counts unlocatable AND overlapping
 * edits; applies the survivors right-to-left so earlier offsets stay valid.
 *
 * @returns the new markdown + how many edits were `applied` and `dropped`.
 * Pure — no I/O, no Convex, no clock.
 */
export function applyEdits(
	markdown: string,
	edits: { anchor: CommentAnchor; replacement: string }[],
): { markdown: string; applied: number; dropped: number } {
	let dropped = 0;

	// 1. Resolve each edit; an unlocatable anchor is dropped (and counted).
	const resolved: ResolvedEdit[] = [];
	for (const edit of edits) {
		const r = resolveEdit(markdown, edit.anchor, edit.replacement);
		if (!r) {
			dropped++;
			continue;
		}
		resolved.push(r);
	}

	// 2. Walk by start offset; drop any edit overlapping an already-kept edit so
	//    ambiguous/overlapping edits are never both applied.
	resolved.sort((a, b) => a.from - b.from || a.to - b.to);
	const kept: ResolvedEdit[] = [];
	for (const edit of resolved) {
		if (kept.some((k) => overlaps(k, edit))) {
			dropped++;
			continue;
		}
		kept.push(edit);
	}

	// 3. Splice right-to-left (descending start) so each splice leaves the offsets
	//    of the not-yet-applied (earlier) edits untouched.
	let result = markdown;
	for (let i = kept.length - 1; i >= 0; i--) {
		const edit = kept[i];
		if (!edit) continue;
		result =
			result.slice(0, edit.from) + edit.replacement + result.slice(edit.to);
	}

	return { markdown: result, applied: kept.length, dropped };
}
