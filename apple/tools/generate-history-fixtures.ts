/**
 * Emit the parity fixtures RectoHistoryTests replays.
 *
 * The Swift ports of patch/materialize/grouping/diff/streak must agree with the
 * web byte-for-byte, so every expectation here is produced by running the ACTUAL
 * web implementations in `lib/` rather than being written by hand. CI reruns
 * this and diffs the result, so a change to `lib/` that nobody propagated fails
 * the build instead of leaving the Swift suite passing against stale answers.
 *
 * The corpus is imported from `packages/editor-fixtures/src/cases.ts` (W3) —
 * the typed source the web and the JS core are held to, not its JSON build
 * output — plus the Swift-specific cases below, which cover what a Swift port
 * gets wrong and JavaScript cannot reach: surrogate pairs split by a patch
 * boundary, canonical-equivalence traps in `String ==`, and calendar boundaries
 * a fixed-86_400_000-ms day step gets wrong. If W3's corpus changes, this
 * regenerates and CI's diff shows it.
 *
 *   bun run apple/tools/generate-history-fixtures.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	applyAcceptedHunks,
	diffLines,
	diffRuns,
	groupHunks,
	nodeLabel,
} from "../../lib/history/diff";
import { GroupingController } from "../../lib/history/grouping";
import { type DocNode, materialize } from "../../lib/history/materialize";
import { applyPatch, computePatch, encodePatch } from "../../lib/history/patch";
import {
	currentStreak,
	type DailyStat,
	type GoalKind,
	goalProgress,
} from "../../lib/stats/streak";
import {
	DIFF_CASES,
	PATCH_CASES,
	STREAK_CASES,
} from "../../packages/editor-fixtures/src/cases";

const repoRoot = join(import.meta.dir, "..", "..");
const outDir = join(
	repoRoot,
	"apple/Packages/RectoHistory/Tests/RectoHistoryTests/Fixtures",
);

/**
 * Pairs the shared corpus does not cover. Every one of these is a case where a
 * Swift port behaves differently from JavaScript unless it works in UTF-16 code
 * units: a patch boundary inside a surrogate pair produces a lone surrogate that
 * `Swift.String` cannot hold at all.
 */
const swiftPatchPairs: Array<[string, string]> = [
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
	[
		"family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} here",
		"family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F466} here",
	],
	["\u{1F1FF}\u{1F1E6}", "\u{1F1FA}\u{1F1F8}"],
	["नमस्ते", "नमस्कार"],
	["tab\there", "tab\u{00A0}here"],
	["line\r\nend", "line\nend"],
];

