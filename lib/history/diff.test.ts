import { describe, expect, it } from "vitest";

import {
	applyAcceptedHunks,
	type DiffRun,
	diffLines,
	diffRuns,
	groupHunks,
} from "./diff";

const rebuildOld = (runs: DiffRun[]) =>
	runs
		.filter((r) => r.type !== "add")
		.map((r) => r.text)
		.join("");
const rebuildNew = (runs: DiffRun[]) =>
	runs
		.filter((r) => r.type !== "del")
		.map((r) => r.text)
		.join("");

describe("diffRuns word granularity (blueprint 08 §5)", () => {
	it("isolates a single changed word (the core bug this fixes)", () => {
		const runs = diffRuns("the quick brown fox", "the slow brown fox", "word");
		expect(runs.some((r) => r.type === "del" && r.text.includes("quick"))).toBe(
			true,
		);
		expect(runs.some((r) => r.type === "add" && r.text.includes("slow"))).toBe(
			true,
		);
		expect(runs.filter((r) => r.type === "del").length).toBe(1);
		expect(runs.filter((r) => r.type === "add").length).toBe(1);
	});

	it("reports a one-word insertion in a reflowing paragraph as a single add", () => {
		const a =
			"The quiet river wound its way through the valley before the storm.";
		const b =
			"The quiet river wound its way slowly through the valley before the storm.";
		const runs = diffRuns(a, b, "word");
		// Exactly one inserted token (the new word, with its spacing) — not a
		// whole-paragraph delete + re-add the way the line LCS would report it.
		expect(runs.filter((r) => r.type === "del").length).toBe(0);
		expect(runs.filter((r) => r.type === "add").length).toBe(1);
		expect(
			runs.some((r) => r.type === "add" && r.text.includes("slowly")),
		).toBe(true);
	});

	it("documents why word beats line: the legacy line diff churns far more text", () => {
		const a =
			"The quiet river wound its way through the valley before the storm.";
		const b =
			"The quiet river wound its way slowly through the valley before the storm.";
		const wordChanged = diffRuns(a, b, "word")
			.filter((r) => r.type !== "same")
			.map((r) => r.text)
			.join("").length;
		const lineChanged = diffLines(a, b)
			.filter((l) => l.type !== "same")
			.map((l) => l.text)
			.join("").length;
		// One line that re-wrapped → the line diff marks the whole line del+add,
		// while the word diff touches only the inserted token.
		expect(wordChanged).toBeLessThan(lineChanged);
	});

	it("identical inputs produce only same runs", () => {
		const runs = diffRuns("same text", "same text", "word");
		expect(runs.every((r) => r.type === "same")).toBe(true);
		expect(runs.some((r) => r.type === "add" || r.type === "del")).toBe(false);
	});

	it("empty/empty has no add or del runs", () => {
		const runs = diffRuns("", "", "word");
		expect(runs.some((r) => r.type === "add" || r.type === "del")).toBe(false);
		expect(rebuildOld(runs)).toBe("");
		expect(rebuildNew(runs)).toBe("");
	});

	it("empty → text is pure addition", () => {
		const runs = diffRuns("", "new", "word");
		expect(runs.some((r) => r.type === "del")).toBe(false);
		expect(runs.some((r) => r.type === "add")).toBe(true);
		expect(rebuildOld(runs)).toBe("");
		expect(rebuildNew(runs)).toBe("new");
	});
});

describe("diffRuns reconstruction invariant (load-bearing for side-by-side)", () => {
	const cases: [string, string][] = [
		["", "hello"],
		["hello world", "hello brave world"],
		["# Title\n\nBody.\n", "# Title\n\nBody edited.\n"],
		["keep this", "keep"],
		["the quick brown fox", "the slow brown fox"],
	];

	it("non-add runs rebuild a; non-del runs rebuild b (word)", () => {
		for (const [a, b] of cases) {
			const runs = diffRuns(a, b, "word");
			expect(rebuildOld(runs)).toBe(a);
			expect(rebuildNew(runs)).toBe(b);
		}
	});

	it("non-add runs rebuild a; non-del runs rebuild b (line)", () => {
		for (const [a, b] of cases) {
			const runs = diffRuns(a, b, "line");
			expect(rebuildOld(runs)).toBe(a);
			expect(rebuildNew(runs)).toBe(b);
		}
	});
});

