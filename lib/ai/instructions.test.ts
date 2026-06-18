import { describe, expect, it } from "vitest";

import {
	findPreset,
	instructionLabel,
	TRANSFORM_PRESETS,
} from "./instructions";

describe("transform presets (plan 009)", () => {
	it("has at least the four documented presets", () => {
		const ids = TRANSFORM_PRESETS.map((p) => p.id);
		expect(ids).toEqual(
			expect.arrayContaining(["tighten", "rewrite", "expand", "fix-grammar"]),
		);
	});

	it("has unique ids", () => {
		const ids = TRANSFORM_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("has non-empty labels and prompts", () => {
		for (const p of TRANSFORM_PRESETS) {
			expect(p.label.trim().length).toBeGreaterThan(0);
			expect(p.prompt.trim().length).toBeGreaterThan(0);
		}
	});

	it("findPreset returns the preset by id and undefined for unknown", () => {
		expect(findPreset("tighten")?.label).toBe("Tighten");
		expect(findPreset("nope")).toBeUndefined();
	});
});

describe("instructionLabel", () => {
	it("uses the preset label when a preset id is given", () => {
		expect(instructionLabel({ presetId: "tighten" })).toBe("Tighten");
	});

	it("uses free text when no preset", () => {
		expect(instructionLabel({ freeText: "make it sound formal" })).toBe(
			"make it sound formal",
		);
	});

	it("truncates long free text", () => {
		const label = instructionLabel({
			freeText: "a very long instruction that should be truncated nicely",
		});
		expect(label.endsWith("…")).toBe(true);
		expect(label.length).toBeLessThanOrEqual(25);
	});

	it("falls back to a generic label when empty", () => {
		expect(instructionLabel({})).toBe("edit");
		expect(instructionLabel({ freeText: "   " })).toBe("edit");
	});
});
