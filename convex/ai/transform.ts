import type { GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import type OpenAI from "openai";
import { internal } from "../_generated/api";
import type { DataModel, Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { resolveCredential } from "./credentials";
import { aiError, errorCode } from "./errors";
import {
	AI_CHAT_MODEL,
	completedProviderOutcomeIsUnknown,
	createProvider,
	flushProvider,
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

type ActionCtx = GenericActionCtx<DataModel>;
const MAX_INSTRUCTION_BYTES = 8_192;
const MAX_PLATFORM_BYTES = 64;
const MAX_TRANSFORM_TOKENS = 1_024;

export type TransformInput = {
	requestId: string;
	documentId: Id<"documents">;
	sourceNodeId: string;
	sourceHash: string;
	instruction: string;
	selection: string;
	platform: string;
	traceContent: boolean;
};

export type GenerateResult =
	| { kind: "replay"; output: string; runId: Id<"aiRuns"> }
	| { kind: "generated"; output: string; runId: Id<"aiRuns"> };

type Provider = Awaited<ReturnType<typeof createProvider>>;
export type PreparedTransform = {
	kind: "prepared";
	ctx: ActionCtx;
	input: TransformInput;
	userId: string;
	runId: Id<"aiRuns">;
	provider: Provider;
	sourceMarkdown: string;
};

export async function settleCompletedTransform(args: {
	output: string;
	settle: () => Promise<boolean>;
}): Promise<void> {
	try {
		if (!(await args.settle())) throw new Error("usage not recorded");
	} catch {
		throw new ProviderUsageSettlementError();
	}
	if (args.output.length === 0) throw new Error("The model returned nothing");
}

function validateInput(input: TransformInput): void {
	validateRequestIdentity(input.requestId);
	if (
		input.sourceNodeId.trim().length === 0 ||
		input.sourceHash.length !== 64 ||
		input.instruction.trim().length === 0 ||
		input.selection.length === 0 ||
		utf8Length(input.instruction) > MAX_INSTRUCTION_BYTES ||
		utf8Length(input.selection) > MAX_AI_TEXT_BYTES ||
		input.platform.trim().length === 0 ||
		utf8Length(input.platform) > MAX_PLATFORM_BYTES
	)
		aiError("invalid_argument", "Invalid AI transform request.");
}

function replay(run: {
	_id: Id<"aiRuns">;
	status: string;
	output?: string;
	applicable?: boolean;
}): GenerateResult | null {
	if (
		run.status === "succeeded" &&
		run.applicable === true &&
		run.output !== undefined
	) {
		return { kind: "replay", output: run.output, runId: run._id };
	}
	if (run.status === "provider_started" || run.status === "outcome_unknown") {
		aiError(
			"request_outcome_unknown",
			"The provider may have processed this request. Do not retry it with the same id.",
		);
	}
	if (run.status === "reserved")
		aiError("request_in_progress", "This AI request is already in progress.");
	return null;
}

async function settleSetupFailure(
	ctx: ActionCtx,
	runId: Id<"aiRuns">,
	userId: string,
	error: Error,
): Promise<never> {
	await ctx.runMutation(internal.ai.runs.finishError, {
		runId,
		userId,
		errorCode: errorCode(error),
		outcomeUnknown: false,
	});
	throw error;
}

/** Complete local setup before the HTTP endpoint commits a successful response. */
export async function prepareTransform(
	ctx: ActionCtx,
	input: TransformInput,
): Promise<PreparedTransform | GenerateResult> {
	validateInput(input);
	const userId = await requireActionUserId(ctx);
	const sourceMarkdown = await verifySource(ctx, { ...input, userId });
	const hash = await requestHash({
		kind: "transform",
		documentId: input.documentId,
		sourceNodeId: input.sourceNodeId,
		sourceHash: input.sourceHash,
		instruction: input.instruction,
		selection: input.selection,
	});
	const begun = await ctx.runMutation(internal.ai.runs.begin, {
		userId,
		requestId: input.requestId,
		kind: "transform",
		documentId: input.documentId,
		sourceNodeId: input.sourceNodeId,
		sourceHash: input.sourceHash,
		expectedSourceMarkdown: sourceMarkdown,
		requestHash: hash,
		model: AI_CHAT_MODEL,
	});
	if (begun.replay) {
		const result = replay(begun.run);
		if (result) return result;
		aiError("request_conflict", "This AI request id cannot be reused.");
	}
	const runId = begun.run._id;
	let provider: Provider;
	let keySource: "byok" | "house";
	try {
		const credential = await resolveCredential(ctx, userId);
		keySource = credential.source;
		provider = await createProvider({
			apiKey: credential.apiKey,
			userId,
			kind: "transform",
			keySource,
			documentId: input.documentId,
			platform: input.platform,
			traceContent: input.traceContent,
		});
	} catch (error) {
		const failure =
			error instanceof Error ? error : new Error("AI setup failed");
		return await settleSetupFailure(ctx, runId, userId, failure);
	}
	try {
		// Last retry-safe boundary before outbound inference.
		const started = await ctx.runMutation(
			internal.ai.runs.markProviderStarted,
			{ runId, userId, keySource, expectedSourceMarkdown: sourceMarkdown },
		);
		if (!started.started)
			aiError("request_conflict", "The AI request was superseded.");
	} catch (error) {
		await flushProvider(provider);
		const failure =
			error instanceof Error ? error : new Error("AI setup failed");
		return await settleSetupFailure(ctx, runId, userId, failure);
	}
	return {
		kind: "prepared",
		ctx,
		input,
		userId,
		runId,
		provider,
		sourceMarkdown,
	};
}

export async function executePreparedTransform(
	prepared: PreparedTransform,
	onDelta?: (delta: string) => void,
	signal?: AbortSignal,
): Promise<GenerateResult> {
	const { ctx, input, provider, runId, userId, sourceMarkdown } = prepared;
	const startedAt = Date.now();
	let output = "";
	let usage: OpenAI.CompletionUsage | null | undefined;
	try {
		const stream = await provider.client.chat.completions.create(
			{
				model: AI_CHAT_MODEL,
				max_tokens: MAX_TRANSFORM_TOKENS,
				stream: true,
				stream_options: { include_usage: true },
				messages: [
					{
						role: "system",
						content:
							"You are a precise prose editor embedded in a Markdown writing app. Apply the instruction and return only the rewritten selection. Preserve the writer's voice and existing Markdown unless asked to change it.",
					},
					{
						role: "user",
						content: `Instruction: ${input.instruction}\n\nText:\n${input.selection}`,
					},
				],
			},
			{
				signal,
				langsmithExtra: { metadata: { traceContent: input.traceContent } },
			},
		);
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta.content ?? "";
			if (delta) {
				output += delta;
				onDelta?.(delta);
			}
			if (chunk.usage) usage = chunk.usage;
		}
		await settleCompletedTransform({
			output,
			settle: async () => {
				const settled = await ctx.runMutation(internal.ai.runs.recordUsage, {
					runId,
					userId,
					callIndex: 0,
					usage: {
						...parseProviderUsage(usage),
						latencyMs: Date.now() - startedAt,
						langsmithRunId: provider.langsmithRunId,
					},
				});
				return settled.recorded;
			},
		});
		const recorded = await ctx.runMutation(internal.ai.runs.succeed, {
			runId,
			userId,
			output,
			expectedSourceMarkdown: sourceMarkdown,
			usage: {
				...parseProviderUsage(usage),
				latencyMs: Date.now() - startedAt,
				langsmithRunId: provider.langsmithRunId,
			},
		});
		if (!recorded.applicable) {
			aiError(
				"document_changed",
				"The provider completed, but the document changed before application.",
			);
		}
		return { kind: "generated", output, runId };
	} catch (error) {
		const failure =
			error instanceof Error ? error : new Error("AI provider failed");
		await ctx.runMutation(internal.ai.runs.finishError, {
			runId,
			userId,
			errorCode: errorCode(failure),
			outcomeUnknown: completedProviderOutcomeIsUnknown(failure),
		});
		throw error;
	} finally {
		await flushProvider(provider);
	}
}

const transformArgs = {
	requestId: v.string(),
	documentId: v.id("documents"),
	sourceNodeId: v.string(),
	sourceHash: v.string(),
	instruction: v.string(),
	selection: v.string(),
	platform: v.string(),
	traceContent: v.boolean(),
};

export const run = action({
	args: transformArgs,
	handler: async (ctx, args) => {
		const prepared = await prepareTransform(ctx, args);
		return prepared.kind === "prepared"
			? await executePreparedTransform(prepared)
			: prepared;
	},
});
