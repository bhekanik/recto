import { describe, expect, it } from "vitest";
import { assertFullCorpusCase } from "./corpus/assertions";
import { CORPUS_CASES } from "./corpus/cases";
import { normalizeMarkdown } from "./index";

describe("round-trip corpus (06-markdown-dialect §6)", () => {
	for (const testCase of CORPUS_CASES) {
		it(`case ${testCase.id}: ${testCase.name}`, () => {
			expect(() =>
				assertFullCorpusCase(testCase.input, testCase.checkFrontmatter),
			).not.toThrow();
		});
	}

	it("case 25: idempotence sweep over all cases", () => {
		for (const testCase of CORPUS_CASES) {
			const once = normalizeMarkdown(testCase.input);
			const twice = normalizeMarkdown(once);
			expect(twice).toBe(once);
		}
	});
});
