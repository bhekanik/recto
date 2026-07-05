/**
 * Route-level tests for the no-AI-on-shared-documents gate (plan 016). Imports
 * the REAL route handlers (transform / review / embed) and exercises the full
 * preamble with the server edges mocked: Clerk auth (`@/lib/ai/server` +
 * `@clerk/nextjs/server`), the OpenRouter client, and the Convex read
 * (`fetchQuery` → `api.review.documentShareState`). The real LLM and a real
 * Convex deployment are never called.
 *
 * Covered per route: shared doc → 403, unshared doc → passes the guard,
 * missing documentId → 400. Plus the guard-specific semantics: not-visible
 * doc → 404, failed shared-ness read → 502 (both fail closed), 403 winning
 * over 503 when the OpenRouter key is also missing, and the embed route's
 * empty-inputs 200 still preceding client construction (the plan-015
 * ordering its header comment documents).
 */

import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireUser: vi.fn<() => Promise<string | null>>(),
	openRouter: vi.fn<() => unknown>(),
	fetchQuery: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	getToken: vi.fn<() => Promise<string | null>>(),
}));

// The routes and guard import `server-only` (a build-time marker that throws
// outside React Server Components) — neutralize it for vitest.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/server", () => ({
	requireUser: mocks.requireUser,
	openRouter: mocks.openRouter,
}));
vi.mock("@clerk/nextjs/server", () => ({
	auth: async () => ({ getToken: mocks.getToken }),
}));
vi.mock("convex/nextjs", () => ({
	fetchQuery: mocks.fetchQuery,
}));

import { POST as embedPost } from "@/app/api/ai/embed/route";
import { POST as reviewPost } from "@/app/api/ai/review/route";
import { POST as transformPost } from "@/app/api/ai/transform/route";
import { api } from "@/convex/_generated/api";

const DOC_ID = "doc_123";

/** documentShareState results, as the guard sees them. */
const OWNER_UNSHARED = { role: "owner", shareCount: 0, shared: false };
const OWNER_SHARED = { role: "owner", shareCount: 1, shared: true };
const GRANTEE = { role: "commenter", shareCount: 1, shared: true };

function post(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** A client whose chat stream yields the given chunks (transform route). */
function streamingClient(chunks: string[]) {
	return {
		chat: {
			completions: {
				create: vi.fn(async () =>
					(async function* () {
						for (const c of chunks) {
							yield { choices: [{ delta: { content: c } }] };
						}
					})(),
				),
			},
		},
	};
}

/** A client whose (non-streaming) completion ends the review loop at once. */
function reviewClient() {
	return {
		chat: {
			completions: {
				create: vi.fn(
					async () =>
						({
							choices: [
								{
									index: 0,
									finish_reason: "stop",
									logprobs: null,
									message: {
										role: "assistant",
										content: "Nothing to flag.",
										refusal: null,
									},
								},
							],
						}) as OpenAI.Chat.Completions.ChatCompletion,
				),
			},
		},
	};
}

/** A client answering the embeddings call with one vector per input. */
function embeddingClient() {
	return {
		embeddings: {
			create: vi.fn(async (req: { input: string[] }) => ({
				data: req.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })),
			})),
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue("user_1");
	mocks.getToken.mockResolvedValue("convex-token");
	mocks.fetchQuery.mockResolvedValue(OWNER_UNSHARED);
	mocks.openRouter.mockImplementation(() => {
		throw new Error("openRouter should not be constructed in this test");
	});
});

