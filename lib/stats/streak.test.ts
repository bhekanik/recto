import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("rolls over a year boundary correctly", () => {
		const stats: DailyStat[] = [
			{ date: "2025-12-31", words: 200 },
			{ date: "2026-01-01", words: 200 },
		];
		expect(currentStreak(stats, "2026-01-01")).toBe(2);
	});

	it("rolls over a short February correctly", () => {
		const stats: DailyStat[] = [
			{ date: "2026-02-28", words: 200 },
			{ date: "2026-03-01", words: 200 },
		];
		expect(currentStreak(stats, "2026-03-01")).toBe(2);
	});

	it("rolls over a leap day correctly", () => {
		const stats: DailyStat[] = [
			{ date: "2028-02-29", words: 200 },
			{ date: "2028-03-01", words: 200 },
		];
		expect(currentStreak(stats, "2028-03-01")).toBe(2);
	});
});

/**
 * The motivating bug: stepping back a day by subtracting 86_400_000ms from a
 * local midnight lands on the wrong calendar day when DST makes the local day 23
 * or 25 hours long. In America/Sao_Paulo, 2018 DST began at 2018-11-04 00:00
 * local, so 2018-11-05 midnight minus 24h reads back as 2018-11-03 — 2018-11-04
 * is skipped and the streak silently breaks. `currentStreak` must be
 * timezone-independent because its date keys are already local calendar dates.
 */
describe("currentStreak across DST transitions", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("spring-forward at local midnight (America/Sao_Paulo, 2018-11-04 → 11-05)", () => {
		vi.stubEnv("TZ", "America/Sao_Paulo");
		const stats: DailyStat[] = [
			{ date: "2018-11-04", words: 200 },
			{ date: "2018-11-05", words: 200 },
		];
		expect(currentStreak(stats, "2018-11-05")).toBe(2);
	});

	it("fall-back (America/New_York, 2026-11-01 → 11-02)", () => {
		vi.stubEnv("TZ", "America/New_York");
		const stats: DailyStat[] = [
			{ date: "2026-10-31", words: 200 },
			{ date: "2026-11-01", words: 200 },
			{ date: "2026-11-02", words: 200 },
		];
		expect(currentStreak(stats, "2026-11-02")).toBe(3);
	});

	it("boundaries hold regardless of the ambient timezone", () => {
		vi.stubEnv("TZ", "Pacific/Chatham");
		const stats: DailyStat[] = [
			{ date: "2028-02-29", words: 200 },
			{ date: "2028-03-01", words: 200 },
		];
		expect(currentStreak(stats, "2028-03-01")).toBe(2);
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
