/**
 * The fixture JSON is the contract the native ports are checked against, so it
 * must always be exactly what `lib/` produces today. These tests read the
 * committed JSON (never the TS case list) and re-run `lib/` over it: a change in
 * markdown/diff/history behaviour fails here until `bun run fixtures:build` is
 * re-run and the diff is reviewed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	applyAcceptedHunks,
	type DiffGranularity,
	diffRuns,
	groupHunks,
} from "@/lib/history/diff";
import { indexNodes, materialize } from "@/lib/history/materialize";
import { applyPatch, computePatch, encodePatch } from "@/lib/history/patch";
import { countWords } from "@/lib/markdown/count-words";
import { normalizeMarkdown } from "@/lib/markdown/normalize";
import { extractOutline } from "@/lib/outline/extract";
import { currentStreak } from "@/lib/stats/streak";

import {
	assertWellFormedStrings,
	generateFixtures,
	serializeFixture,
} from "./build";
import diffFixture from "./diff-runs.json";
import historyFixture from "./history-patches.json";
import corpus from "./markdown-corpus.json";
import outlineFixture from "./outline.json";
import streakFixture from "./streak.json";
import wordCountFixture from "./word-count.json";

const fixturesDir = dirname(fileURLToPath(import.meta.url));

describe("fixtures are not stale", () => {
	it("every committed JSON file matches `bun run fixtures:build`", () => {
		for (const [name, value] of Object.entries(generateFixtures())) {
			const onDisk = readFileSync(join(fixturesDir, name), "utf8");
			expect(onDisk, `${name} is stale — run \`bun run fixtures:build\``).toBe(
				serializeFixture(value),
			);
		}
	});
});

describe("markdown-corpus.json", () => {
	it("covers every case in the round-trip corpus", () => {
		expect(corpus.cases.map((c) => c.id)).toEqual(
			corpus.cases.map((_, i) => i + 1),
		);
	});

	for (const testCase of corpus.cases) {
		it(`case ${testCase.id}: ${testCase.name}`, () => {
			expect(normalizeMarkdown(testCase.input)).toBe(testCase.normalized);
			// The 25th corpus gate: normalizing an already-canonical document is a
			// no-op, so the native ports can round-trip without drifting.
			expect(normalizeMarkdown(testCase.normalized)).toBe(testCase.normalized);
			expect(countWords(testCase.input)).toBe(testCase.words);
			expect(extractOutline(testCase.input)).toEqual(testCase.outline);
		});
	}

	for (const testCase of corpus.unicode) {
		it(`unicode ${testCase.id}: ${testCase.name}`, () => {
			expect(normalizeMarkdown(testCase.input)).toBe(testCase.normalized);
			expect(normalizeMarkdown(testCase.normalized)).toBe(testCase.normalized);
			expect(countWords(testCase.input)).toBe(testCase.words);
			expect(extractOutline(testCase.input)).toEqual(testCase.outline);
		});
	}

	it("keeps the NFC/NFD pair canonically equal but byte-different", () => {
		const [nfc, nfd] = corpus.unicode;
		// JS `===` is already code-unit comparison, so this passes trivially here.
		// It is written down because it is the assertion the Swift spike makes with
		// `utf16.elementsEqual`, where `==` would compare canonical equivalence and
		// wave the drift through.
		expect(nfc?.normalized).not.toBe(nfd?.normalized);
		expect(nfc?.normalized.normalize("NFC")).toBe(
			nfd?.normalized.normalize("NFC"),
		);
	});
});

describe("lone-surrogate guard", () => {
	it("refuses to serialize a fixture Foundation could not decode", () => {
		expect(() =>
			assertWellFormedStrings({ cases: [{ input: "bad \ud800 half" }] }),
		).toThrow(/lone surrogate/);
	});

	it("accepts astral-plane text, which is well-formed", () => {
		expect(() =>
			assertWellFormedStrings({ cases: [{ input: "fine 𝔘 pair" }] }),
		).not.toThrow();
	});
});

describe("word-count.json", () => {
	for (const testCase of wordCountFixture.cases) {
		it(testCase.name, () => {
			expect(countWords(testCase.markdown)).toBe(testCase.words);
		});
	}
});

describe("outline.json", () => {
	for (const testCase of outlineFixture.cases) {
		it(testCase.name, () => {
			expect(extractOutline(testCase.markdown)).toEqual(testCase.outline);
		});
	}
});

describe("streak.json", () => {
	for (const testCase of streakFixture.cases) {
		it(testCase.name, () => {
			expect(currentStreak(testCase.days, testCase.today)).toBe(
				testCase.streak,
			);
		});
	}
});

describe("history-patches.json", () => {
	for (const testCase of historyFixture.patches) {
		it(`patch: ${testCase.name}`, () => {
			expect(computePatch(testCase.parent, testCase.next)).toEqual(
				testCase.patch,
			);
			expect(encodePatch(testCase.patch)).toBe(testCase.encoded);
			expect(applyPatch(testCase.parent, testCase.encoded)).toBe(testCase.next);
		});
	}

	for (const testCase of historyFixture.materialize) {
		it(`materialize: ${testCase.name}`, () => {
			expect(materialize(testCase.target, indexNodes(testCase.nodes))).toBe(
				testCase.markdown,
			);
		});
	}
});

/** The fixture stores the granularity as a plain string; refuse an unknown one. */
function asGranularity(value: string): DiffGranularity {
	if (value !== "word" && value !== "line") {
		throw new Error(`diff-runs.json: unknown granularity "${value}"`);
	}
	return value;
}

describe("diff-runs.json", () => {
	for (const testCase of diffFixture.cases) {
		it(`${testCase.name} (${testCase.granularity})`, () => {
			const runs = diffRuns(
				testCase.a,
				testCase.b,
				asGranularity(testCase.granularity),
			);
			expect(runs).toEqual(testCase.runs);
			expect(groupHunks(runs)).toEqual(testCase.hunks);
			for (const accept of testCase.accepts) {
				expect(
					applyAcceptedHunks(runs, accept.hunks),
					`accepted ${JSON.stringify(accept.hunks)}`,
				).toBe(accept.markdown);
			}
		});
	}
});
