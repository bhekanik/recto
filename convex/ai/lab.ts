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
	requestHash,
	requireActionUserId,
	utf8Length,
	validateRequestIdentity,
	verifySource,
} from "./request";

type ActionCtx = GenericActionCtx<DataModel>;
const MAX_PLATFORM_BYTES = 64;
const MAX_LAB_TOKENS = 4_096;

/** Approximate reductions the trim pass is asked for; a request, not a quota. */
export const TRIM_TARGETS = [10, 20, 30, 50] as const;
export type TrimTarget = (typeof TRIM_TARGETS)[number];

export type LabCut = { from: number; to: number; reason: string };
export type LabResult = {
	runId: Id<"aiRuns">;
	cuts: LabCut[];
	/** Proposals the server could not place exactly once in the source. */
	dropped: number;
};

type ProposedCut = { text?: unknown; before?: unknown; reason?: unknown };

const SYSTEM_PROMPT = `You are a careful editor trimming a writer's draft in a Markdown writing app.
Propose deletions only. Never rewrite, add, reorder or replace words: every cut must be text copied exactly from the draft, which the writer will see faded in place.
Cut what contributes least: repetition, throat-clearing, unnecessary explanation, hedges and filler, asides that do not earn their place. Keep facts, quotations, citations, names, numbers, personal experience and the writer's voice, including useful roughness and British spelling.
The target reduction is approximate. Stop early rather than cut meaning, and never cut Markdown syntax on its own (headings markers, link targets, list markers).
Prefer whole sentences or clauses where they can go; otherwise phrases or single words. Do not propose overlapping cuts.
Reply with JSON only: {"cuts":[{"text":"exact text to delete","before":"up to six words immediately before it in the draft","reason":"why it can go, in a few words"}]}`;

/**
 * Turn proposed cuts into exact ranges of `source`. A cut is placed only where
 * its text, or its preceding words plus its text, occurs exactly once; a guess
 * would delete the wrong words. Cuts in frontmatter or overlapping an earlier
 * cut are dropped too.
 */
export function locateCuts(
	source: string,
	proposed: readonly ProposedCut[],
): { cuts: LabCut[]; dropped: number } {
	const frontmatterEnd = source.startsWith("---\n")
		? source.indexOf("\n---", 4) + 4
		: 0;
	const cuts: LabCut[] = [];
	let dropped = 0;
	for (const item of proposed) {
		const text = typeof item.text === "string" ? item.text : "";
		const before = typeof item.before === "string" ? item.before : "";
		const reason =
			typeof item.reason === "string" ? item.reason.trim().slice(0, 200) : "";
		const from = uniqueIndex(source, text, before);
		if (
			text.trim().length === 0 ||
			from === null ||
			from < frontmatterEnd ||
			cuts.some((cut) => from < cut.to && cut.from < from + text.length)
		) {
			dropped += 1;
			continue;
		}
		cuts.push({ from, to: from + text.length, reason });
	}
	cuts.sort((a, b) => a.from - b.from);
	return { cuts, dropped };
}

function occurrences(source: string, text: string): number[] {
	const found: number[] = [];
	if (text.length === 0) return found;
	let index = source.indexOf(text);
	while (index !== -1) {
		found.push(index);
		index = source.indexOf(text, index + 1);
	}
	return found;
}

function uniqueIndex(
	source: string,
	text: string,
	before: string,
): number | null {
	const [only, second] = occurrences(source, text);
	if (only !== undefined && second === undefined) return only;
	if (before.length === 0) return null;
	for (const separator of ["", " "]) {
		const [anchored, again] = occurrences(source, before + separator + text);
		if (anchored !== undefined && again === undefined)
			return anchored + before.length + separator.length;
	}
	return null;
}

/** The JSON object in a reply, tolerating a fenced block around it. */
export function parseCuts(reply: string): ProposedCut[] {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start)
		throw new Error("The model did not return JSON");
	const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
	const cuts = (parsed as { cuts?: unknown }).cuts;
	if (!Array.isArray(cuts)) throw new Error("The model's reply had no cuts");
	return cuts.filter(
		(cut): cut is ProposedCut => typeof cut === "object" && cut !== null,
	);
}

