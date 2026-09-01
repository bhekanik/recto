import { describe, expect, it } from "vitest";
import { embedBatchRequestId } from "./use-rag";

describe("multi-batch embedding request identity", () => {
	it("replays each batch across a manual retry", () => {
		const first = [0, 16].map((offset) =>
			embedBatchRequestId("doc", "a".repeat(64), offset),
		);
		const retry = [0, 16].map((offset) =>
			embedBatchRequestId("doc", "a".repeat(64), offset),
		);
		expect(retry).toEqual(first);
		expect(new Set(first).size).toBe(2);
	});
});
