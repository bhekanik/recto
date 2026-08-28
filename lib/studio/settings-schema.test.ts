import { describe, expect, it } from "vitest";

import {
	changedSyncedKeys,
	coerceSettings,
	DEFAULTS,
	DEVICE_LOCAL_KEYS,
	mergeSyncedJson,
	pickSynced,
	pickUnknown,
	READING_SCALE_MAX,
	READING_SCALE_MIN,
	type StudioSettings,
	SYNCED_KEYS,
	serializeSynced,
} from "./settings-schema";

describe("the synced / device-local split", () => {
	it("covers every setting exactly once", () => {
		const all = Object.keys(DEFAULTS).sort();
		const split = [...DEVICE_LOCAL_KEYS, ...SYNCED_KEYS].sort();
		expect(split).toEqual(all);
	});

	it("keeps the screen's preferences on the device", () => {
		// These are calibrated against one display, or are window furniture.
		expect([...DEVICE_LOCAL_KEYS]).toEqual([
			"appearance",
			"readingScale",
			"topToolbar",
			"outlineOpen",
		]);
	});

	it("syncs the writer's preferences", () => {
		for (const key of ["theme", "readingFont", "lint", "aiEnabled"] as const) {
			expect(SYNCED_KEYS).toContain(key);
		}
	});

	it("serializes only the synced subset", () => {
		const json = serializeSynced(DEFAULTS);
		const parsed = JSON.parse(json) as Record<string, unknown>;
		for (const key of DEVICE_LOCAL_KEYS) {
			expect(parsed).not.toHaveProperty(key);
		}
		expect(parsed.theme).toBe(DEFAULTS.theme);
	});

	it("serializes stably, so unchanged state produces an identical string", () => {
		// The push effect skips a mutation by comparing these strings.
		expect(serializeSynced(DEFAULTS)).toBe(
			serializeSynced({ ...DEFAULTS, appearance: "dark", readingScale: 1.4 }),
		);
	});

	it("picks a plain object with no device-local keys", () => {
		expect(Object.keys(pickSynced(DEFAULTS)).sort()).toEqual(
			[...SYNCED_KEYS].sort(),
		);
	});
});

describe("coerceSettings", () => {
	it("returns the base for anything that is not an object", () => {
		for (const value of [null, undefined, 42, "text", []]) {
			expect(coerceSettings(value, DEFAULTS)).toEqual(DEFAULTS);
		}
	});

	it("takes valid values and falls back per key, not per object", () => {
		const result = coerceSettings(
			{ theme: "aurora", readingFont: "not-a-font", lint: "yes" },
			DEFAULTS,
		);
		expect(result.theme).toBe("aurora");
		// One bad key must not cost the writer the good one next to it.
		expect(result.readingFont).toBe(DEFAULTS.readingFont);
		expect(result.lint).toBe(DEFAULTS.lint);
	});

	it("falls back to the supplied base, not to the defaults", () => {
		const base: StudioSettings = { ...DEFAULTS, theme: "moonlit", lint: true };
		const result = coerceSettings({ readingFont: "serif" }, base);
		expect(result.theme).toBe("moonlit");
		expect(result.lint).toBe(true);
	});

	it("clamps the reading scale into range", () => {
		expect(coerceSettings({ readingScale: 99 }, DEFAULTS).readingScale).toBe(
			READING_SCALE_MAX,
		);
		expect(coerceSettings({ readingScale: 0 }, DEFAULTS).readingScale).toBe(
			READING_SCALE_MIN,
		);
	});

	it("clamps goal targets to non-negative integers", () => {
		expect(
			coerceSettings({ wordGoalTarget: -50.6 }, DEFAULTS).wordGoalTarget,
		).toBe(0);
		expect(
			coerceSettings({ dailyGoalTarget: 750.4 }, DEFAULTS).dailyGoalTarget,
		).toBe(750);
		expect(
			coerceSettings({ wordGoalTarget: Number.NaN }, DEFAULTS).wordGoalTarget,
		).toBe(0);
	});

	it("completes a partial lint-category map, defaulting each category on", () => {
		const result = coerceSettings(
			{ lintCategories: { passive: false } },
			DEFAULTS,
		);
		expect(result.lintCategories).toEqual({
			passive: false,
			readability: true,
			adverb: true,
			weasel: true,
		});
	});
});

