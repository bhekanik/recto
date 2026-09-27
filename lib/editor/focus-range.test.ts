import { describe, expect, it } from "vitest";

import { activeFocusRange } from "./focus-range";

describe("activeFocusRange", () => {
	it("returns null for empty or whitespace-only text", () => {
		expect(activeFocusRange("", 0, "sentence")).toBeNull();
		expect(activeFocusRange("   \n\n  ", 3, "sentence")).toBeNull();
		expect(activeFocusRange("", 0, "paragraph")).toBeNull();
	});

	it("returns the full range for a single sentence (caret in middle)", () => {
		const text = "Hello world.";
		expect(activeFocusRange(text, 5, "sentence")).toEqual({
			from: 0,
			to: text.length,
		});
		expect(activeFocusRange(text, 5, "paragraph")).toEqual({
			from: 0,
			to: text.length,
		});
	});

	it("picks the sentence containing the caret (sentence scope)", () => {
		const text = "Hello world. How are you? I am fine.";
		// Caret inside "How are you?" (index 13..25, trailing space trimmed).
		const range = activeFocusRange(text, 15, "sentence");
		expect(range).toEqual({ from: 13, to: 25 });
		expect(text.slice(range?.from, range?.to)).toBe("How are you?");
	});

	it("returns the whole string for paragraph scope on single-paragraph text", () => {
		const text = "Hello world. How are you? I am fine.";
		expect(activeFocusRange(text, 15, "paragraph")).toEqual({
			from: 0,
			to: text.length,
		});
	});

	it("scopes to the paragraph containing the caret (multi-paragraph)", () => {
		const text = "Para one.\n\nPara two here.";
		const secondStart = text.indexOf("Para two"); // 11
		// Paragraph scope = just the second paragraph block.
		expect(activeFocusRange(text, secondStart + 2, "paragraph")).toEqual({
			from: secondStart,
			to: text.length,
		});
		// Sentence scope stays within the second paragraph.
		const sentence = activeFocusRange(text, secondStart + 2, "sentence");
		expect(sentence?.from).toBeGreaterThanOrEqual(secondStart);
		expect(sentence?.to).toBeLessThanOrEqual(text.length);
		expect(text.slice(sentence?.from, sentence?.to)).toBe("Para two here.");
	});

	it("a space just typed at the end of a paragraph keeps it lit", () => {
		const text = "One two.\nth other al \n\n## heading\nis the place";
		const caret = text.indexOf("al ") + 3;
		expect(activeFocusRange(text, caret, "paragraph")).toEqual({
			from: 0,
			to: text.indexOf("al ") + 2,
		});
		expect(activeFocusRange(text, caret, "sentence")?.from).toBeLessThan(caret);
		// The same at the very end of the text, and mid-paragraph.
		expect(activeFocusRange("Last words ", 11, "paragraph")).toEqual({
			from: 0,
			to: 10,
		});
		const mid = "First line \nsecond\n\nNext";
		expect(activeFocusRange(mid, 11, "paragraph")).toEqual({ from: 0, to: 18 });
	});

	it("a caret on a blank line still belongs to the paragraph below", () => {
		const text = "Para one.\n\nPara two.";
		expect(activeFocusRange(text, 10, "paragraph")).toEqual({
			from: 11,
			to: 20,
		});
	});

	it("scopes the first paragraph when the caret is there", () => {
		const text = "Para one.\n\nPara two here.";
		const range = activeFocusRange(text, 2, "paragraph");
		expect(range).toEqual({ from: 0, to: "Para one.".length });
	});

	it("clamps a caret past the end of the text", () => {
		const text = "Only sentence here.";
		expect(activeFocusRange(text, 9999, "sentence")).toEqual({
			from: 0,
			to: text.length,
		});
		expect(activeFocusRange(text, -50, "sentence")).toEqual({
			from: 0,
			to: text.length,
		});
	});

	it("does not crash on abbreviations and returns a valid non-empty range", () => {
		const text = "See Dr. Smith soon, e.g. tomorrow morning.";
		const range = activeFocusRange(text, 10, "sentence");
		expect(range).not.toBeNull();
		// Whatever Intl.Segmenter decides, the range must be valid and contiguous.
		expect(range?.from).toBeGreaterThanOrEqual(0);
		expect(range?.to).toBeLessThanOrEqual(text.length);
		expect((range?.to ?? 0) - (range?.from ?? 0)).toBeGreaterThan(0);
	});
});
