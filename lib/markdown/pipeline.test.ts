import { describe, expect, it } from "vitest";

import { countWords, normalizeMarkdown } from "@/lib/markdown";

const SAMPLE = `# Hello Recto

This is a **live** writing surface with _emphasis_.

- item one
- item two

| col a | col b |
| ----- | ----- |
| 1     | 2     |
`;

describe("canonical markdown pipeline", () => {
	it("normalizes representative CommonMark+GFM document", () => {
		const normalized = normalizeMarkdown(SAMPLE);
		expect(normalized).toContain("# Hello Recto");
		expect(normalized).toContain("**live**");
		expect(countWords(normalized)).toBeGreaterThan(5);
	});

	it("round-trips through parse and stringify", () => {
		const once = normalizeMarkdown(SAMPLE);
		const twice = normalizeMarkdown(once);
		expect(twice).toBe(once);
	});
});
