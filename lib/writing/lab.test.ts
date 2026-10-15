import { describe, expect, it } from "vitest";
import {
	cutRanges,
	cutting,
	decideWalkingCut,
	fittingCuts,
	followReview,
	type LabReview,
	labMarksFor,
	passageScope,
	proposalFor,
	proposalWords,
	toggleCut,
	toggleCutAt,
	trimLabel,
	walkThrough,
	withoutRanges,
} from "./lab";
import { emptyWritingState, type WritingState } from "./state";

const base = "So, basically, the plan works. It really does work well.";
const at = (text: string) => ({
	from: base.indexOf(text),
	to: base.indexOf(text) + text.length,
});
const cut = (text: string, reason = "filler") => ({ ...at(text), reason });

function proposal() {
	const made = proposalFor(
		10,
		base,
		[cut("basically, "), cut("So, "), cut(" really")],
		1,
	);
	if (!made) throw new Error("no proposal");
	return made;
}

describe("the Lab's trim proposal", () => {
	it("orders cuts, drops ones that do not fit or overlap, and names the preset", () => {
		expect(
			fittingCuts(
				[
					{ from: 10, to: 20, reason: "" },
					{ from: 0, to: 4, reason: "" },
					{ from: 15, to: 25, reason: "" },
					{ from: 50, to: 99, reason: "" },
					{ from: 30, to: 30, reason: "" },
				],
				60,
			).map((c) => [c.from, c.to]),
		).toEqual([
			[0, 4],
			[10, 20],
		]);
		expect(proposalFor(20, base, [], 0)).toBeNull();
		expect(trimLabel(10)).toBe("Slight trim");
		expect(trimLabel(50)).toBe("Cut in half");
	});

	it("counts words before and after the cuts still faded", () => {
		const p = proposal();
		expect(proposalWords(p)).toEqual({ before: 10, after: 7, percent: 30 });
		const kept = toggleCut(p, 0);
		expect(cutRanges(kept)).toEqual([at("basically, "), at(" really")]);
		expect(proposalWords(kept)).toEqual({ before: 10, after: 8, percent: 20 });
	});

	it("toggles the cut under a click, and only that one", () => {
		const p = proposal();
		const kept = toggleCutAt(p, base.indexOf("really") + 2);
		expect(kept.kept).toEqual([2]);
		expect(toggleCutAt(kept, base.indexOf("really")).kept).toEqual([]);
		expect(toggleCutAt(p, base.indexOf("plan"))).toBe(p);
	});

	it("walks through cuts in order, keeping or cutting each", () => {
		let p = walkThrough(toggleCut(proposal(), 0));
		expect(p.walking).toBe(1);
		p = decideWalkingCut(p, true);
		expect(p).toMatchObject({ walking: 2, kept: [0, 1] });
		p = decideWalkingCut(p, false);
		expect(p).toMatchObject({ walking: null, kept: [0, 1] });
		// With everything kept, the walkthrough starts at the first cut.
		const all = [0, 1, 2].reduce(toggleCut, proposal());
		expect(walkThrough(all).walking).toBe(0);
		expect(decideWalkingCut(all, true)).toBe(all);
	});

	it("deletes the cuts and carries alternatives and ghosts past them", () => {
		const text = "Keep this. Cut me. Keep that word.";
		const state: WritingState = {
			...emptyWritingState(),
			ghosts: [{ id: "g", location: text.indexOf("this"), length: 4 }],
			alternatives: [
				{
					id: "a",
					scope: "word",
					location: text.indexOf("word"),
					length: 4,
					candidates: [
						{ id: "o", text: "word", author: "human" },
						{ id: "x", text: "term", author: "ai" },
					],
					activeId: "o",
					detached: false,
				},
			],
		};
		const result = cutting(state, text, [
			{ from: text.indexOf(" Cut me."), to: text.indexOf(" Keep that") },
		]);
		expect(result?.markdown).toBe("Keep this. Keep that word.");
		expect(result?.state.ghosts).toEqual([{ id: "g", location: 5, length: 4 }]);
		expect(result?.state.alternatives[0]).toMatchObject({
			location: "Keep this. Keep that ".length,
			length: 4,
			detached: false,
		});
		expect(withoutRanges(base, [at("So, "), at(" really")])).toBe(
			"basically, the plan works. It does work well.",
		);
	});

	it("refuses cuts that overlap or run past the text", () => {
		const state = emptyWritingState();
		expect(
			cutting(state, "abcdef", [
				{ from: 0, to: 3 },
				{ from: 2, to: 4 },
			]),
		).toBeNull();
		expect(cutting(state, "abc", [{ from: 1, to: 9 }])).toBeNull();
		expect(cutting(state, "abc", [])).toBeNull();
	});
});

describe("the Lab's review", () => {
	const text = "One clear line. A muddled bit here. The end.";
	const review: LabReview = {
		pass: "clarity",
		assessment: "Mostly clear.",
		findings: [
			{
				from: text.indexOf("A muddled"),
				to: text.indexOf(" The end"),
				reason: "unclear",
				suggestion: "A clearer bit.",
			},
			{ from: text.indexOf("end"), to: text.indexOf("end") + 3, reason: "x" },
		],
		opening: { from: 0, to: text.length },
		openings: [],
		dropped: 0,
		text,
	};

	it("moves findings with an edit before them and stretches one edited inside", () => {
		const typed = `Intro. ${text}`;
		const moved = followReview(review, typed);
		expect(moved.findings.map((f) => typed.slice(f.from, f.to))).toEqual([
			"A muddled bit here.",
			"end",
		]);
		const inside = text.replace("muddled", "very muddled");
		expect(
			followReview(review, inside).findings.map((f) =>
				inside.slice(f.from, f.to),
			),
		).toEqual(["A very muddled bit here.", "end"]);
		expect(followReview(review, text)).toBe(review);
	});

	it("drops a finding an edit cuts across", () => {
		const across = text.replace("here. The", "here! Then the");
		const followed = followReview(review, across);
		expect(followed.findings.map((f) => f.reason)).toEqual(["x"]);
		expect(followed.text).toBe(across);
	});

	it("draws findings and cuts as marks, cuts carrying their index", () => {
		const marks = labMarksFor(proposal(), null);
		expect(marks.map((m) => [m.kind, m.text, m.index])).toEqual([
			["lab-cut", "So, ", 0],
			["lab-cut", "basically, ", 1],
			["lab-cut", " really", 2],
		]);
		expect(
			labMarksFor(toggleCut(proposal(), 2), null).map((m) => m.kind),
		).toEqual(["lab-cut", "lab-cut", "lab-kept"]);
		expect(labMarksFor(null, review).map((m) => [m.kind, m.text])).toEqual([
			["lab-finding", "A muddled bit here."],
			["lab-finding", "end"],
		]);
	});

	it("compares a passage at the scope its text has", () => {
		expect(passageScope("muddled")).toBe("word");
		expect(passageScope("A muddled bit.")).toBe("sentence");
		expect(passageScope("One.\nTwo.")).toBe("paragraph");
	});
});
