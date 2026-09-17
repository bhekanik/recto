import { diffWordsWithSpace, diffLines as jsDiffLines } from "diff";

export type DiffLine = { type: "add" | "del" | "same"; text: string };

/** One inline run in a token diff: added / deleted / unchanged text. */
export type DiffRun = { type: "add" | "del" | "same"; text: string };

/** Diff granularity the user can choose (mirrors a studio setting). */
export type DiffGranularity = "word" | "line";

/**
 * Token-level diff of two canonical-Markdown strings, producing inline
 * ins/del/same runs (blueprint 08 §5 — diff the source, not rendered HTML).
 * "word" uses jsdiff diffWordsWithSpace (whitespace preserved → prose-friendly);
 * "line" uses jsdiff diffLines. Read-only, pure.
 */
export function diffRuns(
	a: string,
	b: string,
	granularity: DiffGranularity = "word",
): DiffRun[] {
	const changes =
		granularity === "word" ? diffWordsWithSpace(a, b) : jsDiffLines(a, b);
	return changes.map((c) => ({
		type: c.added ? "add" : c.removed ? "del" : "same",
		text: c.value,
	}));
}

/**
 * One reviewable HUNK of a branch diff: a maximal group of consecutive non-`same`
 * runs (add/del), addressable by its stable `index` (the position of the hunk in
 * left-to-right order). `runIndices` are the positions of this hunk's runs in the
 * flat {@link DiffRun} array, so the renderer can mark exactly those runs selected.
 *
 * The grouping is DETERMINISTIC from the runs — the same (current, branch,
 * granularity) inputs always yield the same hunks. The server (convex/history.ts
 * `groupHunks`) computes the IDENTICAL grouping over runs from the SAME `diff`
 * package, so a hunk `index` the owner picks in the UI maps to the same hunk the
 * partial-accept mutation reconstructs (the contract that makes per-hunk accept
 * server-authoritative — the client never sends markdown, only hunk indices).
 */
export type DiffHunk = { index: number; runIndices: number[] };

/**
 * Group a flat run list into reviewable hunks: each maximal span of consecutive
 * non-`same` runs becomes one hunk. `same` runs are the unchanged context between
 * hunks and belong to no hunk. Pure; the ordering is the natural left-to-right run
 * order, so `index` is stable across client + server for identical inputs.
 */
export function groupHunks(runs: DiffRun[]): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let current: number[] | null = null;
	for (let i = 0; i < runs.length; i++) {
		const run = runs[i];
		if (!run) continue;
		if (run.type === "same") {
			if (current) {
				hunks.push({ index: hunks.length, runIndices: current });
				current = null;
			}
			continue;
		}
		if (!current) current = [];
		current.push(i);
	}
	if (current) hunks.push({ index: hunks.length, runIndices: current });
	return hunks;
}

/**
 * Reconstruct the partial-merge markdown when only `acceptedHunks` (by hunk index)
 * of the `current → branch` diff are accepted. Walks the runs left-to-right: `same`
 * text is always emitted; an accepted hunk emits its `add` side (the branch's
 * proposed text), a rejected hunk emits its `del` side (the current text, i.e. the
 * change is discarded). Pure — mirrored byte-for-byte by convex/history.ts so the
 * UI preview matches what the server writes.
 */
export function applyAcceptedHunks(
	runs: DiffRun[],
	acceptedHunks: Iterable<number>,
): string {
	const accepted = new Set(acceptedHunks);
	const hunks = groupHunks(runs);
	const acceptedRunIndices = new Set<number>();
	for (const hunk of hunks) {
		if (accepted.has(hunk.index)) {
			for (const ri of hunk.runIndices) acceptedRunIndices.add(ri);
		}
	}

	let out = "";
	for (let i = 0; i < runs.length; i++) {
		const run = runs[i];
		if (!run) continue;
		if (run.type === "same") {
			out += run.text;
			continue;
		}
		const inAcceptedHunk = acceptedRunIndices.has(i);
		// Accepted hunk → take the branch (add) side; rejected hunk → keep current
		// (del) side. A run that belongs to no accepted hunk contributes its del text
		// (and accepted add runs contribute their add text).
		if (inAcceptedHunk) {
			if (run.type === "add") out += run.text;
			// accepted del runs are dropped (the deletion is applied)
		} else {
			if (run.type === "del") out += run.text;
			// rejected add runs are dropped (the addition is discarded)
		}
	}
	return out;
}

