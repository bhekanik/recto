/**
 * Fixture INPUTS — the single place a parity case is written down.
 *
 * `build.ts` turns these into the JSON files the web tests and the Swift ports
 * both read. Where an existing web test asserted a concrete value, that value is
 * repeated here as `expect*`; the generator fails if `lib/` disagrees, so the
 * hand-written expectation keeps acting as a second opinion instead of being
 * quietly replaced by whatever the code currently returns.
 */

import type { DiffGranularity } from "@/lib/history/diff";

export type WordCountCase = {
	name: string;
	markdown: string;
	/** From `lib/markdown/count-words.test.ts`. */
	expectWords?: number;
};

/** Lifted from `lib/markdown/count-words.test.ts`. */
export const WORD_COUNT_CASES: WordCountCase[] = [
	{ name: "empty string", markdown: "", expectWords: 0 },
	{ name: "whitespace only", markdown: "   \n\n  ", expectWords: 0 },
	{
		name: "prose words, not markdown syntax",
		markdown: "# Hello world\n\nThis is **bold** and _italic_.",
		expectWords: 8,
	},
	{
		name: "list item text",
		markdown: "- first item\n- second item",
		expectWords: 4,
	},
	{
		name: "GFM table cells count as prose",
		markdown: "| col a | col b |\n| ----- | ----- |\n| one   | two   |",
	},
	{
		name: "fenced code is not prose",
		markdown: "Some prose here.\n\n```ts\nconst x = 1;\n```\n",
	},
];

export type OutlineCase = {
	name: string;
	markdown: string;
	/** From `lib/outline/extract.test.ts`, where it asserted one. */
	expectTexts?: string[];
	expectDepths?: number[];
};

/** Lifted from `lib/outline/extract.test.ts`. */
export const OUTLINE_CASES: OutlineCase[] = [
	{
		name: "nested headings in document order",
		markdown: "# A\n\n## B\n\n### C\n\n## D\n",
		expectTexts: ["A", "B", "C", "D"],
		expectDepths: [1, 2, 3, 2],
	},
	{
		name: "no headings",
		markdown: "Just a plain paragraph.\n\nAnd another one.\n",
		expectTexts: [],
		expectDepths: [],
	},
	{
		name: "duplicate titles stay distinct by index",
		markdown: "## Notes\n\nfirst\n\n## Notes\n\nsecond\n",
		expectTexts: ["Notes", "Notes"],
		expectDepths: [2, 2],
	},
	{
		name: "### inside a fenced code block is not a heading",
		markdown: "```\n### not a heading\n```\n\n## Real\n",
		expectTexts: ["Real"],
		expectDepths: [2],
	},
	{
		name: "inline markdown stripped from heading text",
		markdown: "## Hello **world**\n",
		expectTexts: ["Hello world"],
		expectDepths: [2],
	},
	{
		name: "YAML frontmatter is not a heading",
		markdown: "---\ntitle: My Doc\n---\n\n# Title\n",
		expectTexts: ["Title"],
		expectDepths: [1],
	},
	{
		name: "empty-text headings keep index alignment",
		markdown: "# \n\n## Real\n",
		expectTexts: ["", "Real"],
		expectDepths: [1, 2],
	},
];

export type PatchCase = { name: string; parent: string; next: string };

/** Lifted from `lib/history/history.test.ts` ("patch codec"). */
export const PATCH_CASES: PatchCase[] = [
	{ name: "empty to text", parent: "", next: "hello" },
	{
		name: "insert in the middle",
		parent: "hello world",
		next: "hello brave world",
	},
	{
		name: "edit a paragraph",
		parent: "# Title\n\nBody.\n",
		next: "# Title\n\nBody edited.\n",
	},
	{ name: "replace a run", parent: "abcdef", next: "abXYZef" },
	{ name: "truncate", parent: "keep this", next: "keep" },
	{ name: "no change", parent: "identical", next: "identical" },
	{ name: "delete everything", parent: "gone", next: "" },
	{
		name: "unicode boundary (UTF-16 code units, not code points)",
		parent: "a😀b",
		next: "a😀c",
	},
];