/** (current, branch) pairs beyond the shared corpus. */
const swiftDiffPairs: Array<[string, string]> = [
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

/**
 * The five files this script emits. The Swift `Decodable` structs in
 * RectoHistoryTests mirror these shapes; changing one means changing both.
 */
type PatchCase = {
	parent: string;
	next: string;
	patch: string;
	applied: string;
	label: string;
};

type FixtureNode = {
	nodeId: string;
	parentNodeId: string | null;
	patch: string;
	snapshot: string | null;
	selection: { anchor: number; head: number } | null;
	origin: string;
	createdAt: number;
};

type MaterializedNode = { nodeId: string; markdown: string };

type GroupingCommit = {
	sequence: number;
	patch: string;
	snapshot: string | null;
	selection: { anchor: number; head: number } | null;
	markdown: string;
};

type DiffRunCase = { type: string; text: string };

type DiffCase = {
	current: string;
	branch: string;
	granularity: "word" | "line";
	runs: DiffRunCase[];
	hunks: Array<{ index: number; runIndices: number[] }>;
	mergedNone: string;
	mergedAll: string;
	mergedEven: string;
};

type LineDiffCase = {
	current: string;
	branch: string;
	lines: DiffRunCase[];
};

type StreakExpectation = {
	name: string;
	stats: DailyStat[];
	today: string;
	streak: number;
};

type GoalExpectation = {
	words: number;
	target: number;
	kind: GoalKind;
	progress: { ratio: number; met: boolean; remaining: number };
};

type FixtureFile =
	| { cases: PatchCase[] }
	| {
			nodes: FixtureNode[];
			expected: MaterializedNode[];
			snapshotNodeIds: string[];
	  }
	| { steps: GroupingStep[]; commits: GroupingCommit[] }
	| { cases: DiffCase[]; lineCases: LineDiffCase[] }
	| { streaks: StreakExpectation[]; goals: GoalExpectation[] };

async function write(name: string, value: FixtureFile) {
	const path = join(outDir, name);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
	console.log(`wrote ${path}`);
}

async function patchFixtures() {
	const pairs: Array<[string, string]> = [
		...PATCH_CASES.map(({ parent, next }): [string, string] => [parent, next]),
		...swiftPatchPairs,
	];

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
	await write("patch-cases.json", { cases });
}

async function materializeFixtures() {
	// A branch long enough to cross the 50-node snapshot cadence twice.
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
	const heads: string[] = [];
	for (let i = 0; i < 120; i++) {
		markdown += i % 7 === 0 ? `\n\nParagraph ${i} \u{1F600}.` : ` word${i}`;
		controller.record(
			markdown,
			{ anchor: markdown.length, head: markdown.length },
			{ structural: true },
		);
		heads.push(controller.currentNodeId);
	}

	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	// ULIDs are random, so the emitted fixture would differ on every run and CI's
	// "fixtures are current" diff could never pass. Rewrite the ids to a stable
	// sequence; nothing under test depends on their values, only on the shape of
	// the graph.
	const stableId = new Map<string, string>([["root", "root"]]);
	for (const node of nodes) {
		if (!stableId.has(node.nodeId))
			stableId.set(node.nodeId, `n${stableId.size}`);
	}
	const rename = (id: string) => stableId.get(id) ?? id;
	const renameParent = (id: string | null) => (id === null ? null : rename(id));

	await write("materialize-cases.json", {
		nodes: nodes.map((n) => ({
			nodeId: rename(n.nodeId),
			parentNodeId: renameParent(n.parentNodeId),
			patch: n.patch,
			snapshot: n.snapshot ?? null,
			selection: n.selection ?? null,
			origin: n.origin ?? "fixture",
			createdAt: n.createdAt ?? 0,
		})),
		expected: heads.map((nodeId) => ({
			nodeId: rename(nodeId),
			markdown: materialize(nodeId, byId),
		})),
		snapshotNodeIds: nodes
			.filter((n) => n.snapshot != null)
			.map((n) => rename(n.nodeId)),
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
	now += 10;
	steps.push({
		markdown: "hello wo",
		selection: { anchor: 0, head: 0 },
		structural: false,
		now,
		kind: "record",
	});
	// adjacency break: edit jumps to the start
	type("Xhello wo");
	// structural boundary (a paste)
	type("Xhello wo\n\n## Pasted heading\n", 30, true);
	// emoji edit
	type("Xhello wo\n\n## Pasted heading \u{1F600}\n");
	now += 600;
	steps.push({
		markdown: "",
		selection: null,
		structural: false,
		now,
		kind: "tick",
	});
	type("Xhello wo\n\n## Pasted heading \u{1F601}\n");
	now += 10;
	steps.push({
		markdown: "",
		selection: null,
		structural: false,
		now,
		kind: "flush",
	});

	// Adjacent input with no idle pause still closes a node after five seconds.
	// Each gap stays below GROUP_DELAY_MS, so only MAX_GROUP_MS can split it.
	const continuousBase = "continuous";
	type(continuousBase, 30, true);
	for (let index = 1; index <= 12; index++) {
		type(`${continuousBase}${"x".repeat(index)}`, 499);
	}
	now += 10;
	steps.push({
		markdown: "",
		selection: null,
		structural: false,
		now,
		kind: "flush",
	});

	const commits: GroupingCommit[] = [];
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
			controller.record(step.markdown, step.selection, {
				structural: step.structural,
			});
		} else if (step.kind === "tick") {
			controller.tick();
		} else {
			controller.flush();
		}
	}
	await write("grouping-cases.json", { steps, commits });
}

async function diffFixtures() {
	const seen = new Set<string>();
	const diffPairs: Array<[string, string]> = [];
	for (const [current, branch] of [
		...DIFF_CASES.map(({ a, b }): [string, string] => [a, b]),
		...swiftDiffPairs,
	]) {
		// Both granularities are emitted below, so each pair is listed once.
		const key = JSON.stringify([current, branch]);
		if (seen.has(key)) continue;
		seen.add(key);
		diffPairs.push([current, branch]);
	}

	const cases = diffPairs.flatMap(([current, branch]) =>
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
	const lineCases = diffPairs.map(([current, branch]) => ({
		current,
		branch,
		lines: diffLines(current, branch),
	}));
	await write("diff-cases.json", { cases, lineCases });
}

type StreakCase = {
	name: string;
	days: DailyStat[];
	today: string;
	streak: number;
};

/**
 * Boundaries the shared corpus does not reach. Both catch an implementation that
 * steps back a fixed 86_400_000 ms instead of one calendar day — which is what
 * `lib/stats/streak.ts` itself does, and why the Swift port deliberately differs
 * (see RectoHistory/Streak.swift).
 */
const swiftStreakCases: StreakCase[] = [
	{
		// The case that breaks a `midnight - 86_400_000 ms` step: in
		// America/Sao_Paulo the 2018-11-04 local day is 23 hours long, so that
		// arithmetic skips it entirely. Both clients now step calendar days as
		// strings, so this is timezone-independent on either side.
		name: "spring-forward at local midnight (America/Sao_Paulo)",
		days: [
			{ date: "2018-11-04", words: 5 },
			{ date: "2018-11-05", words: 5 },
		],
		today: "2018-11-05",
		streak: 2,
	},
	{
		name: "fall-back boundary (America/New_York)",
		days: [
			{ date: "2026-11-01", words: 5 },
			{ date: "2026-11-02", words: 5 },
		],
		today: "2026-11-02",
		streak: 2,
	},
	{
		name: "leap-day boundary",
		days: [
			{ date: "2028-02-28", words: 5 },
			{ date: "2028-02-29", words: 5 },
		],
		today: "2028-02-29",
		streak: 2,
	},
	{
		name: "year boundary",
		days: [
			{ date: "2025-12-31", words: 5 },
			{ date: "2026-01-01", words: 5 },
		],
		today: "2026-01-01",
		streak: 2,
	},
];

async function streakFixtures() {
	const shared: StreakCase[] = STREAK_CASES.map((c) => ({
		name: c.name,
		days: c.days,
		today: c.today,
		streak: c.expectStreak,
	}));
	const streaks = [...shared, ...swiftStreakCases].map((c) => {
		const computed = currentStreak(c.days, c.today);
		// The asserted answer and the web implementation must agree. If they stop
		// agreeing that is a web bug, and this script says so rather than baking
		// the disagreement into the Swift expectations.
		if (computed !== c.streak) {
			throw new Error(
				`streak case "${c.name}" expects ${c.streak}, lib/stats/streak.ts computes ${computed}`,
			);
		}
		return { name: c.name, stats: c.days, today: c.today, streak: c.streak };
	});

	const goals = [
		{ words: 0, target: 500, kind: "at-least" },
		{ words: 500, target: 500, kind: "at-least" },
		{ words: 460, target: 500, kind: "about" },
		{ words: 400, target: 500, kind: "about" },
		{ words: 550, target: 500, kind: "at-most" },
		{ words: 10, target: 0, kind: "at-least" },
	] as const;

	await write("streak-cases.json", {
		streaks,
		goals: goals.map((g) => ({
			...g,
			progress: goalProgress(g.words, g.target, g.kind),
		})),
	});
}

await patchFixtures();
await materializeFixtures();
await groupingFixtures();
await diffFixtures();
await streakFixtures();
