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

	it("ignores fenced and inline code", async () => {
		const text = [
			"Run this:",
			"",
			"```sh",
			"# the file is written by the build and is really very slow",
			"```",
			"",
			"Then call `was_really_written_by` once.",
		].join("\n");
		expect(await analyze(text, ALL)).toEqual([]);
	});

	it("does not let a link URL make a short sentence hard to read", async () => {
		const text =
			"See [the docs](https://example.com/extraordinarily/convoluted/documentation/path/internationalization) now.";
		expect(
			(await analyze(text, ALL)).filter((i) => i.category === "readability"),
		).toEqual([]);
	});

	it("reports the source substring when a flagged sentence spans a link", async () => {
		const text =
			"This is an extraordinarily long and convoluted sentence that keeps " +
			"going and going with [many clauses](https://example.com) and " +
			"qualifications and asides so that the reader struggles to hold the " +
			"whole thought in mind at once.";
		const issues = (await analyze(text, ALL)).filter(
			(i) => i.category === "readability",
		);
		expect(issues.length).toBeGreaterThan(0);
		for (const issue of issues) {
			expect(issue.text).toBe(text.slice(issue.from, issue.to));
		}
	});

	it("still flags prose in link text and keeps source offsets", async () => {
		const text =
			"```\nwas written\n```\n\nRead [what was written by Jane](https://example.com).";
		const issues = (await analyze(text, ALL)).filter(
			(i) => i.category === "passive",
		);
		expect(issues).toHaveLength(1);
		const first = issues[0];
		if (!first) throw new Error("expected a passive issue");
		expect(first.from).toBeGreaterThan(text.indexOf("Read"));
		expect(text.slice(first.from, first.to)).toBe(first.text);
		expect(first.text).toMatch(/written/);
	});
});
