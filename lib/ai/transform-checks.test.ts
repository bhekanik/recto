import { describe, expect, it } from "vitest";

import { transformWarnings } from "./transform-checks";

describe("transformWarnings", () => {
	it("passes a grammar fix that only corrects", () => {
		expect(
			transformWarnings({
				presetId: "fix-grammar",
				original: "Their going to the store tomorow, and me too.",
				rewritten: "They're going to the store tomorrow, and me too.",
			}),
		).toEqual([]);
	});

	it("flags a grammar fix that rewrote the passage", () => {
		const [warning] = transformWarnings({
			presetId: "fix-grammar",
			original: "Their going to the store tomorow, and me too.",
			rewritten: "Tomorrow we will all head out to buy groceries together.",
		});
		expect(warning).toMatch(/^Rewrote \d+% of the words/);
	});

	it("does not apply the grammar rule to other instructions", () => {
		expect(
			transformWarnings({
				presetId: "rewrite",
				original: "Their going to the store tomorow, and me too.",
				rewritten: "Tomorrow we will all head out to buy groceries together.",
			}),
		).toEqual([]);
	});

	it("flags tighten that grew and expand that shrank", () => {
		expect(
			transformWarnings({
				presetId: "tighten",
				original: "A short line.",
				rewritten: "A considerably longer line than the one before it.",
			}),
		).toEqual(["Tighten made it longer: 3 words became 9."]);
		expect(
			transformWarnings({
				presetId: "expand",
				original: "A considerably longer line than the one before it.",
				rewritten: "A short line.",
			}),
		).toEqual(["Expand made it shorter: 9 words became 3."]);
	});

	it("flags Markdown the rewrite dropped", () => {
		expect(
			transformWarnings({
				original:
					"Read [the docs](https://example.com) and run `bun test`.\n\n- one\n- two",
				rewritten: "Read the docs and run bun test. One, two.",
			}),
		).toEqual(["Dropped Markdown: 1 link, 1 inline code, 1 list."]);
	});

	it("does not flag Markdown the rewrite added", () => {
		expect(
			transformWarnings({
				original: "Plain words.",
				rewritten: "Plain **words** with [a link](https://example.com).",
			}),
		).toEqual([]);
	});

	it("flags a chat preamble before the rewrite", () => {
		expect(
			transformWarnings({
				original: "A line.",
				rewritten: "Here's the tightened version:\n\nA line.",
			}),
		).toEqual(["Starts with a note from the model, not your text."]);
		expect(
			transformWarnings({
				original: "A line.",
				rewritten: "Here is where we begin.",
			}),
		).toEqual([]);
	});
});
