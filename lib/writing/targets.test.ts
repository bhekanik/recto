import { describe, expect, it } from "vitest";
import { alternativeTargets, articleFix } from "./targets";

const text =
	"First line here.\n\nShouldn't everything be obvious? Unless you're making a product.\n";

describe("alternative targets on the web", () => {
	it("finds the word, sentence and paragraph at the caret", () => {
		const caret = text.indexOf("everything") + 2;
		const targets = alternativeTargets(text, { from: caret, to: caret });
		const slice = (range?: { from: number; to: number }) =>
			range && text.slice(range.from, range.to);
		expect(slice(targets?.ranges.word)).toBe("everything");
		expect(slice(targets?.ranges.sentence)).toBe(
			"Shouldn't everything be obvious?",
		);
		expect(slice(targets?.ranges.paragraph)).toBe(
			"Shouldn't everything be obvious? Unless you're making a product.",
		);
		expect(targets?.initial).toBe("word");
	});

	it("opens a multi-word selection as a sentence", () => {
		const from = text.indexOf("Unless");
		const targets = alternativeTargets(text, {
			from,
			to: from + "Unless you're".length,
		});
		expect(targets?.initial).toBe("sentence");
	});

	it("corrects a/an the way the linter does", async () => {
		const source = "Like a thumbtack, for example.";
		expect(
			await articleFix(source, source.indexOf("thumbtack"), "eraser"),
		).toEqual({
			from: 5,
			to: 6,
			text: "an",
		});
		expect(
			await articleFix(source, source.indexOf("thumbtack"), "pin"),
		).toBeNull();
	});
});
