/**
 * The server-side tool-calling loop for the AI review pass (plan 011,
 * tool-calling variant). Replaces the single structured-JSON round-trip with a
 * proper loop: send the messages + the two review tools to OpenRouter, and each
 * time the model returns `tool_calls`, record every well-formed call into
 * `comments` / `suggestions`, append the assistant message plus one `tool` result
 * message per call, and loop again. The loop terminates when the model returns no
 * tool calls (a final assistant message) OR when {@link AI_REVIEW_MAX_ITERATIONS}
 * is hit. The accumulated calls map onto the SAME `{ comments, suggestions }`
 * shape the route has always returned, so the client and plan 010's primitives
 * are unchanged.
 *
 * Defensive throughout: malformed tool-call args are dropped (never written), and
 * a still-acknowledged `tool` result is sent for EVERY tool_call id (even dropped
 * ones) so the conversation stays well-formed for the next turn. If the model
 * stops with plain content and produced no tool calls at all, that final content
 * is parsed with `parseReview` as a fallback so a non-tool-calling model still
 * degrades gracefully instead of returning empty.
 *
 * This module is provider-agnostic at the type level: it depends only on a narrow
 * `ReviewChatClient` (the shape of `client.chat.completions.create`), so the route
 * passes the real OpenRouter client and tests pass a mock — the real LLM is never
 * called from tests.
 */

import type OpenAI from "openai";

import { AI_CHAT_MODEL, AI_REVIEW_MAX_ITERATIONS } from "./config";
import {
	type AiReviewComment,
	type AiReviewResult,
	type AiReviewSuggestion,
	CREATE_COMMENT_TOOL,
	parseCommentArgs,
	parseReview,
	parseSuggestionArgs,
	REVIEW_TOOLS,
	SUGGEST_EDIT_TOOL,
} from "./review";

/**
 * The narrow slice of the OpenAI client the loop needs: a single
 * `chat.completions.create` (non-streaming) call. Both the real OpenRouter client
 * and the test mock satisfy this.
 */
export type ReviewChatClient = {
	chat: {
		completions: {
			create: (
				params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
				options?: { signal?: AbortSignal },
			) => Promise<OpenAI.Chat.Completions.ChatCompletion>;
		};
	};
};

/** What the loop reports back beyond the result (handy for logging/tests). */
export type ReviewLoopOutcome = AiReviewResult & {
	/** Number of LLM round-trips actually made. */
	iterations: number;
	/** True if the loop stopped because it hit AI_REVIEW_MAX_ITERATIONS. */
	hitCap: boolean;
};

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Run the tool-calling review loop.
 *
 * @param client   A `chat.completions.create`-capable client (real or mocked).
 * @param messages The seed conversation (system + user) from `buildReviewMessages`.
 * @param opts.maxTokens Per-request output cap.
 * @param opts.signal    AbortSignal honored across EVERY iteration.
 * @param opts.maxIterations Override the round-trip cap (defaults to config).
 */
export async function runReviewLoop(
	client: ReviewChatClient,
	messages: Message[],
	opts: {
		maxTokens: number;
		signal?: AbortSignal;
		maxIterations?: number;
	},
): Promise<ReviewLoopOutcome> {
	const maxIterations = opts.maxIterations ?? AI_REVIEW_MAX_ITERATIONS;
	const comments: AiReviewComment[] = [];
	const suggestions: AiReviewSuggestion[] = [];
	// Mutable working conversation we grow with assistant + tool messages.
	const convo: Message[] = [...messages];

	let iterations = 0;
	let sawAnyToolCall = false;
	let lastContent = "";

	while (iterations < maxIterations) {
		// Honor cancellation before each round-trip (the route's request signal).
		if (opts.signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		iterations++;

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
			reasoning?: { enabled: boolean };
		} = {
			model: AI_CHAT_MODEL,
			max_tokens: opts.maxTokens,
			messages: convo,
			tools: REVIEW_TOOLS,
			tool_choice: "auto",
			// OpenRouter extension: disable GLM 5.2 reasoning so tool calls aren't
			// starved by reasoning tokens (mirrors the prior structured-JSON route).
			reasoning: { enabled: false },
		};

		const completion = await client.chat.completions.create(params, {
			signal: opts.signal,
		});

		const choice = completion.choices?.[0];
		const message = choice?.message;
		lastContent = message?.content ?? "";
		const toolCalls = message?.tool_calls ?? [];

		// No tool calls → the model is done; this is the terminating turn.
		if (toolCalls.length === 0) break;

		sawAnyToolCall = true;

		// Append the assistant turn verbatim so the tool results reference the right
		// call ids. (The SDK message object is a valid param.)
		convo.push(message as Message);

		for (const call of toolCalls) {
			// Only function tool calls have a `.function` payload.
			if (call.type !== "function") {
				convo.push(toolResult(call.id, "ignored: unsupported tool type"));
				continue;
			}
			const name = call.function.name;
			const rawArgs = call.function.arguments ?? "";

			if (name === CREATE_COMMENT_TOOL) {
				const comment = parseCommentArgs(rawArgs);
				if (comment) {
					comments.push(comment);
					convo.push(toolResult(call.id, "recorded comment"));
				} else {
					convo.push(
						toolResult(
							call.id,
							"dropped: invalid arguments (need non-empty string `quote` and `body`)",
						),
					);
				}
			} else if (name === SUGGEST_EDIT_TOOL) {
				const suggestion = parseSuggestionArgs(rawArgs);
				if (suggestion) {
					suggestions.push(suggestion);
					convo.push(toolResult(call.id, "recorded edit"));
				} else {
					convo.push(
						toolResult(
							call.id,
							"dropped: invalid arguments (need non-empty string `quote` and `replacement`)",
						),
					);
				}
			} else {
				convo.push(toolResult(call.id, `ignored: unknown tool "${name}"`));
			}
		}
	}

	const hitCap = iterations >= maxIterations;

	// Fallback: if the model never called a single tool but left structured
	// content (older/non-tool-calling behavior), parse it the legacy way so we
	// still surface feedback instead of an empty result.
	if (!sawAnyToolCall && lastContent.trim().length > 0) {
		const fallback = parseReview(lastContent);
		if (fallback.comments.length > 0 || fallback.suggestions.length > 0) {
			return {
				comments: fallback.comments,
				suggestions: fallback.suggestions,
				iterations,
				hitCap,
			};
		}
	}

	return { comments, suggestions, iterations, hitCap };
}

/** Build a `tool` role result message acknowledging a tool call by id. */
function toolResult(toolCallId: string, content: string): Message {
	return { role: "tool", tool_call_id: toolCallId, content };
}
