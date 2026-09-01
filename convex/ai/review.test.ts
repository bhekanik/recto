import { describe, expect, it } from "vitest";
import { applySuggestions } from "./review";

describe("AI review suggestion accounting", () => {
	it("counts only unique, non-overlapping, material edits", () => {
		const result = applySuggestions("alpha beta alpha", [
			{ quote: "beta", replacement: "BETA" },
			{ quote: "alpha", replacement: "A" },
			{ quote: "alpha beta", replacement: "AB" },
			{ quote: "beta", replacement: "beta" },
		]);
		expect(result).toEqual({ text: "alpha BETA alpha", applied: 1 });
	});
});
