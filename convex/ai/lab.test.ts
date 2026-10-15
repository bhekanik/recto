import { describe, expect, it } from "vitest";
import {
	locateCuts,
	openingRange,
	parseAlternatives,
	parseCuts,
	parseReview,
} from "./lab";

const draft =
	"Much of the struggle comes from trying to balance the obvious. It all depends, but it matters. The core should be obvious.";

describe("Lab trim cuts", () => {
	it("places a cut only where its text, or its words before plus its text, occurs once", () => {
		const { cuts, dropped } = locateCuts(draft, [
			{ text: "It all depends, but it matters. ", reason: "hedge" },
			// "obvious" occurs twice; the words before it pick the second.
			{ text: "obvious", before: "The core should be", reason: "repeats" },
			{ text: "obvious", reason: "ambiguous without context" },
			{ text: "not in the draft", reason: "invented" },
		]);
		expect(cuts.map((cut) => draft.slice(cut.from, cut.to))).toEqual([
			"It all depends, but it matters. ",
			"obvious",
		]);
		expect(cuts[1]?.from).toBe(draft.lastIndexOf("obvious"));
		expect(dropped).toBe(2);
	});

	it("drops overlapping cuts and cuts inside frontmatter", () => {
		const source = "---\ntitle: Draft\n---\nOne two three four.";
		const { cuts, dropped } = locateCuts(source, [
			{ text: "Draft", reason: "frontmatter" },
			{ text: "two three", reason: "a" },
			{ text: "three four", reason: "overlaps" },
		]);
		expect(cuts.map((cut) => source.slice(cut.from, cut.to))).toEqual([
			"two three",
		]);
		expect(dropped).toBe(2);
	});

	it("reads the JSON object out of a reply, fenced or not", () => {
		expect(
			parseCuts('```json\n{"cuts":[{"text":"a","reason":"b"}]}\n```'),
		).toEqual([{ text: "a", reason: "b" }]);
		expect(() => parseCuts("no json here")).toThrow();
		expect(() => parseCuts('{"other":1}')).toThrow();
	});
});

describe("Lab alternatives", () => {
	it("keeps distinct wordings of the right size, never the passage itself", () => {
		const reply =
			'{"alternatives":["pressure"," pressure ","tension","a much\\nlonger thing","struggle","friction","difficulty","challenge","strain"]}';
		expect(parseAlternatives(reply, "tension", "word")).toEqual({
			alternatives: [
				"pressure",
				"struggle",
				"friction",
				"difficulty",
				"challenge",
			],
		});
		expect(() => parseAlternatives("nothing", "tension", "word")).toThrow();
	});
});

describe("Lab review", () => {
	const source =
		"---\ntitle: Draft\n---\n# The Obvious\n\nMuch of the struggle comes from balance. It all depends.\n\nThe core should be obvious.";

	it("finds the opening paragraph after frontmatter and headings", () => {
		const range = openingRange(source);
		expect(range && source.slice(range.from, range.to)).toBe(
			"Much of the struggle comes from balance. It all depends.",
		);
		expect(openingRange("# Only a heading\n")).toBeUndefined();
	});

	it("places findings exactly, keeps useful suggestions and caps openings", () => {
		const reply = JSON.stringify({
			assessment: "The opening states the tension but not the stakes.",
			openings: ["A", "B", "C", "D"],
			findings: [
				{
					text: "It all depends.",
					reason: "hedge",
					suggestion: "It depends on the product.",
				},
				{ text: "The core", reason: "vague", suggestion: "The core" },
				{ text: "missing text", reason: "invented" },
			],
		});
		const result = parseReview(reply, source, "opening");
		expect(result.assessment).toBe(
			"The opening states the tension but not the stakes.",
		);
		expect(result.openings).toEqual(["A", "B", "C"]);
		expect(
			result.findings.map((finding) => source.slice(finding.from, finding.to)),
		).toEqual(["It all depends.", "The core"]);
		expect(result.findings[0]?.suggestion).toBe("It depends on the product.");
		expect(result.findings[1]?.suggestion).toBeUndefined();
		expect(result.dropped).toBe(1);
		expect(parseReview(reply, source, "voice").openings).toEqual([]);
	});
});
