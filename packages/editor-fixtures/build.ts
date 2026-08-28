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

import {
	DIFF_CASES,
	DIFF_GRANULARITIES,
	MATERIALIZE_SPECS,
	type MaterializeSpec,
	OUTLINE_CASES,
	PATCH_CASES,
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

function buildMarkdownCorpus() {
	return {
		$source:
			"lib/markdown/corpus/cases.ts + lib/markdown (CANONICAL_STRINGIFY)",
		$contract:
			"normalize(input) === normalized; normalize(normalized) === normalized",
		cases: CORPUS_CASES.map((testCase) => {
			const normalized = normalizeMarkdown(testCase.input);
			check(
				normalizeMarkdown(normalized) === normalized,
				`corpus case ${testCase.id} is not idempotent`,
			);
			return {
				id: testCase.id,
				name: testCase.name,
				input: testCase.input,
				normalized,
				words: countWords(testCase.input),
				outline: extractOutline(testCase.input),
				// Assertion 4 of the corpus gate: frontmatter bytes survive verbatim.
				yaml: testCase.checkFrontmatter ? yamlValueOf(testCase.input) : null,
			};
		}),
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

/** Every fixture file, keyed by filename — the generator's whole output. */
export function generateFixtures() {
	return {
		"markdown-corpus.json": buildMarkdownCorpus(),
		"word-count.json": buildWordCount(),
		"outline.json": buildOutline(),
		"history-patches.json": buildHistoryPatches(),
		"diff-runs.json": buildDiffRuns(),
	};
}

/** Biome formats JSON with tabs; match it so `biome check` stays clean. */
export function serializeFixture(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

if (import.meta.main) {
	for (const [name, value] of Object.entries(generateFixtures())) {
		const text = serializeFixture(value);
		await writeFile(join(fixturesDir, name), text);
		console.log(`${name}: ${(text.length / 1024).toFixed(1)} kB`);
	}
}
