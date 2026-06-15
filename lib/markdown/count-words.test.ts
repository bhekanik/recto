import { describe, expect, it } from "vitest";

import { countWords, countWordsFromPlainText } from "./count-words";

describe("countWords", () => {
	it("returns 0 for empty markdown", () => {
		expect(countWords("")).toBe(0);
		expect(countWords("   \n\n  ")).toBe(0);
	});

	it("counts prose words, not markdown syntax", () => {
		const md = "# Hello world\n\nThis is **bold** and _italic_.";
		expect(countWords(md)).toBe(8);
	});

	it("counts words in a GFM table as prose", () => {
		const md = "| col a | col b |\n| ----- | ----- |\n| one   | two   |";
		expect(countWords(md)).toBeGreaterThan(0);
	});

	it("counts list item text", () => {
		const md = "- first item\n- second item";
		expect(countWords(md)).toBe(4);
	});
});

describe("countWordsFromPlainText", () => {
	it("collapses whitespace", () => {
		expect(countWordsFromPlainText("one   two\tthree")).toBe(3);
	});
});
