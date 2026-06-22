import { describe, expect, it } from "vitest";
// The per-hunk accept feature is SERVER-AUTHORITATIVE: the client (lib/history/diff.ts)
// renders hunks and sends only hunk INDICES; the server (convex/history.ts) reconstructs
// the merged markdown from those indices. Convex modules can't import from lib/, so
// `diffRuns` / `groupHunks` / `applyAcceptedHunks` are DUPLICATED in convex/history.ts.
// If the two copies ever silently diverge — different runs, different hunk grouping, or
// different merged output — the owner's live document gets the WRONG text merged in.
//
// This is a guard test: it imports the three functions from BOTH copies (aliased
// `convex*` / `lib*`) and asserts they agree on every output, for a representative +
// adversarial corpus, at both granularities, across ALL hunk-accept subsets. It must
// FAIL if the implementations diverge in runs, hunk grouping, or merged output.
import {
	applyAcceptedHunks as convexApplyAcceptedHunks,
	diffRuns as convexDiffRuns,
	groupHunks as convexGroupHunks,
} from "../../convex/history";
import {
	applyAcceptedHunks as libApplyAcceptedHunks,
	diffRuns as libDiffRuns,
	groupHunks as libGroupHunks,
} from "./diff";

type DiffGranularity = "word" | "line";
const granularities: DiffGranularity[] = ["word", "line"];

/**
 * Representative + adversarial (current, branch) markdown pairs. Each stresses a
 * different code path in the run computation / hunk grouping:
 *  - identical / empty docs (degenerate, no hunks)
 *  - pure insertion / pure deletion (one-sided hunks)
 *  - interleaved add/del across the doc (multiple hunks)
 *  - adjacent changes (do they collapse into one hunk or stay separate?)
 *  - multi-paragraph (newline handling differs word vs line)
 *  - multi-word-within-line (word granularity must isolate tokens)
 */
const pairs: ReadonlyArray<readonly [string, string]> = [
	// identical
	["the quick brown fox", "the quick brown fox"],
	// empty / empty
	["", ""],
	// pure insertion
	["", "brand new document"],
	["alpha gamma", "alpha beta gamma"],
	// pure deletion
	["brand new document", ""],
	["alpha beta gamma", "alpha gamma"],
	// single word change
	["the quick brown fox", "the slow brown fox"],
	// interleaved add/del (two separated hunks)
	["the quick brown fox jumps", "the slow brown fox leaps"],
	// adjacent changes (two consecutive changed tokens)
	["one two three four", "ONE TWO three four"],
	// multi-word within a line, change at both ends
	["start middle end", "begin middle finish"],
	// multi-paragraph, one paragraph edited
	[
		"# Title\n\nFirst para.\n\nSecond para.\n",
		"# Title\n\nFirst para edited.\n\nSecond para.\n",
	],
	// multi-paragraph, paragraph inserted
	["alpha\n\nbeta\n", "alpha\n\ninserted\n\nbeta\n"],
	// multi-paragraph, paragraph removed
	["alpha\n\nbeta\n\ngamma\n", "alpha\n\ngamma\n"],
	// reflow: a one-word insertion in a long prose line
	[
		"The quiet river wound its way through the valley before the storm.",
		"The quiet river wound its way slowly through the valley before the storm.",
	],
	// trailing/leading whitespace + newline-only edits
	["line a\nline b\nline c", "line a\nLINE B\nline c"],
	// total rewrite (everything changes)
	["completely different here", "nothing matches now"],
	// many small interleaved edits → many hunks (exercises subset explosion guard below)
	["a x b y c z d", "a 1 b 2 c 3 d"],
];

/** Deep structural equality for the DiffRun arrays both modules produce. */
function expectRunsEqual(
	lib: ReadonlyArray<{ type: string; text: string }>,
	cvx: ReadonlyArray<{ type: string; text: string }>,
	ctx: string,
) {
	expect(cvx.length, `${ctx}: run count`).toBe(lib.length);
	for (let i = 0; i < lib.length; i++) {
		expect(cvx[i]?.type, `${ctx}: run[${i}].type`).toBe(lib[i]?.type);
		expect(cvx[i]?.text, `${ctx}: run[${i}].text`).toBe(lib[i]?.text);
	}
}

/** Enumerate all 2^n subsets of [0..n). Guarded to small n to bound the blow-up. */
function allSubsets(n: number): number[][] {
	// 2^n subsets; cap at a sane hunk count so a pathological pair can't explode runtime.
	if (n > 14)
		throw new Error(`too many hunks (${n}) for exhaustive subset check`);
	const out: number[][] = [];
	for (let mask = 0; mask < 1 << n; mask++) {
		const subset: number[] = [];
		for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(i);
		out.push(subset);
	}
	return out;
}

describe("diff implementation parity: convex/history.ts vs lib/history/diff.ts", () => {
	it("imports the duplicated functions from BOTH modules", () => {
		// Sanity: both modules must actually export the three functions under test, so a
		// rename in one (without the other) breaks the import above and surfaces here
		// rather than silently skipping the parity assertions.
		expect(typeof libDiffRuns, "lib.diffRuns").toBe("function");
		expect(typeof libGroupHunks, "lib.groupHunks").toBe("function");
		expect(typeof libApplyAcceptedHunks, "lib.applyAcceptedHunks").toBe(
			"function",
		);
		expect(typeof convexDiffRuns, "convex.diffRuns").toBe("function");
		expect(typeof convexGroupHunks, "convex.groupHunks").toBe("function");
		expect(typeof convexApplyAcceptedHunks, "convex.applyAcceptedHunks").toBe(
			"function",
		);
	});

	for (const [pi, [a, b]] of pairs.entries()) {
		for (const g of granularities) {
			const label = `pair#${pi} (${g}) ${JSON.stringify(a)} → ${JSON.stringify(b)}`;

			it(`agrees on diffRuns + groupHunks + every accept-subset — ${label}`, () => {
				// 1) Runs must be identical.
				const libRuns = libDiffRuns(a, b, g);
				const cvxRuns = convexDiffRuns(a, b, g);
				expectRunsEqual(libRuns, cvxRuns, `${label}: diffRuns`);

				// 2) Hunk grouping must be identical (indices + run-index spans).
				const libHunks = libGroupHunks(libRuns);
				const cvxHunks = convexGroupHunks(cvxRuns);
				expect(cvxHunks, `${label}: groupHunks`).toEqual(libHunks);

				// 3) Merged output must agree for EVERY subset of accepted hunks.
				const n = libHunks.length;
				const subsets = allSubsets(n);
				for (const subset of subsets) {
					const libOut = libApplyAcceptedHunks(libRuns, subset);
					const cvxOut = convexApplyAcceptedHunks(cvxRuns, subset);
					expect(
						cvxOut,
						`${label}: applyAcceptedHunks(${JSON.stringify(subset)})`,
					).toBe(libOut);

					// Bonus invariant both impls must satisfy: accepting all hunks yields b,
					// accepting none yields a. (Catches a divergence that happens to agree
					// between the two but is wrong for both — a weaker but still useful net.)
					if (subset.length === n)
						expect(libOut, `${label}: accept-all == branch`).toBe(b);
					if (subset.length === 0)
						expect(libOut, `${label}: accept-none == current`).toBe(a);
				}
			});
		}
	}
});