describe("groupHunks (per-hunk accept/reject)", () => {
	it("groups each maximal run of non-same runs into one indexed hunk", () => {
		const a = "the quick brown fox jumps";
		const b = "the slow brown fox leaps";
		const runs = diffRuns(a, b, "word");
		const hunks = groupHunks(runs);
		// Two changed regions ("quick"→"slow", "jumps"→"leaps") separated by the
		// unchanged " brown fox " context → exactly two hunks, indexed 0 and 1.
		expect(hunks).toHaveLength(2);
		expect(hunks.map((h) => h.index)).toEqual([0, 1]);
		// Every run index in a hunk must be a non-same run.
		for (const hunk of hunks) {
			for (const ri of hunk.runIndices) {
				expect(runs[ri]?.type).not.toBe("same");
			}
		}
	});

	it("returns no hunks for identical inputs", () => {
		expect(groupHunks(diffRuns("same", "same", "word"))).toEqual([]);
	});

	it("a del+add at one location is a single hunk (one edit, one control)", () => {
		const runs = diffRuns("the quick fox", "the slow fox", "word");
		const hunks = groupHunks(runs);
		expect(hunks).toHaveLength(1);
		// The single hunk spans both the deletion and the insertion.
		expect(hunks[0]?.runIndices.length).toBeGreaterThanOrEqual(1);
	});
});

describe("applyAcceptedHunks (partial merge reconstruction)", () => {
	const a = "the quick brown fox jumps";
	const b = "the slow brown fox leaps";

	it("accepting every hunk reproduces the full branch (b)", () => {
		const runs = diffRuns(a, b, "word");
		const all = groupHunks(runs).map((h) => h.index);
		expect(applyAcceptedHunks(runs, all)).toBe(b);
	});

	it("accepting no hunk reproduces the current text (a)", () => {
		const runs = diffRuns(a, b, "word");
		expect(applyAcceptedHunks(runs, [])).toBe(a);
	});

	it("accepting only the first hunk applies that change and discards the rest", () => {
		const runs = diffRuns(a, b, "word");
		// Hunk 0 = "quick"→"slow"; hunk 1 = "jumps"→"leaps". Accept only hunk 0.
		expect(applyAcceptedHunks(runs, [0])).toBe("the slow brown fox jumps");
	});

	it("accepting only the second hunk applies that change and discards the rest", () => {
		const runs = diffRuns(a, b, "word");
		expect(applyAcceptedHunks(runs, [1])).toBe("the quick brown fox leaps");
	});

	it("is a faithful partition: per-hunk accepts are independent and composable", () => {
		const runs = diffRuns(a, b, "word");
		const hunks = groupHunks(runs);
		// Accepting {0,1} === accepting all === b; the empty set === a; each single
		// hunk lands its own change — proving each AI edit / reviewer change is
		// independently acceptable (Feature B rides on this partition).
		expect(applyAcceptedHunks(runs, [0, 1])).toBe(b);
		expect(
			applyAcceptedHunks(
				runs,
				hunks.map((h) => h.index),
			),
		).toBe(b);
	});

	it("handles a pure insertion hunk (empty → branch adds text)", () => {
		const a2 = "alpha gamma";
		const b2 = "alpha beta gamma";
		const runs = diffRuns(a2, b2, "word");
		const all = groupHunks(runs).map((h) => h.index);
		expect(applyAcceptedHunks(runs, all)).toBe(b2);
		expect(applyAcceptedHunks(runs, [])).toBe(a2);
	});

	it("handles a pure deletion hunk (branch removes text)", () => {
		const a2 = "alpha beta gamma";
		const b2 = "alpha gamma";
		const runs = diffRuns(a2, b2, "word");
		const all = groupHunks(runs).map((h) => h.index);
		expect(applyAcceptedHunks(runs, all)).toBe(b2);
		expect(applyAcceptedHunks(runs, [])).toBe(a2);
	});
});

describe("legacy diffLines (kept for tests/legacy)", () => {
	it("still returns DiffLine[] with a same line", () => {
		const lines = diffLines("a\nb", "a\nc");
		expect(lines.some((l) => l.type === "same" && l.text === "a")).toBe(true);
	});
});
