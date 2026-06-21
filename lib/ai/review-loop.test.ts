import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { type ReviewChatClient, runReviewLoop } from "./review-loop";

/**
 * Build a fake ChatCompletion whose first choice carries the given assistant
 * message (content + optional tool_calls). Only the fields the loop reads are
 * populated; the rest are cast away.
 */
function completion(
	message: Partial<OpenAI.Chat.Completions.ChatCompletionMessage> & {
		tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
	},
): OpenAI.Chat.Completions.ChatCompletion {
	return {
		choices: [
			{
				index: 0,
				finish_reason: (message.tool_calls?.length
					? "tool_calls"
					: "stop") as OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"],
				logprobs: null,
				message: {
					role: "assistant",
					content: message.content ?? null,
					refusal: null,
					...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
				} as OpenAI.Chat.Completions.ChatCompletionMessage,
			},
		],
	} as OpenAI.Chat.Completions.ChatCompletion;
}

/** A `function` tool call with JSON-stringified args (the wire format). */
function toolCall(
	id: string,
	name: string,
	args: unknown,
): OpenAI.Chat.Completions.ChatCompletionMessageToolCall {
	return {
		id,
		type: "function",
		function: {
			name,
			arguments: typeof args === "string" ? args : JSON.stringify(args),
		},
	} as OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
}

/**
 * A mock client that returns a queued sequence of completions, one per call, and
 * records the params it was called with (so we can assert the appended messages).
 */
function mockClient(queue: OpenAI.Chat.Completions.ChatCompletion[]) {
	const calls: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] =
		[];
	let i = 0;
	const create = vi.fn(
		async (
			params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		) => {
			calls.push(params);
			const next = queue[i++];
			if (!next) throw new Error("mock queue exhausted");
			return next;
		},
	);
	const client: ReviewChatClient = { chat: { completions: { create } } };
	return { client, create, calls };
}

const seed = [
	{ role: "system" as const, content: "sys" },
	{ role: "user" as const, content: "draft" },
];

describe("runReviewLoop — accumulation across rounds", () => {
	it("collects comments + edits from tool calls across multiple rounds", async () => {
		const { client, create, calls } = mockClient([
			completion({
				tool_calls: [
					toolCall("c1", "create_comment", {
						quote: "the cat",
						body: "Whose cat?",
						category: "Clarity",
					}),
				],
			}),
			completion({
				tool_calls: [
					toolCall("e1", "suggest_edit", {
						quote: "the cat",
						replacement: "the black cat",
						rationale: "specify",
					}),
				],
			}),
			completion({ content: "Done reviewing." }),
		]);

		const result = await runReviewLoop(client, [...seed], {
			maxTokens: 1000,
		});

		expect(create).toHaveBeenCalledTimes(3);
		expect(result.iterations).toBe(3);
		expect(result.hitCap).toBe(false);
		expect(result.comments).toEqual([
			{ quote: "the cat", body: "Whose cat?", category: "Clarity" },
		]);
		expect(result.suggestions).toEqual([
			{ quote: "the cat", replacement: "the black cat", rationale: "specify" },
		]);

		// Round 2's request must include the round-1 assistant turn + a tool result.
		const round2 = calls[1]?.messages ?? [];
		expect(round2.some((m) => m.role === "assistant")).toBe(true);
		const toolMsg = round2.find((m) => m.role === "tool");
		expect(toolMsg?.tool_call_id).toBe("c1");
	});

	it("collects multiple tool calls within a single assistant turn", async () => {
		const { client } = mockClient([
			completion({
				tool_calls: [
					toolCall("c1", "create_comment", { quote: "a", body: "b1" }),
					toolCall("c2", "create_comment", { quote: "b", body: "b2" }),
					toolCall("e1", "suggest_edit", { quote: "a", replacement: "A" }),
				],
			}),
			completion({ content: "done" }),
		]);

		const result = await runReviewLoop(client, [...seed], { maxTokens: 1000 });

		expect(result.comments).toHaveLength(2);
		expect(result.suggestions).toHaveLength(1);
	});
});

describe("runReviewLoop — termination", () => {
	it("stops when the first turn has no tool calls (empty result)", async () => {
		const { client, create } = mockClient([
			completion({ content: "No notes — looks great." }),
		]);

		const result = await runReviewLoop(client, [...seed], { maxTokens: 1000 });

		expect(create).toHaveBeenCalledTimes(1);
		expect(result.iterations).toBe(1);
		expect(result.hitCap).toBe(false);
		expect(result.comments).toEqual([]);
		expect(result.suggestions).toEqual([]);
	});

	it("stops at the max-iteration cap if the model never stops calling tools", async () => {
		// Every completion keeps calling a tool → loop must be bounded by the cap.
		const endless = completion({
			tool_calls: [toolCall("c", "create_comment", { quote: "x", body: "y" })],
		});
		const { client, create } = mockClient(Array(20).fill(endless));

		const result = await runReviewLoop(client, [...seed], {
			maxTokens: 1000,
			maxIterations: 3,
		});

		expect(create).toHaveBeenCalledTimes(3);
		expect(result.iterations).toBe(3);
		expect(result.hitCap).toBe(true);
		// One comment recorded per round, all three rounds.
		expect(result.comments).toHaveLength(3);
	});
});

