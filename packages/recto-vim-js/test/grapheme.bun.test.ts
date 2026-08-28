import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	clusterBoundaries,
	clusterEnd,
	clusterStart,
	nextCluster,
	previousCluster,
} from "../src/grapheme.js";

/**
 * Unicode's own `GraphemeBreakTest.txt` is the gate.
 *
 * The previous implementation passed a hand-written suite while splitting
 * Hangul syllables, SpacingMarks and CRLF — every case someone had thought to
 * write down, and none of the ones they had not. Swift's `GraphemeClamp` runs
 * the same file, so "the two sides agree" follows from both matching the
 * standard rather than being a claim about each other.
 */

type ConformanceCase = {
	line: number;
	text: string;
	/** UTF-16 offsets, ascending, including 0 and `text.length`. */
	boundaries: number[];
	description: string;
};

function loadConformanceCases(): ConformanceCase[] {
	const path = `${import.meta.dir}/../../editor-fixtures/unicode/GraphemeBreakTest.txt`;
	const cases: ConformanceCase[] = [];

	for (const [index, raw] of readFileSync(path, "utf8").split("\n").entries()) {
		const hash = raw.indexOf("#");
		const body = (hash === -1 ? raw : raw.slice(0, hash)).trim();
		if (body === "") continue;

		let text = "";
		const boundaries: number[] = [];
		for (const token of body.split(/\s+/)) {
			// `÷` is a break, `×` is not, everything else is a hex code point.
			if (token === "÷") boundaries.push(text.length);
			else if (token === "×") continue;
			else text += String.fromCodePoint(Number.parseInt(token, 16));
		}
		cases.push({
			line: index + 1,
			text,
			boundaries,
			description: (hash === -1 ? "" : raw.slice(hash + 1)).trim(),
		});
	}
	return cases;
}

const conformance = loadConformanceCases();

/**
 * Rows where the platform's ICU disagrees with the vendored UCD, by line number.
 *
 * These are **not** softening. Each is asserted to still diverge, so if an OS
 * update fixes one the suite fails and the entry gets removed; and nothing
 * outside the list may diverge. Both implementations are ICU-backed, so the
 * same rows are expected to appear in Swift's `GraphemeConformanceTests`, which
 * is the point — the two sides agreeing matters more than either matching a
 * file the OS has not caught up with.
 *
 * 1105: `2701 ZWJ 2701` (UPPER BLADE SCISSORS). GB11 joins
 * Extended_Pictographic × ZWJ × Extended_Pictographic; macOS 26's ICU is
 * working from an older Extended_Pictographic set in which U+2701 is not one,
 * so it breaks after the ZWJ. Nothing in Recto's dialect depends on it.
 */
const KNOWN_ICU_DIVERGENCES = new Set([1105]);

function boundariesDiffer(item: ConformanceCase): boolean {
	return clusterBoundaries(item.text).join(",") !== item.boundaries.join(",");
}

