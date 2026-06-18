import { describe, expect, it } from "vitest";

import { applyPatch, computePatch, encodePatch } from "@/lib/history/patch";
import { applyTransform, type TransformRange } from "./apply-transform";

describe("applyTransform (plan 009 — patch-from-AI path)", () => {
	const doc = "The quick brown fox jumps.";

	it("replaces a mid-document span", () => {
		// "quick brown" → "swift red"
		const range: TransformRange = { from: 4, to: 15 };
		expect(applyTransform(doc, range, "swift red")).toBe(
			"The swift red fox jumps.",
		);
	});

	it("replaces at the start (from=0)", () => {
		expect(applyTransform(doc, { from: 0, to: 3 }, "A")).toBe(
			"A quick brown fox jumps.",
		);
	});

	it("replaces at the end (to=len)", () => {
		const len = doc.length;
		expect(applyTransform(doc, { from: len - 1, to: len }, "!")).toBe(
			"The quick brown fox jumps!",
		);
	});

	it("treats empty aiText as a deletion", () => {
		expect(applyTransform(doc, { from: 3, to: 9 }, "")).toBe(
			"The brown fox jumps.",
		);
	});

	it("matches doc.slice(0,from) + aiText + doc.slice(to) exactly", () => {
		const from = 4;
		const to = 9;
		const aiText = "REPLACED";
		expect(applyTransform(doc, { from, to }, aiText)).toBe(
			doc.slice(0, from) + aiText + doc.slice(to),
		);
	});

	it("throws on a reversed range", () => {
		expect(() => applyTransform(doc, { from: 9, to: 4 }, "x")).toThrow();
	});

	it("throws on an out-of-range bound", () => {
		expect(() =>
			applyTransform(doc, { from: 0, to: doc.length + 5 }, "x"),
		).toThrow();
		expect(() => applyTransform(doc, { from: -1, to: 3 }, "x")).toThrow();
	});

	it("throws on non-integer bounds", () => {
		expect(() => applyTransform(doc, { from: 0.5, to: 3 }, "x")).toThrow();
	});
});

describe("applyTransform → patch round-trip (the AI result becomes a valid node)", () => {
	// Proves: applyPatch(doc, encodePatch(computePatch(doc, applyTransform(...)))) === applyTransform(...)
	const doc = "# Title\n\nThe quick brown fox jumps over the lazy dog.\n";

	const cases: { range: TransformRange; aiText: string }[] = [
		{ range: { from: 13, to: 24 }, aiText: "swift red" }, // mid
		{ range: { from: 0, to: 1 }, aiText: "=" }, // start
		{ range: { from: doc.length - 1, to: doc.length }, aiText: "" }, // end deletion
		{ range: { from: 9, to: 9 }, aiText: "INSERTED " }, // zero-width insert
	];

	for (const { range, aiText } of cases) {
		it(`round-trips for range ${range.from}..${range.to}`, () => {
			const next = applyTransform(doc, range, aiText);
			const patch = encodePatch(computePatch(doc, next));
			expect(applyPatch(doc, patch)).toBe(next);
		});
	}
});