describe("runReviewLoop — malformed arg dropping", () => {
	it("drops tool calls with missing/non-string required fields and keeps valid ones", async () => {
		const { client } = mockClient([
			completion({
				tool_calls: [
					toolCall("c1", "create_comment", { quote: "ok", body: "good" }),
					toolCall("c2", "create_comment", { quote: "no body" }), // missing body
					toolCall("c3", "create_comment", { quote: 1, body: "bad quote" }), // non-string
					toolCall("e1", "suggest_edit", { quote: "x", replacement: "y" }),
					toolCall("e2", "suggest_edit", { quote: "no replacement" }), // missing replacement
				],
			}),
			completion({ content: "done" }),
		]);

		const result = await runReviewLoop(client, [...seed], { maxTokens: 1000 });

		expect(result.comments).toEqual([{ quote: "ok", body: "good" }]);
		expect(result.suggestions).toEqual([{ quote: "x", replacement: "y" }]);
	});

	it("drops a tool call whose arguments are not valid JSON", async () => {
		const { client } = mockClient([
			completion({
				tool_calls: [
					toolCall("c1", "create_comment", "{ not valid json"),
					toolCall("c2", "create_comment", { quote: "ok", body: "good" }),
				],
			}),
			completion({ content: "done" }),
		]);

		const result = await runReviewLoop(client, [...seed], { maxTokens: 1000 });

		expect(result.comments).toEqual([{ quote: "ok", body: "good" }]);
	});

	it("ignores unknown tool names but still acknowledges them", async () => {
		const { client, calls } = mockClient([
			completion({
				tool_calls: [
					toolCall("u1", "delete_everything", { foo: "bar" }),
					toolCall("c1", "create_comment", { quote: "ok", body: "good" }),
				],
			}),
			completion({ content: "done" }),
		]);

		const result = await runReviewLoop(client, [...seed], { maxTokens: 1000 });

		expect(result.comments).toEqual([{ quote: "ok", body: "good" }]);
		// Both calls must get a tool result so the conversation stays well-formed.
		const round2ToolMsgs = (calls[1]?.messages ?? []).filter(
			(m) => m.role === "tool",
		);
		expect(round2ToolMsgs.map((m) => m.tool_call_id).sort()).toEqual([
			"c1",
			"u1",
		]);
	});
});

describe("runReviewLoop — abort handling", () => {
	it("throws AbortError before the first request when already aborted", async () => {
		const { client, create } = mockClient([completion({ content: "x" })]);
		const ac = new AbortController();
		ac.abort();

		await expect(
			runReviewLoop(client, [...seed], { maxTokens: 1000, signal: ac.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(create).not.toHaveBeenCalled();
	});

	it("stops looping once the signal aborts between rounds", async () => {
		const ac = new AbortController();
		// First round calls a tool; abort fires when round 2 is about to start.
		const create = vi.fn(
			async (): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
				ac.abort();
				return completion({
					tool_calls: [
						toolCall("c1", "create_comment", { quote: "x", body: "y" }),
					],
				});
			},
		);
		const client: ReviewChatClient = { chat: { completions: { create } } };

		await expect(
			runReviewLoop(client, [...seed], { maxTokens: 1000, signal: ac.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("passes the signal through to the underlying create call", async () => {
		const ac = new AbortController();
		const { client, create } = mockClient([completion({ content: "done" })]);

		await runReviewLoop(client, [...seed], {
			maxTokens: 1000,
			signal: ac.signal,
		});

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ tools: expect.any(Array) }),
			expect.objectContaining({ signal: ac.signal }),
		);
	});
});

describe("runReviewLoop — parseReview fallback", () => {
	it("parses structured content when the model never calls a tool", async () => {
		const blob = JSON.stringify({
			comments: [{ quote: "x", body: "note" }],
			suggestions: [{ quote: "x", replacement: "y" }],
		});
		const { client } = mockClient([completion({ content: blob })]);

		const result = await runReviewLoop(client, [...seed], { maxTokens: 1000 });

		expect(result.comments).toEqual([{ quote: "x", body: "note" }]);
		expect(result.suggestions).toEqual([{ quote: "x", replacement: "y" }]);
	});

	it("does NOT apply the fallback once any tool call was made", async () => {
		// A tool call happened in round 1; the final content is a stray JSON blob
		// that must NOT be parsed (tool calls are the source of truth).
		const blob = JSON.stringify({
			comments: [{ quote: "ghost", body: "should not appear" }],
			suggestions: [],
		});
		const { client } = mockClient([
			completion({
				tool_calls: [
					toolCall("c1", "create_comment", { quote: "real", body: "kept" }),
				],
			}),
			completion({ content: blob }),
		]);

		const result = await runReviewLoop(client, [...seed], { maxTokens: 1000 });

		expect(result.comments).toEqual([{ quote: "real", body: "kept" }]);
	});
});