describe("UAX #29 conformance", () => {
	test("the conformance file parsed", () => {
		// Unicode 16 has about 1,100 rows. A parser that silently produced nothing
		// would make every assertion below vacuous.
		expect(conformance.length).toBeGreaterThan(600);
		expect(conformance.every((item) => item.boundaries[0] === 0)).toBe(true);
	});

	test("every row's boundaries match", () => {
		// Reported as a list, never a count and never truncated: both
		// implementations follow whatever Unicode version their ICU ships, so an
		// OS update to a newer UCD than the vendored file can legitimately move a
		// few rows, and that has to be distinguishable from a regression.
		const failures: string[] = [];
		for (const item of conformance) {
			if (KNOWN_ICU_DIVERGENCES.has(item.line)) continue;
			const actual = clusterBoundaries(item.text);
			if (actual.join(",") !== item.boundaries.join(",")) {
				failures.push(
					`line ${item.line}: got [${actual}], expected [${item.boundaries}] — ${item.description}`,
				);
			}
		}
		expect(failures).toEqual([]);
	});

	test("every recorded ICU divergence is still a divergence", () => {
		// An allowance nobody re-checks is an allowance that outlives its reason.
		const stale = conformance
			.filter((item) => KNOWN_ICU_DIVERGENCES.has(item.line))
			.filter((item) => !boundariesDiffer(item))
			.map((item) => item.line);
		expect(stale).toEqual([]);
		expect(KNOWN_ICU_DIVERGENCES.size).toBeLessThan(5);
	});

	test("stepping forward and back walks the same boundaries", () => {
		const failures: string[] = [];
		for (const item of conformance) {
			if (item.text.length === 0 || KNOWN_ICU_DIVERGENCES.has(item.line))
				continue;

			const forward: number[] = [0];
			let at = 0;
			while (at < item.text.length) {
				at = nextCluster(item.text, at);
				forward.push(at);
			}

			const backward: number[] = [item.text.length];
			let back = item.text.length;
			while (back > 0) {
				back = previousCluster(item.text, back);
				backward.push(back);
			}
			backward.reverse();

			if (forward.join(",") !== item.boundaries.join(",")) {
				failures.push(`line ${item.line} forward: [${forward}]`);
			} else if (backward.join(",") !== item.boundaries.join(",")) {
				failures.push(`line ${item.line} backward: [${backward}]`);
			}
		}
		expect(failures).toEqual([]);
	});

	test("every offset resolves to the cluster it is inside", () => {
		// This is the assertion that catches `Segments.containing()` disagreeing
		// with its own iteration at a high surrogate. It is deliberately not
		// truncated — reporting only the first few is how that stayed hidden.
		const failures: string[] = [];
		for (const item of conformance) {
			if (KNOWN_ICU_DIVERGENCES.has(item.line)) continue;
			for (let i = 0; i < item.boundaries.length - 1; i++) {
				const start = item.boundaries[i] as number;
				const end = item.boundaries[i + 1] as number;
				for (let offset = start; offset < end; offset++) {
					if (clusterStart(item.text, offset) !== start) {
						failures.push(
							`line ${item.line}: clusterStart(${offset}) gave ${clusterStart(item.text, offset)}, expected ${start}`,
						);
					}
					const wanted = offset === start ? start : end;
					if (clusterEnd(item.text, offset) !== wanted) {
						failures.push(
							`line ${item.line}: clusterEnd(${offset}) gave ${clusterEnd(item.text, offset)}, expected ${wanted}`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});
});

/**
 * The shapes the vim layer cares about, named so a failure says what broke
 * rather than "line 431". The last four are the ones the previous
 * implementation got wrong.
 */
describe("cluster boundaries", () => {
	const samples: [string, string, number][] = [
		["ZWJ family", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}", 11],
		["regional-indicator flag", "\u{1F1FF}\u{1F1E6}", 4],
		["skin-tone modifier", "\u{1F44D}\u{1F3FD}", 4],
		["combining mark", "é", 2],
		["single-codepoint emoji", "\u{1F3A9}", 2],
		["Hangul LV", "가", 2],
		["Hangul LVT", "각", 3],
		["SpacingMark", "का", 2],
		["CRLF", "\r\n", 2],
		["Prepend", "؀क", 2],
	];

	for (const [name, cluster, width] of samples) {
		const text = `a${cluster}b`;

		test(`${name}: every interior offset resolves to the same cluster`, () => {
			expect(cluster.length).toBe(width);
			for (let offset = 1; offset < 1 + width; offset++) {
				expect(clusterStart(text, offset)).toBe(1);
				expect(clusterEnd(text, offset)).toBe(offset === 1 ? 1 : 1 + width);
			}
		});

		test(`${name}: boundaries are fixed points`, () => {
			for (const offset of [0, 1, 1 + width, text.length]) {
				expect(clusterStart(text, offset)).toBe(offset);
				expect(clusterEnd(text, offset)).toBe(offset);
			}
		});

		test(`${name}: stepping crosses it in one move`, () => {
			expect(nextCluster(text, 1)).toBe(1 + width);
			expect(previousCluster(text, 1 + width)).toBe(1);
		});
	}
});

test("ASCII steps one code unit at a time", () => {
	expect(nextCluster("abc", 0)).toBe(1);
	expect(previousCluster("abc", 2)).toBe(1);
	expect(clusterStart("abc", 2)).toBe(2);
	expect(clusterEnd("abc", 2)).toBe(2);
});

test("stepping keeps counting past both ends", () => {
	// `moveByCharacters` produces out-of-range positions on purpose (`3l` on a
	// two-character line) and lets the core clamp them; the steppers must not
	// stall, or a count would silently move fewer characters than asked.
	expect(nextCluster("ab", 2)).toBe(3);
	expect(nextCluster("ab", 5)).toBe(6);
	expect(previousCluster("ab", 0)).toBe(-1);
	expect(previousCluster("ab", -2)).toBe(-3);
});

test("clamping is total for out-of-range offsets", () => {
	expect(clusterStart("ab", -5)).toBe(0);
	expect(clusterStart("ab", 99)).toBe(2);
	expect(clusterEnd("ab", -5)).toBe(0);
	expect(clusterEnd("ab", 99)).toBe(2);
});
