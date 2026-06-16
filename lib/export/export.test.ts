import { describe, expect, it } from "vitest";

import { diffLines } from "@/lib/history/diff";
import { safeFilename } from "./file";
import { generateExportHtml } from "./html";

describe("safeFilename", () => {
	it("strips illegal characters and caps length", () => {
		expect(safeFilename('a/b:c*?"<>|d')).toBe("a-b-c------d");
		expect(safeFilename("  spaced  out  ")).toBe("spaced out");
		expect(safeFilename("")).toBe("untitled");
		expect(safeFilename("x".repeat(200)).length).toBe(120);
	});
});

describe("generateExportHtml", () => {
	it("renders the frontmatter title/subtitle as a document header", () => {
		const md =
			"---\ntitle: Secret\nsubtitle: A subtitle\n---\n\n# Heading\n\nA **paragraph**.\n";
		const html = generateExportHtml(md, "My Doc");
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("<style>");
		// The document title comes from frontmatter; the arg is only a fallback.
		expect(html).toContain("<title>Secret</title>");
		expect(html).toContain('<header class="recto-doc-header">');
		expect(html).toContain("<h1>Secret</h1>");
		expect(html).toContain("A subtitle");
		expect(html).toContain("<strong>paragraph</strong>");
		// The raw YAML block never leaks as text into the body.
		expect(html).not.toContain("title: Secret");
	});

	it("falls back to the passed title and emits no header without frontmatter", () => {
		const html = generateExportHtml("# Heading\n\nBody.\n", "My Doc");
		expect(html).toContain("<title>My Doc</title>");
		expect(html).not.toContain('<header class="recto-doc-header">');
		expect(html).toContain("<h1>Heading</h1>");
	});

	it("renders GFM tables", () => {
		const md = "| a | b |\n| - | - |\n| 1 | 2 |\n";
		const html = generateExportHtml(md, "T");
		expect(html).toContain("<table>");
		expect(html).toContain("<td>1</td>");
	});
});

describe("diffLines", () => {
	it("marks added, removed, and unchanged lines", () => {
		const result = diffLines("a\nb\nc", "a\nx\nc");
		expect(result).toEqual([
			{ type: "same", text: "a" },
			{ type: "del", text: "b" },
			{ type: "add", text: "x" },
			{ type: "same", text: "c" },
		]);
	});
});
