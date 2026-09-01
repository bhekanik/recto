import { v } from "convex/values";
import type OpenAI from "openai";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { resolveCredential } from "./credentials";
import { aiError, errorCode } from "./errors";
import {
	AI_CHAT_MODEL,
	completedProviderOutcomeIsUnknown,
	createProvider,
	flushProvider,
	type ProviderUsage,
	ProviderUsageSettlementError,
	parseProviderUsage,
} from "./provider";
import {
	MAX_AI_TEXT_BYTES,
	requestHash,
	requireActionUserId,
	utf8Length,
	validateRequestIdentity,
	verifySource,
} from "./request";

type Comment = { quote: string; body: string; category?: string };
type Suggestion = { quote: string; replacement: string };
type ReviewResult = { comments: Comment[]; suggestions: Suggestion[] };
type AiReviewSummary = {
	commentsPlaced: number;
	commentsTotal: number;
	commentsDropped: number;
	editsPlaced: number;
	editsTotal: number;
	editsDropped: number;
	branchId: Id<"reviewBranches"> | null;
};
type AppliedSuggestions = { text: string; applied: number };
export type ReviewCompletionClient = {
	chat: {
		completions: {
			create: (
				body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
				options?: { signal?: AbortSignal },
			) => Promise<
				Pick<OpenAI.Chat.Completions.ChatCompletion, "choices" | "usage">
			>;
		};
	};
};

export { ProviderUsageSettlementError } from "./provider";

export function reviewOutcomeIsUnknown(error: Error): boolean {
	return completedProviderOutcomeIsUnknown(error);
}

const MAX_REVIEW_TOKENS = 4_000;
const MAX_REVIEW_ITERATIONS = 8;
const MAX_REVIEW_ITEMS = 100;

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "create_comment",
			description: "Leave one editorial comment anchored to an exact quote.",
			parameters: {
				type: "object",
				properties: {
					quote: { type: "string" },
					body: { type: "string" },
					category: { type: "string" },
				},
				required: ["quote", "body"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "suggest_edit",
			description: "Suggest a replacement for an exact quote.",
			parameters: {
				type: "object",
				properties: {
					quote: { type: "string" },
					replacement: { type: "string" },
				},
				required: ["quote", "replacement"],
				additionalProperties: false,
			},
		},
	},
];

const commentToolArgsSchema = z.object({
	quote: z.string().min(1),
	body: z.string().trim().min(1),
	category: z.string().optional(),
});
const suggestionToolArgsSchema = z.object({
	quote: z.string().min(1),
	replacement: z.string(),
});
const reviewSummarySchema = z.object({
	commentsPlaced: z.number(),
	commentsTotal: z.number(),
	commentsDropped: z.number(),
	editsPlaced: z.number(),
	editsTotal: z.number(),
	editsDropped: z.number(),
	branchId: z.string().nullable(),
});

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
	try {
		const parsed = schema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function addUsage(
	total: ProviderUsage,
	value: OpenAI.CompletionUsage | undefined,
): void {
	const next = parseProviderUsage(value);
	total.promptTokens += next.promptTokens;
	total.completionTokens += next.completionTokens;
	total.reasoningTokens += next.reasoningTokens;
	total.costMicros += next.costMicros;
}

export async function reviewWithTools(args: {
	client: ReviewCompletionClient;
	text: string;
	signal?: AbortSignal;
	settle: (args: {
		callIndex: number;
		usage: ProviderUsage;
		latencyMs: number;
	}) => Promise<void>;
}): Promise<{ result: ReviewResult; usage: ProviderUsage }> {
	const comments: Comment[] = [];
	const suggestions: Suggestion[] = [];
	const usage: ProviderUsage = {
		promptTokens: 0,
		completionTokens: 0,
		reasoningTokens: 0,
		costMicros: 0,
	};
	const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
		{
			role: "system",
			content:
				"Review the Markdown draft. Use create_comment for anchored feedback and suggest_edit for exact replacements. Quotes must be verbatim substrings. Stop when the useful feedback is recorded.",
		},
		{ role: "user", content: args.text },
	];
	for (let iteration = 0; iteration < MAX_REVIEW_ITERATIONS; iteration += 1) {
		if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const callStartedAt = Date.now();
		const completion = await args.client.chat.completions.create(
			{
				model: AI_CHAT_MODEL,
				max_tokens: MAX_REVIEW_TOKENS,
				messages,
				tools,
				tool_choice: "auto",
			},
			{ signal: args.signal },
		);
		const callUsage = parseProviderUsage(completion.usage);
		addUsage(usage, completion.usage);
		try {
			await args.settle({
				callIndex: iteration,
				usage: callUsage,
				latencyMs: Date.now() - callStartedAt,
			});
		} catch {
			throw new ProviderUsageSettlementError();
		}
		const message = completion.choices[0]?.message;
		const calls = message?.tool_calls ?? [];
		if (!message || calls.length === 0) break;
		messages.push(message);
		for (const call of calls) {
			let acknowledgement = "ignored";
			if (call.type === "function") {
				if (call.function.name === "create_comment") {
					const comment = parseJson(
						call.function.arguments,
						commentToolArgsSchema,
					);
					if (comment && comments.length < MAX_REVIEW_ITEMS) {
						comments.push(comment);
						acknowledgement = "recorded";
					}
				} else if (call.function.name === "suggest_edit") {
					const suggestion = parseJson(
						call.function.arguments,
						suggestionToolArgsSchema,
					);
					if (suggestion && suggestions.length < MAX_REVIEW_ITEMS) {
						suggestions.push(suggestion);
						acknowledgement = "recorded";
					}
				}
			}
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: acknowledgement,
			});
		}
	}
	return { result: { comments, suggestions }, usage };
}

