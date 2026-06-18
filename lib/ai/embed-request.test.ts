import { describe, expect, it } from "vitest";

import { AI_EMBEDDING_DIM, AI_EMBEDDING_MODEL } from "./config";
import { buildEmbedRequest, embeddingDimensions } from "./embed-request";

describe("buildEmbedRequest (plan 009 — embedding request builder)", () => {
	it("emits the configured model id", () => {
		const req = buildEmbedRequest(["hello"]);
		expect(req.model).toBe(AI_EMBEDDING_MODEL);
	});

	it("preserves the input array order", () => {
		const req = buildEmbedRequest(["a", "b", "c"]);
		expect(req.input).toEqual(["a", "b", "c"]);
	});

	it("trims and drops empty inputs (the API rejects empty strings)", () => {
		const req = buildEmbedRequest(["  keep  ", "", "   ", "also"]);
		expect(req.input).toEqual(["keep", "also"]);
	});

	it("returns an empty input array when nothing survives", () => {
		expect(buildEmbedRequest(["", "   "]).input).toEqual([]);
	});
});

describe("embeddingDimensions", () => {
	it("reports the configured dimension (must match the Convex vectorIndex)", () => {
		expect(embeddingDimensions()).toBe(AI_EMBEDDING_DIM);
		expect(AI_EMBEDDING_DIM).toBe(1536);
	});
});