/**
 * The chain from `lib/history/history.test.ts`, plus a longer one that crosses a
 * mid-branch snapshot the way a real document does. `patch` values are filled in
 * by the generator via `computePatch`, so the fixture always carries the real
 * encoding rather than a hand-typed JSON string.
 */
export type MaterializeSpec = {
	name: string;
	/** Ordered chain of markdown states; index 0 is the root (always snapshotted). */
	states: string[];
	/** Indices (into `states`) that also carry a full snapshot. */
	snapshotAt: number[];
	/** Index of the node to materialize. */
	targetIndex: number;
	expectMarkdown?: string;
};

export const MATERIALIZE_SPECS: MaterializeSpec[] = [
	{
		name: "replays from the root snapshot",
		states: ["A", "AB", "ABC", "ABCD"],
		snapshotAt: [0, 2],
		targetIndex: 1,
		expectMarkdown: "AB",
	},
	{
		name: "returns a snapshot node's snapshot directly",
		states: ["A", "AB", "ABC", "ABCD"],
		snapshotAt: [0, 2],
		targetIndex: 2,
		expectMarkdown: "ABC",
	},
	{
		name: "replays across a mid-branch snapshot boundary",
		states: ["A", "AB", "ABC", "ABCD"],
		snapshotAt: [0, 2],
		targetIndex: 3,
		expectMarkdown: "ABCD",
	},
	{
		name: "root only",
		states: ["# Title\n"],
		snapshotAt: [0],
		targetIndex: 0,
		expectMarkdown: "# Title\n",
	},
	{
		name: "twelve-node chain with one mid-chain snapshot",
		states: Array.from({ length: 12 }, (_, i) => `line ${i}\n`.repeat(i + 1)),
		snapshotAt: [0, 6],
		targetIndex: 11,
	},
];

export type DiffCase = { name: string; a: string; b: string };

/**
 * The adversarial pair corpus from `lib/history/diff-parity.test.ts` — the same
 * pairs that guard `lib/history/diff.ts` against `convex/history.ts`. Every pair
 * is emitted at both granularities.
 */
export const DIFF_CASES: DiffCase[] = [
	{ name: "identical", a: "the quick brown fox", b: "the quick brown fox" },
	{ name: "empty/empty", a: "", b: "" },
	{ name: "pure insertion from empty", a: "", b: "brand new document" },
	{ name: "word inserted", a: "alpha gamma", b: "alpha beta gamma" },
	{ name: "pure deletion to empty", a: "brand new document", b: "" },
	{ name: "word deleted", a: "alpha beta gamma", b: "alpha gamma" },
	{
		name: "single word change",
		a: "the quick brown fox",
		b: "the slow brown fox",
	},
	{
		name: "two separated hunks",
		a: "the quick brown fox jumps",
		b: "the slow brown fox leaps",
	},
	{
		name: "adjacent changes",
		a: "one two three four",
		b: "ONE TWO three four",
	},
	{
		name: "change at both ends",
		a: "start middle end",
		b: "begin middle finish",
	},
	{
		name: "multi-paragraph, one paragraph edited",
		a: "# Title\n\nFirst para.\n\nSecond para.\n",
		b: "# Title\n\nFirst para edited.\n\nSecond para.\n",
	},
	{
		name: "multi-paragraph, paragraph inserted",
		a: "alpha\n\nbeta\n",
		b: "alpha\n\ninserted\n\nbeta\n",
	},
	{
		name: "multi-paragraph, paragraph removed",
		a: "alpha\n\nbeta\n\ngamma\n",
		b: "alpha\n\ngamma\n",
	},
	{
		name: "reflow: one word inserted in a long line",
		a: "The quiet river wound its way through the valley before the storm.",
		b: "The quiet river wound its way slowly through the valley before the storm.",
	},
	{
		name: "one line rewritten",
		a: "line a\nline b\nline c",
		b: "line a\nLINE B\nline c",
	},
	{
		name: "total rewrite",
		a: "completely different here",
		b: "nothing matches now",
	},
	{ name: "many interleaved edits", a: "a x b y c z d", b: "a 1 b 2 c 3 d" },
];

export const DIFF_GRANULARITIES: DiffGranularity[] = ["word", "line"];