function uniqueQuoteOffset(text: string, quote: string): number | null {
	const first = text.indexOf(quote);
	if (first < 0 || text.indexOf(quote, first + 1) >= 0) return null;
	return first;
}

export function applySuggestions(
	text: string,
	suggestions: Suggestion[],
): AppliedSuggestions {
	const edits = suggestions
		.map((suggestion) => {
			const from = uniqueQuoteOffset(text, suggestion.quote);
			return from === null
				? null
				: {
						from,
						to: from + suggestion.quote.length,
						replacement: suggestion.replacement,
					};
		})
		.filter((edit) => edit !== null)
		.sort((a, b) => b.from - a.from);
	let result = text;
	let previousFrom = text.length;
	let applied = 0;
	for (const edit of edits) {
		if (edit.to > previousFrom) continue;
		if (result.slice(edit.from, edit.to) === edit.replacement) continue;
		result =
			result.slice(0, edit.from) + edit.replacement + result.slice(edit.to);
		previousFrom = edit.from;
		applied += 1;
	}
	return { text: result, applied };
}

export const run = action({
	args: {
		requestId: v.string(),
		documentId: v.id("documents"),
		sourceNodeId: v.string(),
		sourceHash: v.string(),
		text: v.string(),
		platform: v.string(),
		traceContent: v.boolean(),
	},
	handler: async (ctx, args): Promise<AiReviewSummary> => {
		validateRequestIdentity(args.requestId);
		if (
			args.text.trim().length === 0 ||
			utf8Length(args.text) > MAX_AI_TEXT_BYTES ||
			args.sourceHash.length !== 64
		) {
			aiError("invalid_argument", "Invalid AI review request.");
		}
		const userId = await requireActionUserId(ctx);
		const sourceMarkdown = await verifySource(ctx, { ...args, userId });
		if (args.text !== sourceMarkdown) {
			aiError("document_changed", "The review text does not match the draft.");
		}
		const hash = await requestHash({
			kind: "review",
			documentId: args.documentId,
			sourceNodeId: args.sourceNodeId,
			sourceHash: args.sourceHash,
			text: args.text,
		});
		const begun = await ctx.runMutation(internal.ai.runs.begin, {
			userId,
			requestId: args.requestId,
			kind: "review",
			documentId: args.documentId,
			sourceNodeId: args.sourceNodeId,
			sourceHash: args.sourceHash,
			expectedSourceMarkdown: sourceMarkdown,
			requestHash: hash,
			model: AI_CHAT_MODEL,
		});
		if (begun.replay) {
			if (begun.run.status === "succeeded" && begun.run.output) {
				const value = parseJson(begun.run.output, reviewSummarySchema);
				if (value) {
					const branchId =
						value.branchId === null
							? null
							: await ctx.runQuery(internal.ai.runs.normalizeReviewBranchId, {
									value: value.branchId,
								});
					if (value.branchId !== null && branchId === null) {
						aiError(
							"request_outcome_unknown",
							"The stored review result is unreadable.",
						);
					}
					return {
						...value,
						branchId,
					};
				}
				aiError(
					"request_outcome_unknown",
					"The stored review result is unreadable.",
				);
			}
			aiError(
				"request_outcome_unknown",
				"This review may already have reached the provider.",
			);
		}
		const runId = begun.run._id;
		let provider: Awaited<ReturnType<typeof createProvider>>;
		try {
			const credential = await resolveCredential(ctx, userId);
			provider = await createProvider({
				apiKey: credential.apiKey,
				userId,
				kind: "review",
				keySource: credential.source,
				documentId: args.documentId,
				platform: args.platform,
				traceContent: args.traceContent,
			});
			const started = await ctx.runMutation(
				internal.ai.runs.markProviderStarted,
				{
					runId,
					userId,
					keySource: credential.source,
					expectedSourceMarkdown: sourceMarkdown,
				},
			);
			if (!started.started) {
				aiError("request_conflict", "The AI request was superseded.");
			}
		} catch (error) {
			const failure =
				error instanceof Error ? error : new Error("AI setup failed");
			await ctx.runMutation(internal.ai.runs.finishError, {
				runId,
				userId,
				errorCode: errorCode(failure),
				outcomeUnknown: false,
			});
			throw error;
		}
		try {
			const { result } = await reviewWithTools({
				client: provider.client,
				text: args.text,
				settle: async (call) => {
					const recorded = await ctx.runMutation(internal.ai.runs.recordUsage, {
						runId,
						userId,
						callIndex: call.callIndex,
						usage: {
							...call.usage,
							latencyMs: call.latencyMs,
							langsmithRunId: provider.langsmithRunId,
						},
					});
					if (!recorded.recorded) {
						aiError("request_conflict", "The AI request was superseded.");
					}
				},
			});
			const comments = result.comments.flatMap((comment) => {
				const offset = uniqueQuoteOffset(args.text, comment.quote);
				if (offset === null) return [];
				return [
					{
						anchor: {
							quote: comment.quote,
							prefix: args.text.slice(Math.max(0, offset - 32), offset),
							suffix: args.text.slice(
								offset + comment.quote.length,
								offset + comment.quote.length + 32,
							),
							offsetHint: offset,
						},
						body: comment.category
							? `[${comment.category}] ${comment.body}`
							: comment.body,
					},
				];
			});
			const suggestions = applySuggestions(args.text, result.suggestions);
			const applied = await ctx.runMutation(internal.review.applyAiReview, {
				runId,
				userId,
				documentId: args.documentId,
				sourceNodeId: args.sourceNodeId,
				sourceText: args.text,
				comments,
				commentsTotal: result.comments.length,
				branchMarkdown:
					suggestions.text === args.text ? undefined : suggestions.text,
				editsApplied: suggestions.applied,
				editsTotal: result.suggestions.length,
				langsmithRunId: provider.langsmithRunId,
			});
			const summary: AiReviewSummary = {
				commentsPlaced: applied.commentsPlaced,
				commentsTotal: applied.commentsTotal,
				commentsDropped: applied.commentsDropped,
				editsPlaced: applied.editsPlaced,
				editsTotal: applied.editsTotal,
				editsDropped: applied.editsDropped,
				branchId: applied.branchId,
			};
			if (!applied.applicable) {
				aiError(
					"document_changed",
					"The provider completed, but the review is no longer applicable.",
				);
			}
			return summary;
		} catch (error) {
			const failure =
				error instanceof Error ? error : new Error("AI review failed");
			await ctx.runMutation(internal.ai.runs.finishError, {
				runId,
				userId,
				errorCode: errorCode(failure),
				outcomeUnknown: reviewOutcomeIsUnknown(failure),
			});
			throw error;
		} finally {
			await flushProvider(provider);
		}
	},
});
