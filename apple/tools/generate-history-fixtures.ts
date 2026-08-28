/**
 * Emit the parity fixtures RectoHistoryTests replays.
 *
 * The Swift ports of patch/materialize/grouping/diff/streak must agree with the
 * web byte-for-byte, so the expectations are produced by running the ACTUAL web
 * implementations here rather than being written by hand.
 *
 * When W3's `packages/editor-fixtures/` lands, this script reads its
 * `history-patches.json` / `diff-runs.json` case lists instead of the local ones
 * (the expectations are still computed from `lib/`, so a drift between W3's
 * fixtures and the web code shows up as a failure here rather than in Swift).
 *
 *   bun run apple/tools/generate-history-fixtures.ts
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { diffRuns, groupHunks, applyAcceptedHunks, diffLines, nodeLabel } from "../../lib/history/diff";
import { GroupingController } from "../../lib/history/grouping";
import { materialize, type DocNode } from "../../lib/history/materialize";
import { applyPatch, computePatch, encodePatch } from "../../lib/history/patch";
import { currentStreak, goalProgress, type GoalKind } from "../../lib/stats/streak";

const repoRoot = join(import.meta.dir, "..", "..");
const outDir = join(
	repoRoot,
	"apple/Packages/RectoHistory/Tests/RectoHistoryTests/Fixtures",
);
const sharedFixtures = join(repoRoot, "packages/editor-fixtures");

/** Pairs that stress the patch algorithm, including the UTF-16 boundary cases. */
const defaultPatchPairs: Array<[string, string]> = [
	["", ""],
	["", "hello"],
	["hello", ""],
	["hello world", "hello brave world"],
	["hello world", "hello"],
	["abc", "abd"],
	["# Title\n\nBody.\n", "# Title\n\nBody edited.\n"],
	["one\ntwo\nthree\n", "one\nthree\n"],
	["prefix same suffix", "prefix CHANGED suffix"],
	// Astral plane: a patch boundary can land INSIDE a surrogate pair, so the
	// stored `insert` is a lone surrogate. This is the case that breaks any port
	// working in Swift Characters or scalars instead of UTF-16 code units.
	["\u{1F600}", "\u{1F601}"],
	["a\u{1F600}b", "a\u{1F601}b"],
	["\u{1F600}\u{1F601}", "\u{1F600}\u{1F602}"],
	["cafe\u{301} time", "café time"],
	["family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} here", "family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F466} here"],
	["\u{1F1FF}\u{1F1E6}", "\u{1F1FA}\u{1F1F8}"],
	["नमस्ते", "नमस्कार"],
	["tab\there", "tab\u{00A0}here"],
	["line\r\nend", "line\nend"],
];

/** (current, branch) pairs for the diff parity table. */
const defaultDiffPairs: Array<[string, string]> = [
	["the quick brown fox", "the quick brown fox"],
	["", ""],
	["", "brand new document"],
	["alpha gamma", "alpha beta gamma"],
	["brand new document", ""],
	["alpha beta gamma", "alpha gamma"],
	["the quick brown fox", "the slow brown fox"],
	["the quick brown fox jumps", "the slow brown fox leaps"],
	["one two three four", "ONE TWO three four"],
	["start middle end", "begin middle finish"],
	[
		"# Title\n\nFirst para.\n\nSecond para.\n",
		"# Title\n\nFirst para edited.\n\nSecond para.\n",
	],
	["a\nb\nc\n", "a\nB\nc\n"],
	["trailing space  ", "trailing space"],
	["multi   spaced   words", "multi spaced words"],
	["punctuation, here!", "punctuation; here?"],
	["emoji \u{1F600} run", "emoji \u{1F601} run"],
	["café naïve", "cafe naive"],
	["mixed\r\nnewlines\r\nhere", "mixed\nnewlines\nhere"],
	["one-two-three", "one_two_three"],
	["# H\n\n- a\n- b\n", "# H\n\n- a\n- c\n- b\n"],
];

