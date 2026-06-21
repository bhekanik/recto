/**
 * Server-side undo-tree materialization (blueprint 03 §4.3, 07 §5.1). Kept
 * self-contained inside convex/ so the function bundle has no cross-directory
 * imports. Mirrors lib/history/{patch,materialize}.ts — both are pure.
 */

import { diffWordsWithSpace, diffLines as jsDiffLines } from "diff";

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

// ---------------------------------------------------------------------------
// Per-hunk diff partitioning (plan: per-hunk accept/reject)
//
// MUST stay in sync with lib/history/diff.ts (`DiffRun` / `groupHunks` /
// `applyAcceptedHunks`). Convex modules can't import from lib/ (the bundle is
// self-contained), so the run computation + grouping is duplicated here. Both
// sides diff with the SAME `diff` package over the SAME (current, branch,
// granularity) inputs, so the hunk `index` the owner picks in the UI maps to the
// same hunk the server reconstructs — this is the contract that lets per-hunk
// accept be SERVER-AUTHORITATIVE (the client sends hunk indices, never markdown).
// ---------------------------------------------------------------------------

/** One inline diff run (mirrors lib/history/diff.ts `DiffRun`). */
export type DiffRun = { type: "add" | "del" | "same"; text: string };

/** Diff granularity the owner chose in the review surface. */
export type DiffGranularity = "word" | "line";

/**
 * Token/line diff of `a → b` (mirrors lib/history/diff.ts `diffRuns`). "word" uses
 * `diffWordsWithSpace` (whitespace-preserving, prose-friendly); "line" uses
 * `diffLines`. Pure.
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

/** A reviewable hunk: its stable left-to-right `index` + the run positions it spans. */
export type DiffHunk = { index: number; runIndices: number[] };

/**
 * Group runs into hunks — each maximal span of consecutive non-`same` runs is one
 * hunk. Mirrors lib/history/diff.ts `groupHunks` exactly. Pure.
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
 * of the `current → branch` diff are accepted. Accepted hunks emit their `add`
 * (branch) side; rejected hunks emit their `del` (current) side. Mirrors
 * lib/history/diff.ts `applyAcceptedHunks` byte-for-byte. Pure.
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
		if (inAcceptedHunk) {
			if (run.type === "add") out += run.text;
		} else {
			if (run.type === "del") out += run.text;
		}
	}
	return out;
}