const labArgs = {
	requestId: v.string(),
	documentId: v.id("documents"),
	sourceNodeId: v.string(),
	sourceHash: v.string(),
	target: v.number(),
	platform: v.string(),
	traceContent: v.boolean(),
};

function replay(run: {
	_id: Id<"aiRuns">;
	status: string;
	output?: string;
	applicable?: boolean;
}): LabResult | null {
	if (
		run.status === "succeeded" &&
		run.applicable === true &&
		run.output !== undefined
	) {
		const stored = JSON.parse(run.output) as {
			cuts: LabCut[];
			dropped: number;
		};
		return { runId: run._id, ...stored };
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

/**
 * The Lab's trim pass: exact, reasoned cuts for the draft at `sourceNodeId`,
 * proposed and never applied here. Shares the transform's lifecycle: a
 * reserved run per request id, source verification, the writer's or the house
 * key, and success only while the document is still the one it read.
 */
export const run = action({
	args: labArgs,
	handler: async (ctx, input): Promise<LabResult> => {
		validateRequestIdentity(input.requestId);
		if (
			!TRIM_TARGETS.includes(input.target as TrimTarget) ||
			input.sourceNodeId.trim().length === 0 ||
			input.sourceHash.length !== 64 ||
			input.platform.trim().length === 0 ||
			utf8Length(input.platform) > MAX_PLATFORM_BYTES
		)
			aiError("invalid_argument", "Invalid Lab request.");
		const userId = await requireActionUserId(ctx);
		const sourceMarkdown = await verifySource(ctx, { ...input, userId });
		const hash = await requestHash({
			kind: "lab",
			pass: "trim",
			documentId: input.documentId,
			sourceNodeId: input.sourceNodeId,
			sourceHash: input.sourceHash,
			target: String(input.target),
		});
		const begun = await ctx.runMutation(internal.ai.runs.begin, {
			userId,
			requestId: input.requestId,
			kind: "lab",
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
		return await execute(ctx, { input, userId, runId, sourceMarkdown });
	},
});

async function execute(
	ctx: ActionCtx,
	args: {
		input: {
			documentId: Id<"documents">;
			target: number;
			platform: string;
			traceContent: boolean;
		};
		userId: string;
		runId: Id<"aiRuns">;
		sourceMarkdown: string;
	},
): Promise<LabResult> {
	const { input, userId, runId, sourceMarkdown } = args;
	let provider: Awaited<ReturnType<typeof createProvider>>;
	try {
		const credential = await resolveCredential(ctx, userId);
		provider = await createProvider({
			apiKey: credential.apiKey,
			userId,
			kind: "lab",
			keySource: credential.source,
			documentId: input.documentId,
			platform: input.platform,
			traceContent: input.traceContent,
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
		if (!started.started)
			aiError("request_conflict", "The AI request was superseded.");
	} catch (error) {
		await ctx.runMutation(internal.ai.runs.finishError, {
			runId,
			userId,
			errorCode: errorCode(
				error instanceof Error ? error : new Error("AI setup failed"),
			),
			outcomeUnknown: false,
		});
		throw error;
	}
	const startedAt = Date.now();
	try {
		const completion = await provider.client.chat.completions.create(
			{
				model: AI_CHAT_MODEL,
				max_tokens: MAX_LAB_TOKENS,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{
						role: "user",
						content: `Target: about ${input.target}% shorter.\n\nDraft:\n${sourceMarkdown}`,
					},
				],
			},
			{ langsmithExtra: { metadata: { traceContent: input.traceContent } } },
		);
		const usage: OpenAI.CompletionUsage | undefined = completion.usage;
		const settled = await ctx
			.runMutation(internal.ai.runs.recordUsage, {
				runId,
				userId,
				callIndex: 0,
				usage: {
					...parseProviderUsage(usage),
					latencyMs: Date.now() - startedAt,
					langsmithRunId: provider.langsmithRunId,
				},
			})
			.catch(() => ({ recorded: false }));
		if (!settled.recorded) throw new ProviderUsageSettlementError();
		const located = locateCuts(
			sourceMarkdown,
			parseCuts(completion.choices[0]?.message.content ?? ""),
		);
		const recorded = await ctx.runMutation(internal.ai.runs.succeed, {
			runId,
			userId,
			output: JSON.stringify(located),
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
				"The provider completed, but the document changed before the cuts could be shown.",
			);
		}
		return { runId, ...located };
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
