import { v } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { resolveCredential } from "./credentials";
import { aiError, errorCode } from "./errors";
import {
	AI_EMBEDDING_DIM,
	AI_EMBEDDING_MODEL,
	createProvider,
	flushProvider,
	parseProviderUsage,
	providerOutcomeIsUnknown,
} from "./provider";
import {
	requestHash,
	requireActionUserId,
	utf8Length,
	validateRequestIdentity,
	verifySource,
} from "./request";

const MAX_EMBED_INPUTS = 16;
const MAX_EMBED_INPUT_BYTES = 16_384;
const embeddingReplaySchema = z.array(
	z.array(z.number().finite()).length(AI_EMBEDDING_DIM),
);

function parseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
	try {
		const parsed = schema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function parseReplay(output: string): number[][] {
	const parsed = parseJson(output, embeddingReplaySchema);
	if (!parsed) {
		aiError(
			"request_outcome_unknown",
			"The stored embedding result is unreadable.",
		);
	}
	return parsed;
}

export const run = action({
	args: {
		requestId: v.string(),
		documentId: v.id("documents"),
		sourceNodeId: v.string(),
		sourceHash: v.string(),
		inputs: v.array(v.string()),
		platform: v.string(),
		traceContent: v.boolean(),
	},
	handler: async (ctx, args): Promise<number[][]> => {
		validateRequestIdentity(args.requestId);
		if (
			args.inputs.length === 0 ||
			args.inputs.length > MAX_EMBED_INPUTS ||
			args.inputs.some(
				(input) =>
					input.trim().length === 0 ||
					utf8Length(input) > MAX_EMBED_INPUT_BYTES,
			) ||
			args.sourceHash.length !== 64
		) {
			aiError("invalid_argument", "Invalid embedding request.");
		}
		const userId = await requireActionUserId(ctx);
		const sourceMarkdown = await verifySource(ctx, { ...args, userId });
		const hash = await requestHash({
			kind: "embed",
			documentId: args.documentId,
			sourceNodeId: args.sourceNodeId,
			sourceHash: args.sourceHash,
			inputs: args.inputs,
		});
		const begun = await ctx.runMutation(internal.ai.runs.begin, {
			userId,
			requestId: args.requestId,
			kind: "embed",
			documentId: args.documentId,
			sourceNodeId: args.sourceNodeId,
			sourceHash: args.sourceHash,
			expectedSourceMarkdown: sourceMarkdown,
			requestHash: hash,
			model: AI_EMBEDDING_MODEL,
		});
		if (begun.replay) {
			if (begun.run.status === "succeeded" && begun.run.output) {
				return parseReplay(begun.run.output);
			}
			aiError(
				"request_outcome_unknown",
				"This embedding request may already have reached the provider.",
			);
		}
		const runId = begun.run._id;
		let provider: Awaited<ReturnType<typeof createProvider>>;
		try {
			const credential = await resolveCredential(ctx, userId);
			provider = await createProvider({
				apiKey: credential.apiKey,
				userId,
				kind: "embed",
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
		const startedAt = Date.now();
		try {
			const response = await provider.client.embeddings.create({
				model: AI_EMBEDDING_MODEL,
				input: args.inputs,
			});
			const embeddings = response.data.map((entry) => entry.embedding);
			if (
				embeddings.length !== args.inputs.length ||
				embeddings.some((vector) => vector.length !== AI_EMBEDDING_DIM)
			) {
				throw new Error("OpenRouter returned invalid embeddings.");
			}
			const output = JSON.stringify(embeddings);
			const recorded = await ctx.runMutation(internal.ai.runs.succeed, {
				runId,
				userId,
				output,
				expectedSourceMarkdown: sourceMarkdown,
				usage: {
					...parseProviderUsage(response.usage),
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
			return embeddings;
		} catch (error) {
			const failure =
				error instanceof Error ? error : new Error("Embedding failed");
			await ctx.runMutation(internal.ai.runs.finishError, {
				runId,
				userId,
				errorCode: errorCode(failure),
				outcomeUnknown: providerOutcomeIsUnknown(failure),
			});
			throw error;
		} finally {
			await flushProvider(provider);
		}
	},
});
