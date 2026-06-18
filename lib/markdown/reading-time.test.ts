import { describe, expect, it } from "vitest";

import {
	formatReadingTime,
	readingTimeMinutes,
	WORDS_PER_MINUTE,
} from "@/lib/markdown/reading-time";

describe("readingTimeMinutes", () => {
	it("returns 0 for empty or negative word counts", () => {
		expect(readingTimeMinutes(0)).toBe(0);
		expect(readingTimeMinutes(-50)).toBe(0);
	});

	it("floors any real text at 1 minute", () => {
		expect(readingTimeMinutes(1)).toBe(1);
		expect(readingTimeMinutes(30)).toBe(1);
	});

	it("respects the ceiling boundary at the default 200 wpm", () => {
		expect(WORDS_PER_MINUTE).toBe(200);
		expect(readingTimeMinutes(199)).toBe(1);
		expect(readingTimeMinutes(200)).toBe(1);
		expect(readingTimeMinutes(201)).toBe(2);
	});

	it("scales up for longer documents", () => {
		expect(readingTimeMinutes(1000)).toBe(5);
	});

	it("respects a custom words-per-minute", () => {
		expect(readingTimeMinutes(500, 250)).toBe(2);
		expect(readingTimeMinutes(251, 250)).toBe(2);
	});

	it("returns 0 when wpm is non-positive", () => {
		expect(readingTimeMinutes(1000, 0)).toBe(0);
		expect(readingTimeMinutes(1000, -10)).toBe(0);
	});
});

describe("formatReadingTime", () => {
	it("renders a compact minute label", () => {
		expect(formatReadingTime(0)).toBe("0 min");
		expect(formatReadingTime(1)).toBe("1 min");
		expect(formatReadingTime(12)).toBe("12 min");
	});
});
