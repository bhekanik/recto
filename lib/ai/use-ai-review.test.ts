import { describe, expect, it } from "vitest";
import {
	canStartAiReview,
	reconcileReviewRun,
	resolveReviewRun,
	reviewReconciliationIsCurrent,
	reviewRequestMatchesDocument,
	type UnresolvedReview,
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
			generation: 1,
		};
		expect(reviewRequestMatchesDocument(unresolved, "document-a")).toBe(true);
		expect(reviewRequestMatchesDocument(unresolved, "document-b")).toBe(false);
		expect(reviewRequestMatchesDocument(unresolved, null)).toBe(false);
	});
});

describe("AI review run recovery", () => {
	type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

	function deferred<T>(): Deferred<T> {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((resolvePromise) => {
			resolve = resolvePromise;
		});
		return { promise, resolve };
	}

	const unresolved = (
		requestId: string,
		documentId: string,
		generation: number,
	): UnresolvedReview => ({ requestId, documentId, generation });

	it("invalidates A's run result after switching to B", () => {
		const captured = unresolved("request-a", "document-a", 1);
		const current = unresolved("request-b", "document-b", 2);
		expect(
			reviewReconciliationIsCurrent(captured, current, current.documentId, 2),
		).toBe(false);
	});

	it("drops A after the first recovery query resolves on B", async () => {
		let current = true;
		const lookup = deferred<{ status: "failed" }>();
		const result = reconcileReviewRun({
			query: async () => await lookup.promise,
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => true,
			isCurrent: () => current,
		});
		current = false;
		lookup.resolve({ status: "failed" });
		await expect(result).resolves.toEqual({ status: "stale" });
	});

	it("drops A after reserved cancellation settles on B", async () => {
		let current = true;
		const cancellation = deferred<{ cancelled: true }>();
		const result = reconcileReviewRun({
			query: async () => ({ status: "reserved" }),
			cancel: async () => await cancellation.promise,
			acknowledge: async () => true,
			isCurrent: () => current,
		});
		await Promise.resolve();
		current = false;
		cancellation.resolve({ cancelled: true });
		await expect(result).resolves.toEqual({ status: "stale" });
	});

	it("drops A after the terminal second query resolves on B", async () => {
		let current = true;
		let queryCount = 0;
		const secondLookup = deferred<{ status: "failed" }>();
		const result = reconcileReviewRun({
			query: async () => {
				queryCount += 1;
				return queryCount === 1
					? { status: "reserved" }
					: await secondLookup.promise;
			},
			cancel: async () => ({ cancelled: false, reason: "terminal" }),
			acknowledge: async () => true,
			isCurrent: () => current,
		});
		await Promise.resolve();
		await Promise.resolve();
		current = false;
		secondLookup.resolve({ status: "failed" });
		await expect(result).resolves.toEqual({ status: "stale" });
	});

	it("drops A success and acknowledgement failure after switching to B", async () => {
		for (const acknowledgementFails of [false, true]) {
			let current = true;
			const acknowledgement = deferred<void>();
			const result = reconcileReviewRun({
				query: async () => ({
					status: "succeeded",
					applicable: true,
					output: JSON.stringify({
						commentsPlaced: 0,
						commentsTotal: 0,
						commentsDropped: 0,
						editsPlaced: 0,
						editsTotal: 0,
						editsDropped: 0,
						branchId: null,
					}),
				}),
				cancel: async () => ({ cancelled: true }),
				acknowledge: async () => {
					await acknowledgement.promise;
					if (acknowledgementFails) throw new Error("transport failed");
					return true;
				},
				isCurrent: () => current,
			});
			await Promise.resolve();
			current = false;
			acknowledgement.resolve();
			await expect(result).resolves.toEqual({ status: "stale" });
		}
	});

	it("does not revive old A after A to B to A installs a newer request", async () => {
		const captured = unresolved("old-a", "document-a", 1);
		let current: UnresolvedReview | null = captured;
		let generation = 1;
		const lookup = deferred<{ status: "failed" }>();
		const result = reconcileReviewRun({
			query: async () => await lookup.promise,
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => true,
			isCurrent: () =>
				reviewReconciliationIsCurrent(
					captured,
					current,
					current?.documentId ?? null,
					generation,
				),
		});
		current = unresolved("new-a", "document-a", 3);
		generation = 3;
		lookup.resolve({ status: "failed" });
		await expect(result).resolves.toEqual({ status: "stale" });
	});

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