async function readShared<T>(name: string): Promise<T | null> {
	const path = join(sharedFixtures, name);
	if (!existsSync(path)) return null;
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function write(name: string, value: unknown) {
	const path = join(outDir, name);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
	console.log(`wrote ${path}`);
}

async function patchFixtures() {
	const shared = await readShared<{ pairs: Array<[string, string]> }>(
		"history-patches.json",
	);
	const pairs = shared?.pairs ?? defaultPatchPairs;
	const cases = pairs.map(([parent, next]) => {
		const patch = encodePatch(computePatch(parent, next));
		return {
			parent,
			next,
			patch,
			// applyPatch(parent, patch) must be `next` exactly (blueprint 03 §4.2).
			applied: applyPatch(parent, patch),
			label: nodeLabel(patch, "root", undefined),
		};
	});
	await write("patch-cases.json", { source: shared ? "editor-fixtures" : "builtin", cases });
}

async function materializeFixtures() {
	// A branch long enough to cross the 50-node snapshot cadence twice, with a
	// fork off the middle so the walk-to-nearest-snapshot path is exercised.
	const nodes: DocNode[] = [];
	const controller = new GroupingController({
		rootNodeId: "root",
		rootMarkdown: "",
		schedule: false,
		now: () => 0,
		onCommit: (commit) => {
			nodes.push({
				nodeId: commit.nodeId,
				parentNodeId: commit.parentNodeId,
				patch: commit.patch,
				snapshot: commit.snapshot,
				selection: commit.selection,
				origin: "fixture",
				createdAt: nodes.length + 1,
			});
		},
	});
	nodes.push({
		nodeId: "root",
		parentNodeId: null,
		patch: encodePatch({ from: 0, to: 0, insert: "" }),
		snapshot: "",
		selection: null,
		origin: "server",
		createdAt: 0,
	});

	let markdown = "";
	const expected: Array<{ nodeId: string; markdown: string }> = [];
	for (let i = 0; i < 120; i++) {
		markdown += i % 7 === 0 ? `\n\nParagraph ${i} \u{1F600}.` : ` word${i}`;
		controller.record(markdown, { anchor: markdown.length, head: markdown.length }, {
			structural: true,
		});
		expected.push({ nodeId: controller.currentNodeId, markdown });
	}

	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	await write("materialize-cases.json", {
		nodes: nodes.map((n) => ({ ...n, snapshot: n.snapshot ?? null })),
		expected: expected.map(({ nodeId }) => ({
			nodeId,
			markdown: materialize(nodeId, byId),
		})),
		snapshotNodeIds: nodes.filter((n) => n.snapshot != null).map((n) => n.nodeId),
	});
}

/** A scripted keystroke stream replayed identically by the Swift controller. */
type GroupingStep = {
	markdown: string;
	selection: { anchor: number; head: number } | null;
	structural: boolean;
	now: number;
	kind: "record" | "tick" | "flush";
};

async function groupingFixtures() {
	const steps: GroupingStep[] = [];
	let now = 0;
	const type = (markdown: string, gap = 50, structural = false) => {
		now += gap;
		steps.push({
			markdown,
			selection: { anchor: markdown.length, head: markdown.length },
			structural,
			now,
			kind: "record",
		});
	};

	// fast typing coalesces
	type("h");
	type("he");
	type("hel");
	type("hell");
	type("hello");
	// idle pause > 500ms opens a new node
	type("hello ", 900);
	type("hello w");
	type("hello wo");
	// selection-only move (same markdown) must not commit
	steps.push({
		markdown: "hello wo",
		selection: { anchor: 0, head: 0 },
		structural: false,
		now: (now += 10),
		kind: "record",
	});
	// adjacency break: edit jumps to the start
	type("Xhello wo");
	// structural boundary (a paste)
	type("Xhello wo\n\n## Pasted heading\n", 30, true);
	// emoji edit
	type("Xhello wo\n\n## Pasted heading \u{1F600}\n");
	steps.push({ markdown: "", selection: null, structural: false, now: (now += 600), kind: "tick" });
	type("Xhello wo\n\n## Pasted heading \u{1F601}\n");
	steps.push({ markdown: "", selection: null, structural: false, now: (now += 10), kind: "flush" });

	const commits: unknown[] = [];
	let seq = 0;
	const controller = new GroupingController({
		rootNodeId: "root",
		rootMarkdown: "",
		schedule: false,
		now: () => now,
		onCommit: (commit) => {
			seq += 1;
			commits.push({
				sequence: seq,
				parentNodeId: commit.parentNodeId,
				patch: commit.patch,
				snapshot: commit.snapshot ?? null,
				selection: commit.selection,
				markdown: commit.markdown,
			});
		},
	});
	for (const step of steps) {
		now = step.now;
		if (step.kind === "record") {
			controller.record(step.markdown, step.selection, { structural: step.structural });
		} else if (step.kind === "tick") {
			controller.tick();
		} else {
			controller.flush();
		}
	}
	await write("grouping-cases.json", { steps, commits });
}

async function diffFixtures() {
	const shared = await readShared<{ pairs: Array<[string, string]> }>("diff-runs.json");
	const pairs = shared?.pairs ?? defaultDiffPairs;
	const cases = pairs.flatMap(([current, branch]) =>
		(["word", "line"] as const).map((granularity) => {
			const runs = diffRuns(current, branch, granularity);
			const hunks = groupHunks(runs);
			const acceptAll = hunks.map((h) => h.index);
			return {
				current,
				branch,
				granularity,
				runs,
				hunks,
				mergedNone: applyAcceptedHunks(runs, []),
				mergedAll: applyAcceptedHunks(runs, acceptAll),
				mergedEven: applyAcceptedHunks(
					runs,
					acceptAll.filter((i) => i % 2 === 0),
				),
			};
		}),
	);
	const lineCases = pairs.map(([current, branch]) => ({
		current,
		branch,
		lines: diffLines(current, branch),
	}));
	await write("diff-cases.json", {
		source: shared ? "editor-fixtures" : "builtin",
		cases,
		lineCases,
	});
}

async function streakFixtures() {
	const cases = [
		{ stats: [], today: "2026-08-28" },
		{ stats: [{ date: "2026-08-28", words: 120 }], today: "2026-08-28" },
		{ stats: [{ date: "2026-08-27", words: 120 }], today: "2026-08-28" },
		{
			stats: [
				{ date: "2026-08-26", words: 10 },
				{ date: "2026-08-27", words: 10 },
				{ date: "2026-08-28", words: 10 },
			],
			today: "2026-08-28",
		},
		{
			stats: [
				{ date: "2026-08-25", words: 10 },
				{ date: "2026-08-27", words: 10 },
			],
			today: "2026-08-28",
		},
		{ stats: [{ date: "2026-08-28", words: 0 }], today: "2026-08-28" },
		{
			// spans a month boundary
			stats: [
				{ date: "2026-07-31", words: 5 },
				{ date: "2026-08-01", words: 5 },
			],
			today: "2026-08-01",
		},
		{
			// leap-day boundary
			stats: [
				{ date: "2028-02-28", words: 5 },
				{ date: "2028-02-29", words: 5 },
			],
			today: "2028-02-29",
		},
	];
	const goals = [
		{ words: 0, target: 500, kind: "at-least" },
		{ words: 500, target: 500, kind: "at-least" },
		{ words: 460, target: 500, kind: "about" },
		{ words: 400, target: 500, kind: "about" },
		{ words: 550, target: 500, kind: "at-most" },
		{ words: 10, target: 0, kind: "at-least" },
	] as const;
	await write("streak-cases.json", {
		streaks: cases.map((c) => ({ ...c, streak: currentStreak(c.stats, c.today) })),
		goals: goals.map((g) => ({
			...g,
			progress: goalProgress(g.words, g.target, g.kind as GoalKind),
		})),
	});
}

await patchFixtures();
await materializeFixtures();
await groupingFixtures();
await diffFixtures();
await streakFixtures();
