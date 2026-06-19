import { describe, expect, it } from "vitest";

import { type CommentAnchor, createAnchor } from "@/lib/review/anchor";
import { applyEdits, resolveEdit } from "./review-apply";

/**
 * Build a canonical anchor for `quote` against `markdown` (mirrors how the hook
 * builds anchors via plan 010's `createAnchor` at the located offset), so the
 * anchor's prefix/suffix disambiguate repeated quotes the same way production does.
 */
function anchorFor(markdown: string, quote: string): CommentAnchor {
	const idx = markdown.indexOf(quote);
	if (idx < 0) {
		// An anchor whose quote is absent — locateAnchor must fail to place it.
		return { quote, prefix: "", suffix: "", offsetHint: 0 };
	}
	return createAnchor(markdown, idx, idx + quote.length);
}

const edit = (markdown: string, quote: string, replacement: string) => ({
	anchor: anchorFor(markdown, quote),
	replacement,
});

describe("resolveEdit", () => {
	it("resolves a unique quote to its located span", () => {
		const md = "The quick brown fox.";
		const r = resolveEdit(md, anchorFor(md, "quick"), "slow");
		expect(r).toEqual({ from: 4, to: 9, replacement: "slow" });
	});

	it("returns null when the quote is absent", () => {
		const md = "The quick brown fox.";
		expect(resolveEdit(md, anchorFor(md, "elephant"), "x")).toBeNull();
	});
});

describe("applyEdits", () => {
	it("applies a single edit on a unique quote", () => {
		const md = "The quick brown fox.";
		const out = applyEdits(md, [edit(md, "quick", "slow")]);
		expect(out.markdown).toBe("The slow brown fox.");
		expect(out.applied).toBe(1);
		expect(out.dropped).toBe(0);
	});

	it("applies multiple non-overlapping edits (right-to-left keeps offsets valid)", () => {
		const md = "The quick brown fox jumps over the lazy dog.";
		// Two edits at different offsets; replacements differ in length so a
		// left-to-right splice WOULD corrupt the second offset — this proves the
		// right-to-left ordering.
		const out = applyEdits(md, [
			edit(md, "quick", "extraordinarily nimble"),
			edit(md, "lazy dog", "sleepy hound"),
		]);
		expect(out.markdown).toBe(
			"The extraordinarily nimble brown fox jumps over the sleepy hound.",
		);
		expect(out.applied).toBe(2);
		expect(out.dropped).toBe(0);
	});

	it("drops an unlocatable edit but still applies the others", () => {
		const md = "The quick brown fox.";
		const out = applyEdits(md, [
			edit(md, "quick", "slow"),
			edit(md, "elephant", "mouse"), // quote absent → dropped
		]);
		expect(out.markdown).toBe("The slow brown fox.");
		expect(out.applied).toBe(1);
		expect(out.dropped).toBe(1);
	});

	it("drops the later overlapping edit and keeps the earlier one", () => {
		const md = "The quick brown fox.";
		// Both edits resolve to overlapping spans: "quick brown" [4,15) and
		// "brown fox" [10,19). The earlier (by start offset) is kept; the later dropped.
		const out = applyEdits(md, [
			edit(md, "brown fox", "red hound"),
			edit(md, "quick brown", "slow grey"),
		]);
		expect(out.markdown).toBe("The slow grey fox.");
		expect(out.applied).toBe(1);
		expect(out.dropped).toBe(1);
	});

	it("leaves the markdown unchanged for an empty edit list", () => {
		const md = "The quick brown fox.";
		const out = applyEdits(md, []);
		expect(out.markdown).toBe(md);
		expect(out.applied).toBe(0);
		expect(out.dropped).toBe(0);
	});
});
