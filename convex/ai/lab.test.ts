import { describe, expect, it } from "vitest";
import { locateCuts, parseCuts } from "./lab";

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