describe("POST /api/ai/transform — shared-document gate (plan 016)", () => {
	it("returns 403 for a shared document, before touching the OpenRouter client", async () => {
		mocks.fetchQuery.mockResolvedValue(OWNER_SHARED);
		const res = await transformPost(
			post("/api/ai/transform", {
				documentId: DOC_ID,
				instruction: "shorten",
				selection: "some text",
			}),
		);
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("AI is disabled on shared documents");
		// The gate must fire BEFORE client construction (403 beats 503).
		expect(mocks.openRouter).not.toHaveBeenCalled();
	});

	it("streams normally for the owner's un-shared document", async () => {
		const client = streamingClient(["Hello", " world"]);
		mocks.openRouter.mockReturnValue(client);
		const res = await transformPost(
			post("/api/ai/transform", {
				documentId: DOC_ID,
				instruction: "shorten",
				selection: "some text",
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Hello world");
		// The shared-ness read ran as the caller against the real query ref.
		expect(mocks.fetchQuery).toHaveBeenCalledWith(
			api.review.documentShareState,
			{ documentId: DOC_ID },
			{ token: "convex-token" },
		);
	});

	it("returns 400 when documentId is missing, without reading Convex", async () => {
		const res = await transformPost(
			post("/api/ai/transform", {
				instruction: "shorten",
				selection: "some text",
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing documentId");
		expect(mocks.fetchQuery).not.toHaveBeenCalled();
	});

	it("returns 401 when unauthenticated", async () => {
		mocks.requireUser.mockResolvedValue(null);
		const res = await transformPost(
			post("/api/ai/transform", {
				documentId: DOC_ID,
				instruction: "shorten",
				selection: "some text",
			}),
		);
		expect(res.status).toBe(401);
	});

	it("fails closed with 404 when the document is not visible to the caller", async () => {
		mocks.fetchQuery.mockResolvedValue(null);
		const res = await transformPost(
			post("/api/ai/transform", {
				documentId: DOC_ID,
				instruction: "shorten",
				selection: "some text",
			}),
		);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Document not found");
	});

	it("fails closed with 502 when the shared-ness read itself fails", async () => {
		mocks.fetchQuery.mockRejectedValue(new Error("convex down"));
		const res = await transformPost(
			post("/api/ai/transform", {
				documentId: DOC_ID,
				instruction: "shorten",
				selection: "some text",
			}),
		);
		expect(res.status).toBe(502);
		expect(await res.text()).toBe("Could not verify document sharing");
	});
});

describe("POST /api/ai/review — shared-document gate (plan 016)", () => {
	it("returns 403 for a shared document (grantee side too)", async () => {
		mocks.fetchQuery.mockResolvedValue(GRANTEE);
		const res = await reviewPost(
			post("/api/ai/review", { documentId: DOC_ID, text: "Draft text." }),
		);
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("AI is disabled on shared documents");
		expect(mocks.openRouter).not.toHaveBeenCalled();
	});

	it("runs the review loop for the owner's un-shared document", async () => {
		mocks.openRouter.mockReturnValue(reviewClient());
		const res = await reviewPost(
			post("/api/ai/review", { documentId: DOC_ID, text: "Draft text." }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ comments: [], suggestions: [] });
	});

	it("returns 400 when documentId is missing", async () => {
		const res = await reviewPost(
			post("/api/ai/review", { text: "Draft text." }),
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing documentId");
		expect(mocks.fetchQuery).not.toHaveBeenCalled();
	});
});

describe("POST /api/ai/embed — shared-document gate (plan 016)", () => {
	it("returns 403 for a shared document, even with empty inputs", async () => {
		mocks.fetchQuery.mockResolvedValue(OWNER_SHARED);
		const res = await embedPost(
			post("/api/ai/embed", { documentId: DOC_ID, inputs: [] }),
		);
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("AI is disabled on shared documents");
		expect(mocks.openRouter).not.toHaveBeenCalled();
	});

	it("embeds normally for the owner's un-shared document", async () => {
		mocks.openRouter.mockReturnValue(embeddingClient());
		const res = await embedPost(
			post("/api/ai/embed", { documentId: DOC_ID, inputs: ["a chunk"] }),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { embeddings: number[][] };
		expect(data.embeddings).toEqual([[0.1, 0.2, 0.3]]);
	});

	it("returns 400 when documentId is missing", async () => {
		const res = await embedPost(post("/api/ai/embed", { inputs: ["a"] }));
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing documentId");
		expect(mocks.fetchQuery).not.toHaveBeenCalled();
	});

	it("keeps the empty-inputs 200 ahead of client construction (plan 015 ordering)", async () => {
		// openRouter still throws (beforeEach default) — an un-shared doc with
		// empty inputs must succeed WITHOUT constructing the client.
		const res = await embedPost(
			post("/api/ai/embed", { documentId: DOC_ID, inputs: [] }),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { embeddings: number[][] };
		expect(data.embeddings).toEqual([]);
		expect(mocks.openRouter).not.toHaveBeenCalled();
	});
});
