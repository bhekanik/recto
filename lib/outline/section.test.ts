import { describe, expect, it } from "vitest";

import { sectionAtOffset } from "./section";

const doc = [
	"---",
	"title: Draft",
	"---",
	"",
	"Opening line.",
	"",
	"# One",
	"",
	"First body.",
	"",
	"## One point one",
	"",
	"Nested body.",
	"",
	"# Two",
	"",
	"Second body.",
].join("\n");

describe("sectionAtOffset", () => {
	it("returns the heading's section, nested subsections included", () => {
		expect(sectionAtOffset(doc, doc.indexOf("First body"))).toBe(
			"# One\n\nFirst body.\n\n## One point one\n\nNested body.",
		);
	});

	it("stops a subsection at the next heading of the same or higher level", () => {
		expect(sectionAtOffset(doc, doc.indexOf("Nested body"))).toBe(
			"## One point one\n\nNested body.",
		);
	});

	it("runs the last section to the end of the document", () => {
		expect(sectionAtOffset(doc, doc.length)).toBe("# Two\n\nSecond body.");
	});

	it("returns the text before the first heading, without frontmatter", () => {
		expect(sectionAtOffset(doc, doc.indexOf("Opening"))).toBe("Opening line.");
	});

	it("returns the whole body when there are no headings", () => {
		expect(sectionAtOffset("Just prose.\n\nMore prose.", 3)).toBe(
			"Just prose.\n\nMore prose.",
		);
	});

	it("treats a caret on the heading line as inside that section", () => {
		expect(sectionAtOffset(doc, doc.indexOf("# Two") + 2)).toBe(
			"# Two\n\nSecond body.",
		);
	});
});
