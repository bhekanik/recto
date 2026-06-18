import { describe, expect, it } from "vitest";

import { extractOutline } from "@/lib/outline/extract";

describe("extractOutline", () => {
	it("returns nested headings in document order with depth + index", () => {
		const md = `# A\n\n## B\n\n### C\n\n## D\n`;
		const outline = extractOutline(md);
		expect(outline.map((h) => h.depth)).toEqual([1, 2, 3, 2]);
		expect(outline.map((h) => h.index)).toEqual([0, 1, 2, 3]);
		expect(outline.map((h) => h.text)).toEqual(["A", "B", "C", "D"]);
	});

	it("returns an empty array for a doc with no headings", () => {
		const md = `Just a plain paragraph.\n\nAnd another one.\n`;
		expect(extractOutline(md)).toEqual([]);
	});

	it("keeps duplicate titles distinct by index", () => {
		const md = `## Notes\n\nfirst\n\n## Notes\n\nsecond\n`;
		const outline = extractOutline(md);
		expect(outline).toHaveLength(2);
		expect(outline[0]?.text).toBe("Notes");
		expect(outline[1]?.text).toBe("Notes");
		expect(outline[0]?.index).toBe(0);
		expect(outline[1]?.index).toBe(1);
	});

	it("excludes ### inside a fenced code block", () => {
		const md = "```\n### not a heading\n```\n\n## Real\n";
		const outline = extractOutline(md);
		expect(outline).toHaveLength(1);
		expect(outline[0]?.text).toBe("Real");
		expect(outline[0]?.depth).toBe(2);
	});

	it("strips inline markdown from heading text", () => {
		const md = `## Hello **world**\n`;
		const outline = extractOutline(md);
		expect(outline).toHaveLength(1);
		expect(outline[0]?.text).toBe("Hello world");
	});

	it("does not treat YAML frontmatter as a heading", () => {
		const md = `---\ntitle: My Doc\n---\n\n# Title\n`;
		const outline = extractOutline(md);
		expect(outline).toHaveLength(1);
		expect(outline[0]?.text).toBe("Title");
		expect(outline[0]?.depth).toBe(1);
	});

	it("produces monotonic non-decreasing offsets across headings", () => {
		const md = `# A\n\n## B\n\n### C\n\n## D\n`;
		const offsets = extractOutline(md).map((h) => h.offset);
		for (let i = 1; i < offsets.length; i++) {
			expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] as number);
		}
	});

	it("keeps empty-text headings so indices stay aligned", () => {
		const md = `# \n\n## Real\n`;
		const outline = extractOutline(md);
		expect(outline).toHaveLength(2);
		expect(outline[0]?.text).toBe("");
		expect(outline[1]?.text).toBe("Real");
		expect(outline.map((h) => h.index)).toEqual([0, 1]);
	});
});
