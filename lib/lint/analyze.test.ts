import { describe, expect, it } from "vitest";

import { analyze } from "./analyze";
import { ALL_CATEGORIES } from "./types";

const ALL = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true])) as Record<
	(typeof ALL_CATEGORIES)[number],
	boolean
>;

describe("analyze", () => {
	it("returns nothing for empty text", async () => {
		expect(await analyze("", ALL)).toEqual([]);
		expect(await analyze("   \n\n  ", ALL)).toEqual([]);
	});

	it("flags passive voice", async () => {
		const text = "The report was written by Jane.";
		const issues = (await analyze(text, ALL)).filter(
			(i) => i.category === "passive",
		);
		expect(issues.length).toBeGreaterThan(0);
		const first = issues[0];
		if (!first) throw new Error("expected a passive issue");
		// The flagged span sits inside the sentence and names the passive verb.
		expect(text.slice(first.from, first.to)).toMatch(/written/);
	});

	it("flags an adverb", async () => {
		const text = "She quickly ran home.";
		const issues = (await analyze(text, ALL)).filter(
			(i) => i.category === "adverb",
		);
		expect(issues.length).toBeGreaterThan(0);
		const first = issues[0];
		if (!first) throw new Error("expected an adverb issue");
		expect(text.slice(first.from, first.to)).toContain("quickly");
	});

	it("flags a long / hard-to-read sentence", async () => {
		const text =
			"This is an extraordinarily long and convoluted sentence that keeps " +
			"going and going with many clauses and qualifications and asides so " +
			"that the reader struggles to hold the whole thought in mind at once.";
		const issues = (await analyze(text, ALL)).filter(
			(i) => i.category === "readability",
		);
		expect(issues.length).toBeGreaterThan(0);
	});

	it("flags a weasel / filler word", async () => {
		const text = "This is very important and clearly obvious.";
		const issues = (await analyze(text, ALL)).filter(
			(i) => i.category === "weasel",
		);
		expect(issues.length).toBeGreaterThan(0);
		const first = issues[0];
		if (!first) throw new Error("expected a weasel issue");
		expect(text.slice(first.from, first.to)).toMatch(/very|clearly/);
	});

	it("respects category toggles", async () => {
		const text = "She quickly ran home.";
		const off = { ...ALL, adverb: false };
		expect(
			(await analyze(text, off)).some((i) => i.category === "adverb"),
		).toBe(false);
	});

	it("carries the exact substring as `text` for ProseMirror re-search", async () => {
		const text = "She quickly ran home.";
		for (const issue of await analyze(text, ALL)) {
			expect(issue.text).toBe(text.slice(issue.from, issue.to));
		}
	});

	it("returns ranges within bounds and from < to", async () => {
		const text = "The cake was eaten very quickly by the dog.";
		for (const i of await analyze(text, ALL)) {
			expect(i.from).toBeGreaterThanOrEqual(0);
			expect(i.to).toBeLessThanOrEqual(text.length);
			expect(i.from).toBeLessThan(i.to);
		}
	});
});
