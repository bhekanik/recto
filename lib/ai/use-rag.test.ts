import { describe, expect, it } from "vitest";
import {
	chunksForIndex,
	embedBatchRequestId,
	MAX_DOCUMENT_CHUNKS,
	throwIfAborted,
} from "./use-rag";

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

describe("RAG provider boundaries", () => {
	it("caps chunks before any provider batches are formed", () => {
		const markdown = Array.from(
			{ length: MAX_DOCUMENT_CHUNKS + 40 },
			(_, index) => `${index} ${"x".repeat(1_600)}`,
		).join("\n\n");
		expect(chunksForIndex(markdown)).toHaveLength(MAX_DOCUMENT_CHUNKS);
	});

	it("rejects an already-aborted signal synchronously", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => throwIfAborted(controller.signal)).toThrowError(
			expect.objectContaining({ name: "AbortError" }),
		);
	});
});
