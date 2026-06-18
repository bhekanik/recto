// Expected strings are VERIFIED canonical output (observed from the live
// converter), not guessed. If CANONICAL_STRINGIFY ever changes, from-html.ts
// follows automatically — but these expected strings must be re-baselined.
import { describe, expect, it } from "vitest";

import { markdownFromHtml } from "@/lib/markdown/from-html";
import { normalizeMarkdown } from "@/lib/markdown/normalize";

/** Assert the converter output is canonical-stable (parse→stringify identity). */
function expectRoundTrip(out: string): void {
	expect(normalizeMarkdown(out)).toBe(out);
}

describe("markdownFromHtml", () => {
	it("converts Word-style <b>/<i> to canonical markers", () => {
		const out = markdownFromHtml("<p><b>bold</b> and <i>ital</i></p>");
		expect(out.trim()).toBe("**bold** and _ital_");
		expectRoundTrip(out);
	});

	it("converts <strong>/<em> to canonical markers", () => {
		const out = markdownFromHtml(
			"<p><strong>bold</strong> and <em>ital</em></p>",
		);
		expect(out.trim()).toBe("**bold** and _ital_");
		expectRoundTrip(out);
	});

	it("converts headings to ATX (setext: false)", () => {
		const out = markdownFromHtml("<h1>Title</h1><h2>Sub</h2>");
		expect(out.trim()).toBe("# Title\n\n## Sub");
		expectRoundTrip(out);
	});

	it("converts nested bullet lists with one-space indent and - bullets", () => {
		const out = markdownFromHtml(
			"<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>",
		);
		expect(out.trim()).toBe("- one\n  - nested\n- two");
		expectRoundTrip(out);
	});

	it("converts ordered lists to 1. 2. with incrementing markers", () => {
		const out = markdownFromHtml("<ol><li>a</li><li>b</li></ol>");
		expect(out.trim()).toBe("1. a\n2. b");
		expectRoundTrip(out);
	});

	it("converts links to canonical inline form", () => {
		const out = markdownFromHtml('<a href="https://x.com">x</a>');
		expect(out.trim()).toBe("[x](https://x.com)");
		expectRoundTrip(out);
	});

	it("converts a GFM table to a pipe table (remark-gfm)", () => {
		const out = markdownFromHtml(
			"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
		);
		expect(out.trim()).toBe("| A | B |\n| - | - |\n| 1 | 2 |");
		expectRoundTrip(out);
	});

	it("converts strikethrough (remark-gfm)", () => {
		const out = markdownFromHtml("<p><del>gone</del></p>");
		expect(out.trim()).toBe("~~gone~~");
		expectRoundTrip(out);
	});

	it("converts GFM task lists", () => {
		const out = markdownFromHtml(
			'<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>',
		);
		expect(out.trim()).toBe("- [x] done\n- [ ] todo");
		expectRoundTrip(out);
	});

	it("keeps smart quotes / em-dash as UTF-8 and round-trips them", () => {
		const out = markdownFromHtml("<p>“hi” — there</p>");
		expect(out.trim()).toBe("“hi” — there");
		expectRoundTrip(out);
	});

	it("strips scripts and style attributes (no leakage)", () => {
		const out = markdownFromHtml(
			'<p style="mso-x">t</p><script>bad()</script>',
		);
		expect(out.trim()).toBe("t");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("style");
		expect(out).not.toContain("mso-");
		expectRoundTrip(out);
	});

	it("converts a plain paragraph to plain text", () => {
		const out = markdownFromHtml("<p>just text</p>");
		expect(out.trim()).toBe("just text");
		expectRoundTrip(out);
	});
});
