import { describe, expect, it } from "vitest";

import {
	CONTEXT_LEN,
	type CommentAnchor,
	createAnchor,
	locateAnchor,
} from "./anchor";

/** Find the first index of `needle` in `text` (test helper for offsets). */
const at = (text: string, needle: string) => text.indexOf(needle);

describe("createAnchor (plan 010 Phase B)", () => {
	it("captures the quote plus a bounded prefix/suffix context window", () => {
		const md = "The quick brown fox jumps over the lazy dog.";
		const from = at(md, "brown fox");
		const to = from + "brown fox".length;
		const anchor = createAnchor(md, from, to);

		expect(anchor.quote).toBe("brown fox");
		expect(anchor.offsetHint).toBe(from);
		expect(anchor.suffix.startsWith(" jumps")).toBe(true);
		expect(anchor.prefix.endsWith("quick ")).toBe(true);
		expect(anchor.prefix.length).toBeLessThanOrEqual(CONTEXT_LEN);
		expect(anchor.suffix.length).toBeLessThanOrEqual(CONTEXT_LEN);
	});

	it("grows an empty selection to the enclosing word", () => {
		const md = "alpha beta gamma";
		const caret = at(md, "beta") + 2; // inside "beta"
		const anchor = createAnchor(md, caret, caret);
		expect(anchor.quote).toBe("beta");
	});

	it("normalizes a reversed range (from > to)", () => {
		const md = "one two three";
		const a = at(md, "two");
		const anchor = createAnchor(md, a + 3, a); // reversed
		expect(anchor.quote).toBe("two");
	});
});

describe("locateAnchor — exact + context (plan 010 Phase B)", () => {
	it("re-locates an unchanged document to the original range", () => {
		const md = "The quiet river wound through the valley before the storm.";
		const from = at(md, "wound through");
		const to = from + "wound through".length;
		const anchor = createAnchor(md, from, to);

		const located = locateAnchor(md, anchor);
		expect(located).not.toBeNull();
		expect(located).toEqual({ from, to });
		expect(md.slice(located?.from, located?.to)).toBe("wound through");
	});

	it("survives an insertion BEFORE the quote (offset shifts; relocated by text)", () => {
		const md = "The river wound through the valley.";
		const from = at(md, "wound through");
		const anchor = createAnchor(md, from, from + "wound through".length);

		const edited = `A long new opening sentence was added here. ${md}`;
		const located = locateAnchor(edited, anchor);
		expect(located).not.toBeNull();
		expect(edited.slice(located?.from, located?.to)).toBe("wound through");
		// The offset moved relative to the stored hint.
		expect(located?.from).not.toBe(anchor.offsetHint);
	});

	it("survives an insertion AFTER the quote", () => {
		const md = "The river wound through the valley.";
		const from = at(md, "wound through");
		const anchor = createAnchor(md, from, from + "wound through".length);

		const edited = `${md} It kept flowing for many more miles afterwards.`;
		const located = locateAnchor(edited, anchor);
		expect(located).not.toBeNull();
		expect(edited.slice(located?.from, located?.to)).toBe("wound through");
	});

	it("disambiguates a REPEATED quote by prefix/suffix to the correct occurrence", () => {
		// "the value" appears twice; the anchor's context picks the second one.
		const md = "Set the value to ten. Later, reset the value to zero.";
		const second = md.lastIndexOf("the value");
		const anchor = createAnchor(md, second, second + "the value".length);

		// Sanity: there really are two occurrences.
		expect(md.indexOf("the value")).not.toBe(second);

		const located = locateAnchor(md, anchor);
		expect(located).not.toBeNull();
		expect(located?.from).toBe(second);
		expect(md.slice(located?.from, located?.to)).toBe("the value");
	});

	it("disambiguates the FIRST occurrence of a repeated quote too", () => {
		const md = "Set the value to ten. Later, reset the value to zero.";
		const first = md.indexOf("the value");
		const anchor = createAnchor(md, first, first + "the value".length);

		const located = locateAnchor(md, anchor);
		expect(located?.from).toBe(first);
	});
});

describe("locateAnchor — fuzzy fallback + orphan (plan 010 Phase B)", () => {
	it("relocates approximately when the quote was lightly edited (fuzzy near-match)", () => {
		const md =
			"The committee reviewed the quarterly financial report in detail.";
		const from = at(md, "quarterly financial report");
		const anchor = createAnchor(
			md,
			from,
			from + "quarterly financial report".length,
		);

		// Edit a word INSIDE the quote — no verbatim match remains.
		const edited =
			"The committee reviewed the quarterly financials report in detail.";
		const located = locateAnchor(edited, anchor);
		expect(located).not.toBeNull();
		const slice = edited.slice(located?.from, located?.to);
		// The relocated span overlaps the edited quote region (contains the anchor words).
		expect(slice.includes("financials report")).toBe(true);
	});

	it("returns null (orphan) when the quote is fully deleted", () => {
		const md =
			"Keep this paragraph. Delete the targeted sentence entirely here.";
		const from = at(md, "the targeted sentence entirely");
		const anchor = createAnchor(
			md,
			from,
			from + "the targeted sentence entirely".length,
		);

		// Remove the quoted text (and its neighborhood) — nothing similar survives.
		const edited = "Keep this paragraph. Different unrelated content now.";
		expect(locateAnchor(edited, anchor)).toBeNull();
	});

	it("returns null for an empty quote", () => {
		const anchor: CommentAnchor = {
			quote: "",
			prefix: "",
			suffix: "",
			offsetHint: 0,
		};
		expect(locateAnchor("anything", anchor)).toBeNull();
	});
});
