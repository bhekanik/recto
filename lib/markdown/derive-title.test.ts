import { describe, expect, it } from "vitest";
import fixture from "@/packages/editor-fixtures/title.json";

import { deriveTitleFromMarkdown } from "./derive-title";

describe("deriveTitleFromMarkdown", () => {
	it("matches the shared native title corpus", () => {
		for (const testCase of fixture.cases) {
			expect(deriveTitleFromMarkdown(testCase.markdown), testCase.name).toBe(
				testCase.title,
			);
		}
	});

	it("uses frontmatter title before body content", () => {
		expect(
			deriveTitleFromMarkdown(
				"---\ntitle: Frontmatter title\n---\n\n# Heading",
			),
		).toBe("Frontmatter title");
	});

	it("uses the first non-empty heading before prose", () => {
		expect(deriveTitleFromMarkdown("Intro first.\n\n## **Actual** title")).toBe(
			"Actual title",
		);
	});

	it("falls back to the first usable paragraph", () => {
		expect(
			deriveTitleFromMarkdown("A **plain** [opening](https://example.com)."),
		).toBe("A plain opening.");
	});

	it("ignores frontmatter without a title when finding body prose", () => {
		expect(
			deriveTitleFromMarkdown("---\ntags: [one, two]\n---\n\nBody title"),
		).toBe("Body title");
	});

	it("returns Untitled when no heading or prose has text", () => {
		expect(deriveTitleFromMarkdown("---\ntitle: '  '\n---\n\n---")).toBe(
			"Untitled",
		);
	});
});
