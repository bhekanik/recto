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

export type UnicodeCase = { id: number; name: string; input: string };

/**
 * Cases whose whole point is that a byte-for-byte comparison and a
 * "looks the same to a human" comparison disagree. Swift's `String ==` is
 * canonical equivalence, so a port that uses it would accept NFD output where
 * the web produced NFC; these are the cases that catch that, along with the
 * surrogate-pair and line-ending handling a UTF-16 offset contract depends on.
 *
 * Separate from `CORPUS_CASES` on purpose: the 24-case round-trip corpus is a
 * frozen gate (blueprint 06 §6) and does not change.
 */
export const UNICODE_CASES: UnicodeCase[] = [
	{
		id: 1,
		name: "precomposed NFC accents",
		input: "# Café\n\nA résumé about élan.\n",
	},
	{
		id: 2,
		name: "decomposed NFD accents (canonically equal to case 1, different bytes)",
		input: "# Café\n\nA résumé about élan.\n",
	},
	{
		id: 3,
		name: "ZWJ family emoji",
		input:
			"# \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}\n\nOne grapheme, seven code units.\n",
	},
	{
		id: 4,
		name: "regional-indicator flag",
		input: "The flag \u{1F1FF}\u{1F1E6} in a paragraph.\n",
	},
	{
		id: 5,
		name: "skin-tone modifier",
		input: "- wave \u{1F44B}\u{1F3FD}\n- plain \u{1F44B}\n",
	},
	{
		id: 6,
		name: "astral-plane letters (surrogate pairs before a heading)",
		input: "\u{1D518}\u{1D52F}\u{1D526} text.\n\n## After the pair\n",
	},
	{
		id: 7,
		name: "CRLF line endings",
		input: "# Title\r\n\r\nBody paragraph.\r\n\r\n- item\r\n",
	},
	{ id: 8, name: "no trailing newline", input: "# Title\n\nBody." },
	{
		id: 9,
		name: "several trailing newlines",
		input: "# Title\n\nBody.\n\n\n\n",
	},
	{
		id: 10,
		name: "non-breaking and zero-width spaces",
		input: "Hard space and a zero​width one.\n",
	},
];

export type WordCountCase = {
	name: string;
	markdown: string;
	/** From `lib/markdown/count-words.test.ts`. */
	expectWords?: number;
};

/** Lifted from `lib/markdown/count-words.test.ts`. */
export const WORD_COUNT_CASES: WordCountCase[] = [
	{ name: "empty string", markdown: "", expectWords: 0 },
	{
		name: "writing flags are not words",
		markdown: "Born in <!--flag: the town name--> in 1920.",
		expectWords: 4,
	},
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
	{
		name: "a writing flag is not heading text",
		markdown:
			"## Arrival <!--flag: which year?-->\n\n# Chapter <!--flag--> One\n",
		expectTexts: ["Arrival", "Chapter  One"],
		expectDepths: [2, 1],
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

export type StreakCase = {
	name: string;
	days: { date: string; words: number }[];
	today: string;
	/** From `lib/stats/streak.test.ts`. */
	expectStreak: number;
};

/**
 * Lifted from `lib/stats/streak.test.ts` (`currentStreak` only — `goalProgress`
 * is not part of the core API). `today` is a local "YYYY-MM-DD" key, so a port
 * has to do calendar arithmetic rather than subtracting 86_400_000 from a UTC
 * instant; the month-boundary case is what catches that.
 */
export const STREAK_CASES: StreakCase[] = [
	{ name: "empty list", days: [], today: "2026-06-17", expectStreak: 0 },
	{
		name: "wrote today only",
		days: [{ date: "2026-06-17", words: 120 }],
		today: "2026-06-17",
		expectStreak: 1,
	},
	{
		name: "three consecutive days including today",
		days: [
			{ date: "2026-06-15", words: 200 },
			{ date: "2026-06-16", words: 200 },
			{ date: "2026-06-17", words: 200 },
		],
		today: "2026-06-17",
		expectStreak: 3,
	},
	{
		name: "wrote yesterday but not yet today (no break-shame)",
		days: [
			{ date: "2026-06-15", words: 200 },
			{ date: "2026-06-16", words: 200 },
		],
		today: "2026-06-17",
		expectStreak: 2,
	},
	{
		name: "a skipped day ends the backward walk",
		days: [
			{ date: "2026-06-14", words: 200 },
			{ date: "2026-06-17", words: 200 },
		],
		today: "2026-06-17",
		expectStreak: 1,
	},
	{
		name: "a zero-word day counts as unwritten",
		days: [
			{ date: "2026-06-15", words: 200 },
			{ date: "2026-06-16", words: 0 },
			{ date: "2026-06-17", words: 200 },
		],
		today: "2026-06-17",
		expectStreak: 1,
	},
	{
		name: "duplicate date entries do not double-count",
		days: [
			{ date: "2026-06-16", words: 200 },
			{ date: "2026-06-16", words: 50 },
			{ date: "2026-06-17", words: 200 },
		],
		today: "2026-06-17",
		expectStreak: 2,
	},
	{
		name: "rolls over a month boundary",
		days: [
			{ date: "2026-05-31", words: 200 },
			{ date: "2026-06-01", words: 200 },
		],
		today: "2026-06-01",
		expectStreak: 2,
	},
];

/** Writing flags (`lib/markdown/flags.ts`): what a port must find and write. */
export const FLAG_FIND_CASES: { name: string; markdown: string }[] = [
	{
		name: "inline, with and without a note",
		markdown: "Born in <!--flag: town--> in <!--flag-->.\n",
	},
	{
		name: "notes keep hyphens and punctuation",
		markdown: "A <!--flag: mid-century, maybe?--> b\n",
	},
	{
		name: "flag text in code is not a flag",
		markdown: "a `<!--flag-->` b\n\n```\n<!--flag-->\n```\n",
	},
	{
		name: "a guarded line-start flag covers its guard",
		markdown: "\u2060<!--flag: who--> was born\n",
	},
	{
		name: "headings, lists and quotes",
		markdown:
			"# Title <!--flag-->\n\n- \u2060<!--flag: a-->\n\n> x <!--flag: b-->\n",
	},
	{
		name: "a plain comment is not a flag",
		markdown: "a <!-- note --> b <!--flagpole--> c\n",
	},
	{
		name: "astral characters before a flag shift UTF-16 offsets",
		markdown: "😀 in <!--flag: emoji-->\n",
	},
];

/** Where a new flag goes and whether it needs the line-start guard. */
export const FLAG_INSERT_CASES: {
	name: string;
	markdown: string;
	at: number;
	note: string;
}[] = [
	{ name: "mid-sentence", markdown: "Born in  in 1920.\n", at: 8, note: "" },
	{
		name: "start of the document",
		markdown: "was born.\n",
		at: 0,
		note: "who",
	},
	{ name: "start of a later line", markdown: "One.\nTwo.\n", at: 5, note: "" },
	{ name: "after a list marker", markdown: "- item\n", at: 2, note: "" },
	{
		name: "after an ordered marker and task box",
		markdown: "  1. [ ] task\n",
		at: 9,
		note: "",
	},
	{ name: "after a quote marker", markdown: "> quoted\n", at: 2, note: "" },
	{
		name: "a heading is inline already",
		markdown: "# Title\n",
		at: 2,
		note: "",
	},
	{
		name: "a note is cleaned",
		markdown: "x\n",
		at: 1,
		note: " two\nlines --> here- ",
	},
];
