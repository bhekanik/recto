import { describe, expect, it } from "vitest";
import {
	canStartAiReview,
	resolveReviewRun,
	reviewRequestMatchesDocument,
} from "./use-ai-review";

describe("AI review reload gate", () => {
	it("blocks until recovery finishes and while a request is unresolved", () => {
		expect(canStartAiReview(false, null)).toBe(false);
		expect(canStartAiReview(true, "request-1")).toBe(false);
		expect(canStartAiReview(true, null)).toBe(true);
	});

	it("never reconciles document A onto document B", () => {
		const unresolved = {
			requestId: "review-a",
			documentId: "document-a",
		};
		expect(reviewRequestMatchesDocument(unresolved, "document-a")).toBe(true);
		expect(reviewRequestMatchesDocument(unresolved, "document-b")).toBe(false);
		expect(reviewRequestMatchesDocument(unresolved, null)).toBe(false);
	});
});

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
				applicable: true,
				output: JSON.stringify(summary),
			}),
		).toEqual({ status: "succeeded", summary });
	});

	it("does not expose a succeeded review the server marked non-applicable", () => {
		expect(
			resolveReviewRun({
				status: "succeeded",
				applicable: false,
				output: JSON.stringify({}),
			}),
		).toEqual({ status: "retry-safe" });
	});

	it("keeps malformed stored output locked", () => {
		expect(resolveReviewRun({ status: "succeeded", output: "{}" })).toEqual({
			status: "unresolved",
		});
	});
});