describe("mergeSyncedJson", () => {
	const local: StudioSettings = {
		...DEFAULTS,
		appearance: "dark",
		readingScale: 1.5,
		topToolbar: false,
		outlineOpen: true,
		theme: "moonlit",
	};

	it("takes the server's synced values", () => {
		const merged = mergeSyncedJson(local, JSON.stringify({ theme: "dawn" }));
		expect(merged.theme).toBe("dawn");
	});

	it("never lets the server change this device's local settings", () => {
		const merged = mergeSyncedJson(
			local,
			// A client with a bug, or an older version, could put these in the blob.
			JSON.stringify({
				appearance: "light",
				readingScale: 1,
				topToolbar: true,
				outlineOpen: false,
			}),
		);
		expect(merged.appearance).toBe("dark");
		expect(merged.readingScale).toBe(1.5);
		expect(merged.topToolbar).toBe(false);
		expect(merged.outlineOpen).toBe(true);
	});

	it("keeps the local value for a synced key the server does not carry", () => {
		// This is what makes adding a setting safe: an older client round-tripping
		// the object must not erase a key it has never heard of.
		const merged = mergeSyncedJson(local, JSON.stringify({ lint: true }));
		expect(merged.lint).toBe(true);
		expect(merged.theme).toBe("moonlit");
	});

	it("ignores a payload that is not a JSON object", () => {
		for (const json of ["", "nonsense", "[]", '"x"', "7", "null"]) {
			expect(mergeSyncedJson(local, json)).toEqual(local);
		}
	});

	it("ignores invalid values inside a valid object", () => {
		const merged = mergeSyncedJson(
			local,
			JSON.stringify({ theme: "chartreuse", readingFont: "serif" }),
		);
		expect(merged.theme).toBe("moonlit");
		expect(merged.readingFont).toBe("serif");
	});

	it("round-trips: serialize then merge is a no-op on the synced subset", () => {
		const other: StudioSettings = {
			...DEFAULTS,
			theme: "aurora",
			lint: true,
			aiEnabled: true,
			dailyGoalTarget: 500,
		};
		const merged = mergeSyncedJson(local, serializeSynced(other));
		expect(pickSynced(merged)).toEqual(pickSynced(other));
	});
});

describe("unknown properties (forward compatibility)", () => {
	const stored = JSON.stringify({
		theme: "dawn",
		futureSetting: 42,
		nested: { a: 1 },
		// A device-local key has no business in the stored object, and must not
		// be made permanent by being carried through as "unknown".
		appearance: "light",
	});

	it("picks out only the properties this build cannot name", () => {
		expect(pickUnknown(stored)).toEqual({
			futureSetting: 42,
			nested: { a: 1 },
		});
	});

	it("returns nothing for a payload that is not a JSON object", () => {
		for (const json of ["", "nope", "[]", "7", "null"]) {
			expect(pickUnknown(json)).toEqual({});
		}
	});

	it("writes unknown properties back, with this build's values winning", () => {
		const json = serializeSynced(
			{ ...DEFAULTS, theme: "aurora" },
			pickUnknown(stored),
		);
		const parsed = JSON.parse(json);
		// The whole point: an older client must not delete a newer one's settings
		// by writing back "the whole object".
		expect(parsed.futureSetting).toBe(42);
		expect(parsed.theme).toBe("aurora");
		expect(parsed).not.toHaveProperty("appearance");
	});

	it("serializes canonically, so two clients holding the same state agree", () => {
		const unknown = { zzz: 1, aaa: 2 };
		const reordered = { aaa: 2, zzz: 1 };
		expect(serializeSynced(DEFAULTS, unknown)).toBe(
			serializeSynced(DEFAULTS, reordered),
		);
	});
});

describe("changedSyncedKeys", () => {
	it("reports nothing for identical states", () => {
		expect(changedSyncedKeys(DEFAULTS, { ...DEFAULTS })).toEqual([]);
	});

	it("ignores device-local changes — those must not cost a mutation", () => {
		expect(
			changedSyncedKeys(DEFAULTS, {
				...DEFAULTS,
				appearance: "dark",
				readingScale: 1.4,
				topToolbar: false,
				outlineOpen: true,
			}),
		).toEqual([]);
	});

	it("reports a changed nested value", () => {
		expect(
			changedSyncedKeys(DEFAULTS, {
				...DEFAULTS,
				lintCategories: { ...DEFAULTS.lintCategories, passive: false },
			}),
		).toEqual(["lintCategories"]);
	});
});

describe("mergeSyncedJson with locally-held keys", () => {
	it("keeps the keys this device is still holding, and adopts the rest", () => {
		const local: StudioSettings = {
			...DEFAULTS,
			theme: "moonlit",
			readingFont: "sans",
		};
		const winner = serializeSynced({
			...DEFAULTS,
			theme: "dawn",
			readingFont: "serif",
		});

		const merged = mergeSyncedJson(local, winner, new Set(["theme"]));
		// The writer's own unsent change survives losing the compare-and-set.
		expect(merged.theme).toBe("moonlit");
		expect(merged.readingFont).toBe("serif");
	});

	it("adopts everything when nothing is held", () => {
		const merged = mergeSyncedJson(
			{ ...DEFAULTS, theme: "moonlit" },
			serializeSynced({ ...DEFAULTS, theme: "dawn" }),
		);
		expect(merged.theme).toBe("dawn");
	});
});
