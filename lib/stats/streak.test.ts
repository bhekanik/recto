import { describe, expect, it } from "vitest";
import {
	currentStreak,
	type DailyStat,
	goalProgress,
	localDateKey,
} from "./streak";

describe("localDateKey", () => {
	it("returns YYYY-MM-DD for a known local date", () => {
		// Construct via local-time constructor so the test is timezone-stable.
		expect(localDateKey(new Date(2026, 5, 17))).toBe("2026-06-17");
	});

	it("pads single-digit month and day", () => {
		expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
	});
});

describe("currentStreak", () => {
	const today = "2026-06-17";

	it("empty list → 0", () => {
		expect(currentStreak([], today)).toBe(0);
	});

	it("wrote today only → 1", () => {
		const stats: DailyStat[] = [{ date: today, words: 120 }];
		expect(currentStreak(stats, today)).toBe(1);
	});

	it("three consecutive days incl. today → 3", () => {
		const stats: DailyStat[] = [
			{ date: "2026-06-15", words: 200 },
			{ date: "2026-06-16", words: 200 },
			{ date: "2026-06-17", words: 200 },
		];
		expect(currentStreak(stats, today)).toBe(3);
	});

	it("wrote yesterday but not yet today → still counts back (no break-shame)", () => {
		const stats: DailyStat[] = [
			{ date: "2026-06-15", words: 200 },
			{ date: "2026-06-16", words: 200 },
		];
		expect(currentStreak(stats, today)).toBe(2);
	});

	it("a gap (wrote 3 days ago and today, not yesterday) → today=1", () => {
		const stats: DailyStat[] = [
			{ date: "2026-06-14", words: 200 },
			{ date: "2026-06-17", words: 200 },
		];
		expect(currentStreak(stats, today)).toBe(1);
	});

	it("a day with words: 0 is treated as not-written", () => {
		const stats: DailyStat[] = [
			{ date: "2026-06-15", words: 200 },
			{ date: "2026-06-16", words: 0 },
			{ date: "2026-06-17", words: 200 },
		];
		// 2026-06-16 has zero words → it breaks the run, so only today counts.
		expect(currentStreak(stats, today)).toBe(1);
	});

	it("duplicate date entries do not double-count", () => {
		const stats: DailyStat[] = [
			{ date: "2026-06-16", words: 200 },
			{ date: "2026-06-16", words: 50 },
			{ date: "2026-06-17", words: 200 },
		];
		expect(currentStreak(stats, today)).toBe(2);
	});

	it("rolls over a month boundary correctly", () => {
		const stats: DailyStat[] = [
			{ date: "2026-05-31", words: 200 },
			{ date: "2026-06-01", words: 200 },
		];
		expect(currentStreak(stats, "2026-06-01")).toBe(2);
	});
});

describe("goalProgress", () => {
	it("at-least: below target → not met, correct ratio/remaining", () => {
		expect(goalProgress(850, 1000, "at-least")).toEqual({
			ratio: 0.85,
			met: false,
			remaining: 150,
		});
	});

	it("at-least: at/over target → met, ratio 1, remaining 0", () => {
		expect(goalProgress(1000, 1000, "at-least")).toEqual({
			ratio: 1,
			met: true,
			remaining: 0,
		});
		expect(goalProgress(1500, 1000, "at-least")).toEqual({
			ratio: 1,
			met: true,
			remaining: 0,
		});
	});

	it("at-most: under target → met", () => {
		expect(goalProgress(400, 500, "at-most")).toEqual({
			ratio: 0.8,
			met: true,
			remaining: 100,
		});
	});

	it("at-most: over target → not met, ratio 1, remaining 0", () => {
		expect(goalProgress(600, 500, "at-most")).toEqual({
			ratio: 1,
			met: false,
			remaining: 0,
		});
	});

	it("about: within ±10% band → met", () => {
		expect(goalProgress(950, 1000, "about").met).toBe(true);
		expect(goalProgress(1100, 1000, "about").met).toBe(true);
	});

	it("about: outside band → not met", () => {
		expect(goalProgress(800, 1000, "about").met).toBe(false);
		expect(goalProgress(1200, 1000, "about").met).toBe(false);
	});

	it("target <= 0 → no goal", () => {
		expect(goalProgress(500, 0, "at-least")).toEqual({
			ratio: 0,
			met: false,
			remaining: 0,
		});
	});
});
