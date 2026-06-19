import { describe, expect, it } from "vitest";

import {
	AI_REVIEWER_AUTHOR_NAME,
	aiReviewOrigin,
	buildReviewMessages,
	modelLabel,
	parseReview,
	resolveComments,
} from "./review";

describe("buildReviewMessages (plan 011)", () => {
	it("starts with a system message demanding a JSON object with comments + suggestions", () => {
		const msgs = buildReviewMessages({ text: "Some draft." });
		expect(msgs[0]?.role).toBe("system");
		const sys = msgs[0]?.content ?? "";
		expect(sys).toMatch(/JSON/);
		expect(sys).toMatch(/comments/);
		expect(sys).toMatch(/suggestions/);
	});

	it("instructs the model to copy the quote verbatim", () => {
		const sys = buildReviewMessages({ text: "x" })[0]?.content ?? "";
		expect(sys).toMatch(/verbatim/i);
		expect(sys).toMatch(/exact/i);
		expect(sys).toMatch(/substring/i);
	});

	it("puts the provided text in the user message", () => {
		const msgs = buildReviewMessages({ text: "The whole draft." });
		expect(msgs.find((m) => m.role === "user")?.content).toBe(
			"The whole draft.",
		);
	});
});

describe("parseReview (plan 011)", () => {
	it("parses a clean JSON object with both arrays", () => {
		const raw = JSON.stringify({
			comments: [{ quote: "the cat", body: "Whose cat?" }],
			suggestions: [
				{
					quote: "the cat",
					replacement: "the black cat",
					rationale: "specify",
				},
			],
		});
		expect(parseReview(raw)).toEqual({
			comments: [{ quote: "the cat", body: "Whose cat?" }],
			suggestions: [
				{
					quote: "the cat",
					replacement: "the black cat",
					rationale: "specify",
				},
			],
		});
	});

	it("keeps optional string fields and drops non-string optionals", () => {
		const raw = JSON.stringify({
			comments: [
				{
					quote: "q",
					prefix: "p",
					suffix: "s",
					category: "Clarity",
					body: "b",
				},
				{ quote: "q2", body: "b2", category: 7 },
			],
			suggestions: [],
		});
		expect(parseReview(raw)).toEqual({
			comments: [
				{
					quote: "q",
					prefix: "p",
					suffix: "s",
					category: "Clarity",
					body: "b",
				},
				{ quote: "q2", body: "b2" },
			],
			suggestions: [],
		});
	});

	it("parses JSON wrapped in a code fence", () => {
		const raw =
			'```json\n{"comments":[{"quote":"x","body":"note"}],"suggestions":[]}\n```';
		expect(parseReview(raw)).toEqual({
			comments: [{ quote: "x", body: "note" }],
			suggestions: [],
		});
	});

	it("parses JSON with stray prose around it", () => {
		const raw =
			'Here is my review:\n{"comments":[{"quote":"y","body":"hm"}],"suggestions":[]}\nThanks.';
		expect(parseReview(raw)).toEqual({
			comments: [{ quote: "y", body: "hm" }],
			suggestions: [],
		});
	});

	it("drops malformed items but keeps valid siblings", () => {
		const raw = JSON.stringify({
			comments: [
				{ quote: "ok", body: "good" },
				{ quote: "no body" }, // missing body
				{ quote: 1, body: "non-string quote" }, // non-string quote
				{ body: "no quote" }, // missing quote
			],
			suggestions: [
				{ quote: "x", replacement: "y" },
				{ quote: "no replacement" }, // missing replacement
				{ replacement: "no quote" }, // missing quote
			],
		});
		expect(parseReview(raw)).toEqual({
			comments: [{ quote: "ok", body: "good" }],
			suggestions: [{ quote: "x", replacement: "y" }],
		});
	});

	it("defaults missing/non-array fields to empty arrays", () => {
		expect(parseReview('{"comments":"x"}')).toEqual({
			comments: [],
			suggestions: [],
		});
		expect(parseReview("{}")).toEqual({ comments: [], suggestions: [] });
	});

	it("returns empty arrays for unparseable input", () => {
		expect(parseReview("")).toEqual({ comments: [], suggestions: [] });
		expect(parseReview("not json at all")).toEqual({
			comments: [],
			suggestions: [],
		});
	});
});

describe("modelLabel + identity (plan 011)", () => {
	it("prettifies the model id's last segment", () => {
		expect(modelLabel("z-ai/glm-5.2")).toBe("GLM 5.2");
	});

	it("derives the reviewer name and branch origin from the model", () => {
		expect(AI_REVIEWER_AUTHOR_NAME).toContain("GLM 5.2");
		expect(AI_REVIEWER_AUTHOR_NAME.startsWith("AI ·")).toBe(true);
		expect(aiReviewOrigin()).toBe("ai:review:z-ai/glm-5.2");
	});
});

describe("resolveComments drop-and-count (plan 011)", () => {
	it("places locatable comments and drops + counts unlocatable ones", () => {
		const markdown =
			"The quick brown fox jumps over the lazy dog. It was a fine morning.";
		const result = resolveComments(markdown, [
			{ quote: "quick brown fox", body: "Cliché." },
			{ quote: "a phrase that is nowhere in the document at all", body: "x" },
		]);
		expect(result.dropped).toBe(1);
		expect(result.placed).toHaveLength(1);
		expect(result.placed[0]?.comment.quote).toBe("quick brown fox");
		expect(result.placed[0]?.anchor.quote).toBe("quick brown fox");
	});
});
