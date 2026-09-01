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
			requestId: "request-a",
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
			requestId: "request-a",
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
			requestId: "request-a",
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
				requestId: "request-a",
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
			requestId: captured.requestId,
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

	const storedSummary = JSON.stringify({
		commentsPlaced: 1,
		commentsTotal: 1,
		commentsDropped: 0,
		editsPlaced: 0,
		editsTotal: 0,
		editsDropped: 0,
		branchId: null,
	});

	it.each([
		{
			name: "reserved",
			run: { requestId: "request-a", status: "reserved" as const },
			expectedStatus: "retry-safe",
			expectsAcknowledgement: true,
		},
		{
			name: "provider started",
			run: { requestId: "request-a", status: "provider_started" as const },
			expectedStatus: "unresolved",
			expectsAcknowledgement: false,
		},
		{
			name: "outcome unknown",
			run: { requestId: "request-a", status: "outcome_unknown" as const },
			expectedStatus: "unresolved",
			expectsAcknowledgement: false,
		},
		{
			name: "applicable success",
			run: {
				requestId: "request-a",
				status: "succeeded" as const,
				applicable: true,
				output: storedSummary,
			},
			expectedStatus: "succeeded",
			expectsAcknowledgement: true,
		},
	])("adopts cross-tab active A after Convex rejects B: $name", async (attack) => {
		let current = unresolved("request-b", "document-a", 1);
		const adopted: string[] = [];
		const cancelled: string[] = [];
		const acknowledged: string[] = [];
		const result = await reconcileReviewRun({
			requestId: "request-b",
			query: async () => null,
			recovery: {
				latest: async () => attack.run,
				adopt: (requestId, activeRequestId) => {
					if (current.requestId !== requestId) return false;
					current = unresolved(activeRequestId, "document-a", 2);
					adopted.push(activeRequestId);
					return true;
				},
			},
			cancel: async (requestId) => {
				cancelled.push(requestId);
				return { cancelled: true };
			},
			acknowledge: async (requestId) => {
				acknowledged.push(requestId);
				return true;
			},
			isCurrent: (requestId) => current.requestId === requestId,
		});

		expect(result.status).toBe(attack.expectedStatus);
		expect(adopted).toEqual(["request-a"]);
		expect(cancelled).toEqual(
			attack.run.status === "reserved" ? ["request-a"] : [],
		);
		expect(acknowledged).toEqual(
			attack.expectsAcknowledgement ? ["request-a"] : [],
		);
	});

	it("keeps a missing review ID locked when latest recovery is empty", async () => {
		await expect(
			reconcileReviewRun({
				requestId: "request-b",
				query: async () => null,
				recovery: {
					latest: async () => null,
					adopt: () => true,
				},
				cancel: async () => ({ cancelled: true }),
				acknowledge: async () => true,
				isCurrent: () => true,
			}),
		).resolves.toEqual({ status: "unresolved" });
	});

	it("does not adopt A after a document switch while recovery is pending", async () => {
		let current = unresolved("request-b", "document-a", 1);
		const latest = deferred<{
			requestId: string;
			status: "provider_started";
		}>();
		const adopted: string[] = [];
		const result = reconcileReviewRun({
			requestId: "request-b",
			query: async () => null,
			recovery: {
				latest: async () => await latest.promise,
				adopt: (_requestId, activeRequestId) => {
					adopted.push(activeRequestId);
					return true;
				},
			},
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => true,
			isCurrent: (requestId) =>
				current.requestId === requestId && current.documentId === "document-a",
		});
		current = unresolved("request-c", "document-b", 2);
		latest.resolve({ requestId: "request-a", status: "provider_started" });

		await expect(result).resolves.toEqual({ status: "stale" });
		expect(adopted).toEqual([]);
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
