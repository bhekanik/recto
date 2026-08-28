/**
 * Regenerates the fixture JSON from `lib/` — `bun run fixtures:build`.
 *
 * The JSON is what the native ports run, so it must never be edited by hand.
 * `fixtures.test.ts` regenerates in memory and fails if the committed files
 * differ, which makes any behaviour change in `lib/` show up as an explicit
 * fixture diff instead of a silent web/native divergence.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { visit } from "unist-util-visit";
import { applyAcceptedHunks, diffRuns, groupHunks } from "@/lib/history/diff";
import {
	type DocNode,
	indexNodes,
	materialize,
} from "@/lib/history/materialize";
import {
	applyPatch,
	computePatch,
	encodePatch,
	SNAPSHOT_EVERY_N,
} from "@/lib/history/patch";
import { CORPUS_CASES } from "@/lib/markdown/corpus/cases";
import { countWords } from "@/lib/markdown/count-words";
import { normalizeMarkdown } from "@/lib/markdown/normalize";
import { parseMarkdown } from "@/lib/markdown/parse";
import { extractOutline, type OutlineHeading } from "@/lib/outline/extract";
import { currentStreak } from "@/lib/stats/streak";

import {
	DIFF_CASES,
	DIFF_GRANULARITIES,
	MATERIALIZE_SPECS,
	type MaterializeSpec,
	OUTLINE_CASES,
	PATCH_CASES,
	STREAK_CASES,
	UNICODE_CASES,
	WORD_COUNT_CASES,
} from "./src/cases";

const fixturesDir = dirname(fileURLToPath(import.meta.url));

/** A hand-written expectation from a web test disagreeing with `lib/` is a bug. */
function check(condition: boolean, message: string): void {
	if (!condition) throw new Error(`fixture expectation failed: ${message}`);
}

function yamlValueOf(markdown: string): string | null {
	let value: string | null = null;
	visit(parseMarkdown(markdown), "yaml", (node) => {
		if ("value" in node && typeof node.value === "string") value = node.value;
	});
	return value;
}

/** One case as the fixture stores it: input plus everything derived from it. */
function derivedCase(id: number, name: string, input: string, yaml: boolean) {
	const normalized = normalizeMarkdown(input);
	check(
		normalizeMarkdown(normalized) === normalized,
		`case ${id} (${name}) is not idempotent`,
	);
	return {
		id,
		name,
		input,
		normalized,
		words: countWords(input),
		outline: extractOutline(input),
		// Assertion 4 of the corpus gate: frontmatter bytes survive verbatim.
		yaml: yaml ? yamlValueOf(input) : null,
	};
}

function buildMarkdownCorpus() {
	const unicode = UNICODE_CASES.map((testCase) =>
		derivedCase(testCase.id, testCase.name, testCase.input, false),
	);
	// The NFC/NFD pair only earns its place if the two really do normalize to
	// different code units — otherwise a port comparing with canonical
	// equivalence would pass it by accident.
	const [nfc, nfd] = unicode;
	check(
		nfc !== undefined &&
			nfd !== undefined &&
			nfc.normalized !== nfd.normalized &&
			nfc.normalized.normalize("NFC") === nfd.normalized.normalize("NFC"),
		"unicode cases 1 and 2 must be canonically equal but byte-different",
	);
	return {
		$source:
			"lib/markdown/corpus/cases.ts + lib/markdown (CANONICAL_STRINGIFY)",
		$contract:
			"normalize(input) === normalized; normalize(normalized) === normalized. " +
			"String comparison is by UTF-16 code unit, never canonical equivalence.",
		cases: CORPUS_CASES.map((testCase) =>
			derivedCase(
				testCase.id,
				testCase.name,
				testCase.input,
				testCase.checkFrontmatter === true,
			),
		),
		unicode,
	};
}

function buildWordCount() {
	return {
		$source: "lib/markdown/count-words.ts",
		cases: WORD_COUNT_CASES.map((testCase) => {
			const words = countWords(testCase.markdown);
			check(
				testCase.expectWords === undefined || testCase.expectWords === words,
				`word count "${testCase.name}": expected ${testCase.expectWords}, lib returned ${words}`,
			);
			return { name: testCase.name, markdown: testCase.markdown, words };
		}),
	};
}

function buildOutline() {
	return {
		$source: "lib/outline/extract.ts",
		cases: OUTLINE_CASES.map((testCase) => {
			const outline: OutlineHeading[] = extractOutline(testCase.markdown);
			check(
				testCase.expectTexts === undefined ||
					JSON.stringify(testCase.expectTexts) ===
						JSON.stringify(outline.map((h) => h.text)),
				`outline "${testCase.name}": heading text mismatch`,
			);
			check(
				testCase.expectDepths === undefined ||
					JSON.stringify(testCase.expectDepths) ===
						JSON.stringify(outline.map((h) => h.depth)),
				`outline "${testCase.name}": heading depth mismatch`,
			);
			return { name: testCase.name, markdown: testCase.markdown, outline };
		}),
	};
}

/** Turn a chain of markdown states into the `docNodes` rows they'd be stored as. */
function nodesFor(spec: MaterializeSpec): DocNode[] {
	const snapshots = new Set(spec.snapshotAt);
	return spec.states.map((state, i) => {
		const node: DocNode = {
			nodeId: `n${i}`,
			parentNodeId: i === 0 ? null : `n${i - 1}`,
			patch:
				i === 0
					? ""
					: encodePatch(computePatch(spec.states[i - 1] ?? "", state)),
		};
		// The root always carries a snapshot; materialization terminates there.
		if (i === 0 || snapshots.has(i)) node.snapshot = state;
		return node;
	});
}

