import { Client } from "langsmith";
import { wrapOpenAI } from "langsmith/wrappers/openai";
import OpenAI from "openai";
import { z } from "zod";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const AI_CHAT_MODEL = "z-ai/glm-5.2";
export const AI_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const AI_EMBEDDING_DIM = 1536;

export type ProviderUsage = {
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	costMicros: number;
};

type ProviderUsageInput =
	| {
			prompt_tokens?: number;
			completion_tokens?: number;
			cost?: number;
			completion_tokens_details?: { reasoning_tokens?: number };
	  }
	| null
	| undefined;
const providerUsageSchema = z.object({
	prompt_tokens: z.number().nonnegative().optional(),
	completion_tokens: z.number().nonnegative().optional(),
	cost: z.number().nonnegative().optional(),
	completion_tokens_details: z
		.object({ reasoning_tokens: z.number().nonnegative().optional() })
		.optional(),
});

export function parseProviderUsage(value: ProviderUsageInput): ProviderUsage {
	const usage = providerUsageSchema.safeParse(value).data ?? {};
	return {
		promptTokens: Math.floor(usage.prompt_tokens ?? 0),
		completionTokens: Math.floor(usage.completion_tokens ?? 0),
		reasoningTokens: Math.floor(
			usage.completion_tokens_details?.reasoning_tokens ?? 0,
		),
		costMicros: Math.round((usage.cost ?? 0) * 1_000_000),
	};
}

export function providerOutcomeIsUnknown(error: Error): boolean {
	const name = error.name;
	return (
		name === "AbortError" ||
		name === "APIConnectionError" ||
		name === "APIConnectionTimeoutError" ||
		name === "APIUserAbortError" ||
		name === "TimeoutError" ||
		error instanceof TypeError
	);
}

export class ProviderUsageSettlementError extends Error {
	constructor() {
		super("A completed provider call could not be recorded.");
		this.name = "ProviderUsageSettlementError";
	}
}

export function completedProviderOutcomeIsUnknown(error: Error): boolean {
	return (
		error instanceof ProviderUsageSettlementError ||
		providerOutcomeIsUnknown(error)
	);
}

export type TracedProvider = {
	client: OpenAI & ReturnType<typeof wrapOpenAI>;
	langsmithRunId?: string;
	flush: () => Promise<void>;
};

export async function flushProvider(
	provider: Pick<TracedProvider, "flush">,
): Promise<void> {
	try {
		await provider.flush();
	} catch (error) {
		console.warn("LangSmith trace flush failed", error);
	}
}

export async function createProvider(args: {
	apiKey: string;
	userId: string;
	kind: "transform" | "review" | "embed";
	keySource: "byok" | "house";
	documentId: string;
	platform: string;
	traceContent: boolean;
}): Promise<TracedProvider> {
	const raw = new OpenAI({
		apiKey: args.apiKey,
		baseURL: OPENROUTER_BASE_URL,
		maxRetries: 0,
		defaultHeaders: {
			"HTTP-Referer": "https://bhekani.com/recto",
			"X-Title": "Recto",
		},
	});
	if (
		!args.traceContent ||
		process.env.LANGSMITH_TRACING !== "true" ||
		!process.env.LANGSMITH_API_KEY
	) {
		return {
			client: wrapOpenAI(raw, { tracingEnabled: false }),
			flush: async () => {},
		};
	}
	const tracingClient = new Client({
		apiKey: process.env.LANGSMITH_API_KEY,
	});
	const langsmithRunId = crypto.randomUUID();
	const hashedUserId = await crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(args.userId))
		.then((digest) =>
			Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join(""),
		);
	return {
		client: wrapOpenAI(raw, {
			id: langsmithRunId,
			name: `recto-${args.kind}`,
			project_name: process.env.LANGSMITH_PROJECT ?? "recto",
			client: tracingClient,
			metadata: {
				userHash: hashedUserId,
				kind: args.kind,
				keySource: args.keySource,
				documentId: args.documentId,
				platform: args.platform,
				traceContent: args.traceContent,
			},
		}),
		langsmithRunId,
		flush: async () => await tracingClient.awaitPendingTraceBatches(),
	};
}
