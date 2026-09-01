import { describe, expect, it } from "vitest";
import { embedBatchRequestId } from "./use-rag";

describe("multi-batch embedding request identity", () => {
	it("replays identical batches without colliding with other inputs", async () => {
		const id = (
			purpose: "query" | "reindex",
			offset: number,
			texts: string[],
			sourceNodeId = "node-1",
		) =>
			embedBatchRequestId({
				purpose,
				documentId: "doc",
				sourceNodeId,
				sourceHash: "a".repeat(64),
				offset,
				texts,
			});
		const first = await Promise.all([
			id("reindex", 0, ["one"]),
			id("reindex", 16, ["two"]),
		]);
		const retry = await Promise.all([
			id("reindex", 0, ["one"]),
			id("reindex", 16, ["two"]),
		]);
		expect(retry).toEqual(first);
		expect(new Set(first).size).toBe(2);
		expect(await id("query", 0, ["one"])).not.toBe(first[0]);
		expect(await id("reindex", 0, ["different"])).not.toBe(first[0]);
		expect(await id("reindex", 0, ["one"], "node-2")).not.toBe(first[0]);
		expect(first.every((requestId) => requestId.length <= 128)).toBe(true);
	});
});
