import { describe, expect, it } from "vitest";
import { resolveReviewRun } from "./use-ai-review";

describe("AI review run recovery", () => {
	it("does not treat missing or reserved status as retry-safe", () => {
		expect(resolveReviewRun(null)).toEqual({ status: "unresolved" });
		expect(resolveReviewRun({ status: "reserved" })).toEqual({
			status: "unresolved",
		});
	});

	it("allows a new request only after a terminal pre-provider state", () => {
		expect(resolveReviewRun({ status: "failed" })).toEqual({
			status: "retry-safe",
		});
		expect(resolveReviewRun({ status: "cancelled" })).toEqual({
			status: "retry-safe",
		});
	});

	it("parses a stored successful summary", () => {
		const summary = {
			commentsPlaced: 2,
			commentsTotal: 3,
			commentsDropped: 1,
			editsPlaced: 1,
			editsTotal: 1,
			editsDropped: 0,
			branchId: null,
		};
		expect(
			resolveReviewRun({
				status: "succeeded",
				output: JSON.stringify(summary),
			}),
		).toEqual({ status: "succeeded", summary });
	});

	it("keeps malformed stored output locked", () => {
		expect(resolveReviewRun({ status: "succeeded", output: "{}" })).toEqual({
			status: "unresolved",
		});
	});
});