function buildHistoryPatches() {
	return {
		$source: "lib/history/patch.ts + lib/history/materialize.ts",
		$contract:
			"applyPatch(parent, encodePatch(computePatch(parent, next))) === next; " +
			"materialize walks to the nearest snapshot then replays forward",
		snapshotEveryN: SNAPSHOT_EVERY_N,
		patches: PATCH_CASES.map((testCase) => {
			const patch = computePatch(testCase.parent, testCase.next);
			const encoded = encodePatch(patch);
			check(
				applyPatch(testCase.parent, encoded) === testCase.next,
				`patch "${testCase.name}" does not round-trip`,
			);
			return {
				name: testCase.name,
				parent: testCase.parent,
				next: testCase.next,
				patch,
				encoded,
			};
		}),
		materialize: MATERIALIZE_SPECS.map((spec) => {
			const nodes = nodesFor(spec);
			const target = `n${spec.targetIndex}`;
			const markdown = materialize(target, indexNodes(nodes));
			check(
				markdown === spec.states[spec.targetIndex],
				`materialize "${spec.name}" did not reproduce its state`,
			);
			check(
				spec.expectMarkdown === undefined || spec.expectMarkdown === markdown,
				`materialize "${spec.name}": expected ${JSON.stringify(spec.expectMarkdown)}`,
			);
			return { name: spec.name, nodes, target, markdown };
		}),
	};
}

/**
 * Every subset of accepted hunks while that stays small; otherwise the empty
 * set, every singleton and the full set — enough to pin the partition without
 * emitting 2^n entries for a pathological pair.
 */
function acceptSubsets(hunkCount: number): number[][] {
	const all = Array.from({ length: hunkCount }, (_, i) => i);
	if (hunkCount <= 4) {
		return Array.from({ length: 1 << hunkCount }, (_, mask) =>
			all.filter((i) => mask & (1 << i)),
		);
	}
	return [[], ...all.map((i) => [i]), all];
}

function buildDiffRuns() {
	const cases = [];
	for (const testCase of DIFF_CASES) {
		for (const granularity of DIFF_GRANULARITIES) {
			const runs = diffRuns(testCase.a, testCase.b, granularity);
			const hunks = groupHunks(runs);
			const accepts = acceptSubsets(hunks.length).map((subset) => ({
				hunks: subset,
				markdown: applyAcceptedHunks(runs, subset),
			}));
			check(
				runs
					.filter((r) => r.type !== "add")
					.map((r) => r.text)
					.join("") === testCase.a,
				`diff "${testCase.name}" (${granularity}): non-add runs do not rebuild a`,
			);
			check(
				runs
					.filter((r) => r.type !== "del")
					.map((r) => r.text)
					.join("") === testCase.b,
				`diff "${testCase.name}" (${granularity}): non-del runs do not rebuild b`,
			);
			cases.push({
				name: testCase.name,
				granularity,
				a: testCase.a,
				b: testCase.b,
				runs,
				hunks,
				accepts,
			});
		}
	}
	return {
		$source:
			"lib/history/diff.ts (mirrored byte-for-byte in convex/history.ts)",
		$contract:
			"accepting no hunk yields a, accepting every hunk yields b, and each " +
			"hunk index is independently applicable",
		cases,
	};
}

function buildStreak() {
	return {
		$source: "lib/stats/streak.ts",
		$contract:
			"a run of consecutive written days (words > 0) counting back from " +
			"`today`, except an unwritten `today` does not reset it",
		cases: STREAK_CASES.map((testCase) => {
			const streak = currentStreak(testCase.days, testCase.today);
			check(
				testCase.expectStreak === streak,
				`streak "${testCase.name}": expected ${testCase.expectStreak}, lib returned ${streak}`,
			);
			return {
				name: testCase.name,
				days: testCase.days,
				today: testCase.today,
				streak,
			};
		}),
	};
}

/** Every fixture file, keyed by filename — the generator's whole output. */
export function generateFixtures() {
	return {
		"markdown-corpus.json": buildMarkdownCorpus(),
		"word-count.json": buildWordCount(),
		"outline.json": buildOutline(),
		"history-patches.json": buildHistoryPatches(),
		"diff-runs.json": buildDiffRuns(),
		"streak.json": buildStreak(),
	};
}

/**
 * Refuse a fixture containing a lone surrogate. `JSON.stringify` happily emits
 * one as a `\udXXX` escape, but Foundation's `JSONDecoder` rejects the whole
 * file when it decodes that escape — so the failure would land on a Swift port
 * as an unreadable fixture rather than here. Nothing in the corpus needs one;
 * if a case ever does, it has to be escaped deliberately, not smuggled in.
 */
export function assertWellFormedStrings(value: unknown, path = "$"): void {
	if (typeof value === "string") {
		if (!value.isWellFormed()) {
			throw new Error(`fixture at ${path} contains a lone surrogate`);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [i, item] of value.entries()) {
			assertWellFormedStrings(item, `${path}[${i}]`);
		}
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			assertWellFormedStrings(item, `${path}.${key}`);
		}
	}
}

/** Biome formats JSON with tabs; match it so `biome check` stays clean. */
export function serializeFixture(value: unknown): string {
	assertWellFormedStrings(value);
	return `${JSON.stringify(value, null, "\t")}\n`;
}

if (import.meta.main) {
	for (const [name, value] of Object.entries(generateFixtures())) {
		const text = serializeFixture(value);
		await writeFile(join(fixturesDir, name), text);
		console.log(`${name}: ${(text.length / 1024).toFixed(1)} kB`);
	}
}