/**
 * A minimal LCS line diff of two canonical-Markdown strings (blueprint 08 §5 —
 * compare diffs the source, not rendered HTML). Read-only.
 */
export function diffLines(a: string, b: string): DiffLine[] {
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	const m = aLines.length;
	const n = bLines.length;

	// dp[i][j] = LCS length of aLines[i:] and bLines[j:].
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			const row = dp[i];
			const nextRow = dp[i + 1];
			if (!row || !nextRow) continue;
			row[j] =
				aLines[i] === bLines[j]
					? (nextRow[j + 1] ?? 0) + 1
					: Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
		}
	}

	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (aLines[i] === bLines[j]) {
			out.push({ type: "same", text: aLines[i] ?? "" });
			i++;
			j++;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			out.push({ type: "del", text: aLines[i] ?? "" });
			i++;
		} else {
			out.push({ type: "add", text: bLines[j] ?? "" });
			j++;
		}
	}
	while (i < m) {
		out.push({ type: "del", text: aLines[i] ?? "" });
		i++;
	}
	while (j < n) {
		out.push({ type: "add", text: bLines[j] ?? "" });
		j++;
	}
	return out;
}

const LABEL_QUOTE_UNITS = 32;

/**
 * The inserted text as a one-line quote for a history label, or "" when there is
 * nothing readable to quote: only whitespace, or a lone surrogate (a patch
 * boundary inside an emoji). Specified in UTF-16 units and four literal whitespace
 * characters, not `\s` or grapheme clusters, because `Diff.swift` must produce the
 * same string and those differ between JavaScript and Swift.
 */
function labelQuote(insert: string): string {
	if (!insert.isWellFormed()) return "";
	const line = insert.replace(/[ \t\n\r]+/g, " ").replace(/^ | $/g, "");
	if (line.length <= LABEL_QUOTE_UNITS) return line;
	const cut = line.charCodeAt(LABEL_QUOTE_UNITS - 1);
	const splitsPair = cut >= 0xd800 && cut <= 0xdbff;
	return `${line.slice(0, LABEL_QUOTE_UNITS - (splitsPair ? 1 : 0))}…`;
}

/** A short human label for an undo node, derived from its patch (blueprint 07 §4 B4). */
export function nodeLabel(
	patch: string,
	parentNodeId: string | null,
	origin?: string,
): string {
	if (parentNodeId == null) return "Document created";
	if (origin === "restore") return "Restored a version";
	// AI transforms tag their node `ai:<instruction label>` (plan 009).
	if (origin?.startsWith("ai:")) {
		const label = origin.slice(3).trim();
		return label ? `AI: ${label}` : "AI edit";
	}
	if (origin === "ai") return "AI edit";
	try {
		const { from, to, insert } = JSON.parse(patch) as {
			from: number;
			to: number;
			insert: string;
		};
		const removed = to - from;
		const added = insert.length;
		// The words say more than a count. A deletion's text is not in its patch.
		const quote = labelQuote(insert);
		if (quote)
			return removed === 0 ? `Added “${quote}”` : `Changed to “${quote}”`;
		if (added > 0 && removed === 0)
			return `Added ${added} char${added === 1 ? "" : "s"}`;
		if (removed > 0 && added === 0)
			return `Removed ${removed} char${removed === 1 ? "" : "s"}`;
		if (added > 0 || removed > 0) return "Edited";
		return "Change";
	} catch {
		return "Change";
	}
}
