import { describe, expect, test } from "bun:test";

import {
	clusterEnd,
	clusterStart,
	nextCluster,
	previousCluster,
} from "../src/grapheme.js";

/**
 * `clusterStart`/`clusterEnd` have to answer "is this offset a boundary?", which
 * `findClusterBreak` alone cannot: it always moves at least one position. These
 * are the cases that broke while getting that right, plus the out-of-range
 * behaviour the vim motions depend on.
 */

const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 11 units
const FLAG = "\u{1F1FF}\u{1F1E6}"; // 4 units
const SKIN = "\u{1F44D}\u{1F3FD}"; // 4 units
const COMBINING = "é"; // 2 units

describe("cluster boundaries", () => {
	const samples: [string, string, number][] = [
		["ZWJ family", `a${FAMILY}b`, 11],
		["regional-indicator flag", `a${FLAG}b`, 4],
		["skin-tone modifier", `a${SKIN}b`, 4],
		["combining mark", `a${COMBINING}b`, 2],
		["single-codepoint emoji", "a\u{1F3A9}b", 2],
	];

	for (const [name, text, width] of samples) {
		test(`${name}: every interior offset resolves to the same cluster`, () => {
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
