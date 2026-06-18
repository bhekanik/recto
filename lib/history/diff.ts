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

/** A short human label for an undo node, derived from its patch (blueprint 07 §4 B4). */
export function nodeLabel(
	patch: string,
	parentNodeId: string | null,
	origin?: string,
): string {
	if (parentNodeId == null) return "Document created";
	if (origin === "restore") return "Restored a version";
	try {
		const { from, to, insert } = JSON.parse(patch) as {
			from: number;
			to: number;
			insert: string;
		};
		const removed = to - from;
		const added = insert.length;
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
