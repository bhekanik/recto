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

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** What every Lab request carries: who, which draft, and how to trace it. */
const baseArgs = {
	requestId: v.string(),
	documentId: v.id("documents"),
	sourceNodeId: v.string(),
	sourceHash: v.string(),
	platform: v.string(),
	traceContent: v.boolean(),
};

type BaseInput = {
	requestId: string;
	documentId: Id<"documents">;
	sourceNodeId: string;
	sourceHash: string;
	platform: string;
	traceContent: boolean;
};

/** One Lab pass: how its request is identified, what it asks, how it reads the reply. */
type LabPass<T extends object> = {
	name: string;
	identity: Record<string, string>;
	/** Refuses a request that does not fit the draft, before any run is reserved. */
	check?: (source: string) => void;
	messages: (source: string) => Message[];
	maxTokens: number;
	parse: (reply: string, source: string) => T;
};

function validateBase(input: BaseInput): void {
	validateRequestIdentity(input.requestId);
	if (
		input.sourceNodeId.trim().length === 0 ||
		input.sourceHash.length !== 64 ||
		input.platform.trim().length === 0 ||
		utf8Length(input.platform) > MAX_PLATFORM_BYTES
	)
		aiError("invalid_argument", "Invalid Lab request.");
}

function replay<T extends object>(run: {
	_id: Id<"aiRuns">;
	status: string;
	output?: string;
	applicable?: boolean;
}): ({ runId: Id<"aiRuns"> } & T) | null {
	if (
		run.status === "succeeded" &&
		run.applicable === true &&
		run.output !== undefined
	) {
		return { runId: run._id, ...(JSON.parse(run.output) as T) };
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
 * The transform's lifecycle for a Lab pass: a reserved run per request id,
 * source verification against the stored head, the writer's or the house key,
 * a retry-safe boundary before inference, usage settled, and success only
 * while the document is still the one it read. The parsed result is the run's
 * output, so a retry with the same id replays it.
 */
async function runPass<T extends object>(
	ctx: ActionCtx,
	input: BaseInput,
	pass: LabPass<T>,
): Promise<{ runId: Id<"aiRuns"> } & T> {
	const userId = await requireActionUserId(ctx);
	const sourceMarkdown = await verifySource(ctx, { ...input, userId });
	pass.check?.(sourceMarkdown);
	const hash = await requestHash({
		kind: "lab",
		pass: pass.name,
		documentId: input.documentId,
		sourceNodeId: input.sourceNodeId,
		sourceHash: input.sourceHash,
		...pass.identity,
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
		const result = replay<T>(begun.run);
		if (result) return result;
		aiError("request_conflict", "This AI request id cannot be reused.");
	}
	const runId = begun.run._id;
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
				max_tokens: pass.maxTokens,
				messages: pass.messages(sourceMarkdown),
			},
			{ langsmithExtra: { metadata: { traceContent: input.traceContent } } },
		);
		const usage: OpenAI.CompletionUsage | undefined = completion.usage;
		const metrics = {
			...parseProviderUsage(usage),
			latencyMs: Date.now() - startedAt,
			langsmithRunId: provider.langsmithRunId,
		};
		const settled = await ctx
			.runMutation(internal.ai.runs.recordUsage, {
				runId,
				userId,
				callIndex: 0,
				usage: metrics,
			})
			.catch(() => ({ recorded: false }));
		if (!settled.recorded) throw new ProviderUsageSettlementError();
		const result = pass.parse(
			completion.choices[0]?.message.content ?? "",
			sourceMarkdown,
		);
		const recorded = await ctx.runMutation(internal.ai.runs.succeed, {
			runId,
			userId,
			output: JSON.stringify(result),
			expectedSourceMarkdown: sourceMarkdown,
			usage: metrics,
		});
		if (!recorded.applicable) {
			aiError(
				"document_changed",
				"The provider completed, but the document changed before the result could be shown.",
			);
		}
		return { runId, ...result };
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

/**
 * The Lab's trim pass: exact, reasoned cuts for the draft at `sourceNodeId`,
 * proposed and never applied here.
 */
export const run = action({
	args: { ...baseArgs, target: v.number() },
	handler: async (ctx, input): Promise<LabResult> => {
		validateBase(input);
		if (!TRIM_TARGETS.includes(input.target as TrimTarget))
			aiError("invalid_argument", "Invalid Lab request.");
		return await runPass(ctx, input, {
			name: "trim",
			identity: { target: String(input.target) },
			maxTokens: MAX_LAB_TOKENS,
			messages: (source) => [
				{ role: "system", content: SYSTEM_PROMPT },
				{
					role: "user",
					content: `Target: about ${input.target}% shorter.\n\nDraft:\n${source}`,
				},
			],
			parse: (reply, source) => locateCuts(source, parseCuts(reply)),
		});
	},
});

// MARK: - Alternatives

export const ALTERNATIVE_SCOPES = ["word", "sentence", "paragraph"] as const;
export type AlternativeScope = (typeof ALTERNATIVE_SCOPES)[number];
const MAX_ALTERNATIVES = 5;
const MAX_ALTERNATIVE_LENGTH: Record<AlternativeScope, number> = {
	word: 60,
	sentence: 800,
	paragraph: 6_000,
};

const ALTERNATIVES_PROMPT = `You suggest other wordings for one passage of a writer's draft in a Markdown writing app.
The writer compares your wordings in place against their own, so each must fit the surrounding text exactly where the passage stands: same grammatical role, same scope (a word stays a word or short phrase; a sentence stays a sentence; a paragraph stays a paragraph), and the same meaning.
Keep the writer's voice and spelling conventions. Do not invent facts, names or numbers. Do not repeat the passage itself.
Reply with JSON only: {"alternatives":["wording one","wording two"]}, at most five, best first.`;

/** Wordings the writer can compare in place: trimmed, distinct, the right size. */
export function parseAlternatives(
	reply: string,
	passage: string,
	scope: AlternativeScope,
): { alternatives: string[] } {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start)
		throw new Error("The model did not return JSON");
	const listed = (
		JSON.parse(reply.slice(start, end + 1)) as { alternatives?: unknown }
	).alternatives;
	if (!Array.isArray(listed))
		throw new Error("The model's reply had no alternatives");
	const seen = new Set([passage]);
	const alternatives: string[] = [];
	for (const item of listed) {
		if (typeof item !== "string") continue;
		const wording = item.trim();
		if (
			wording.length === 0 ||
			wording.length > MAX_ALTERNATIVE_LENGTH[scope] ||
			(scope !== "paragraph" && wording.includes("\n")) ||
			seen.has(wording)
		)
			continue;
		seen.add(wording);
		alternatives.push(wording);
		if (alternatives.length === MAX_ALTERNATIVES) break;
	}
	return { alternatives };
}

/**
 * Other wordings for the passage at `passageFrom`, which must hold `passage`
 * exactly in the draft the server has, so suggestions are always for the
 * words the writer chose.
 */
export const alternatives = action({
	args: {
		...baseArgs,
		passage: v.string(),
		passageFrom: v.number(),
		scope: v.string(),
	},
	handler: async (
		ctx,
		input,
	): Promise<{ runId: Id<"aiRuns">; alternatives: string[] }> => {
		validateBase(input);
		const scope = input.scope as AlternativeScope;
		if (
			!ALTERNATIVE_SCOPES.includes(scope) ||
			input.passage.trim().length === 0 ||
			input.passage.length > MAX_ALTERNATIVE_LENGTH[scope] ||
			!Number.isSafeInteger(input.passageFrom) ||
			input.passageFrom < 0
		)
			aiError("invalid_argument", "Invalid alternatives request.");
		return await runPass(ctx, input, {
			name: "alternatives",
			identity: {
				scope,
				passage: input.passage,
				passageFrom: String(input.passageFrom),
			},
			maxTokens: scope === "paragraph" ? 4_096 : 1_024,
			check: (source) => {
				const end = input.passageFrom + input.passage.length;
				if (source.slice(input.passageFrom, end) !== input.passage)
					aiError("document_changed", "The passage is no longer where it was.");
			},
			messages: (source) => {
				const end = input.passageFrom + input.passage.length;
				return [
					{ role: "system", content: ALTERNATIVES_PROMPT },
					{
						role: "user",
						content: `Draft, with the passage between ⟦ and ⟧:\n${source.slice(0, input.passageFrom)}⟦${input.passage}⟧${source.slice(end)}\n\nScope: ${scope}\nPassage: ${input.passage}`,
					},
				];
			},
			parse: (reply) => parseAlternatives(reply, input.passage, scope),
		});
	},
});

// MARK: - Review passes

export const REVIEW_PASSES = ["opening", "clarity", "voice"] as const;
export type ReviewPass = (typeof REVIEW_PASSES)[number];

export type LabFinding = {
	from: number;
	to: number;
	reason: string;
	/** A restrained rewrite of just this passage, when one exists without new facts. */
	suggestion?: string;
};

export type ReviewResult = {
	assessment: string;
	findings: LabFinding[];
	/** Candidate openings, each a replacement for `opening`. */
	openings: string[];
	opening?: { from: number; to: number };
	dropped: number;
};

const MAX_FINDINGS = 8;
const MAX_SUGGESTION_LENGTH = 2_000;

const REVIEW_SHARED = `You are an editor reviewing a writer's draft in a Markdown writing app. The writer decides; you point and explain.
Keep facts, quotations, citations, names, numbers, personal experience and the writer's voice, including useful roughness and British spelling where the draft uses it. Never invent material. When a fix needs something only the writer knows, say so as a question in the reason and leave the suggestion out.
Quote passages exactly as they appear in the draft. Read patterns in context; a pattern is a hypothesis, not a rule. Stop when the useful points are made; at most eight findings.`;

const REVIEW_PROMPTS: Record<ReviewPass, string> = {
	opening: `${REVIEW_SHARED}
Assess the opening (the first paragraph after any title) against the whole draft: does it say what the piece is about, earn the reader's attention and promise what follows delivers? Write the assessment in two to four plain sentences.
Propose up to three alternative openings, each a full replacement for that first paragraph, built only from material already in the draft. If the draft lacks what a better opening needs, ask for it in the assessment instead of inventing it.
Reply with JSON only: {"assessment":"…","openings":["…"],"findings":[{"text":"exact passage","before":"up to six words before it","reason":"the concrete problem","suggestion":"optional restrained rewrite of just this passage"}]}`,
	clarity: `${REVIEW_SHARED}
Find passages a careful reader would stumble over: ambiguous references, convoluted or overloaded sentences, missing steps in an argument, undefined terms. For each, name the concrete difficulty in the reason, and suggest a restrained rewrite of just that passage that keeps its meaning, unless fixing it needs information only the writer has.
Reply with JSON only: {"assessment":"one or two sentences on the draft's clarity overall","findings":[{"text":"exact passage","before":"up to six words before it","reason":"…","suggestion":"…"}]}`,
	voice: `${REVIEW_SHARED}
Find words and phrasing that do not fit the draft's own voice: sudden formality or jargon, clichés, hedges and filler, phrasing that sounds generated rather than written. Judge against how the rest of the draft sounds, not a style guide. For each, give a restrained alternative for just that passage in the writer's register.
Reply with JSON only: {"assessment":"one or two sentences on the draft's voice overall","findings":[{"text":"exact passage","before":"up to six words before it","reason":"…","suggestion":"…"}]}`,
};

/** The first paragraph after frontmatter and title headings: what an opening replaces. */
export function openingRange(
	source: string,
): { from: number; to: number } | undefined {
	let index = source.startsWith("---\n") ? source.indexOf("\n---", 4) + 4 : 0;
	const lines = source.slice(index).split("\n");
	for (const line of lines) {
		if (line.trim().length === 0 || /^#{1,6}\s/.test(line)) {
			index += line.length + 1;
			continue;
		}
		const end = source.indexOf("\n\n", index);
		const to = end === -1 ? source.length : end;
		return { from: index, to: source.slice(0, to).trimEnd().length };
	}
	return undefined;
}

export function parseReview(
	reply: string,
	source: string,
	pass: ReviewPass,
): ReviewResult {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start)
		throw new Error("The model did not return JSON");
	const parsed = JSON.parse(reply.slice(start, end + 1)) as {
		assessment?: unknown;
		findings?: unknown;
		openings?: unknown;
	};
	const proposed = Array.isArray(parsed.findings)
		? parsed.findings.filter(
				(item): item is ProposedCut & { suggestion?: unknown } =>
					typeof item === "object" && item !== null,
			)
		: [];
	const located = locateCuts(source, proposed.slice(0, MAX_FINDINGS));
	const findings: LabFinding[] = located.cuts.map((cut) => {
		const item = proposed.find(
			(candidate) =>
				typeof candidate.text === "string" &&
				source.slice(cut.from, cut.to) === candidate.text,
		);
		const suggestion =
			typeof item?.suggestion === "string" ? item.suggestion.trim() : "";
		return suggestion.length > 0 &&
			suggestion.length <= MAX_SUGGESTION_LENGTH &&
			suggestion !== source.slice(cut.from, cut.to)
			? { ...cut, suggestion }
			: cut;
	});
	const opening = pass === "opening" ? openingRange(source) : undefined;
	const openings =
		opening && Array.isArray(parsed.openings)
			? parseAlternatives(
					JSON.stringify({ alternatives: parsed.openings.slice(0, 3) }),
					source.slice(opening.from, opening.to),
					"paragraph",
				).alternatives
			: [];
	return {
		assessment:
			typeof parsed.assessment === "string"
				? parsed.assessment.trim().slice(0, 2_000)
				: "",
		findings,
		openings,
		...(opening ? { opening } : {}),
		dropped: located.dropped + Math.max(0, proposed.length - MAX_FINDINGS),
	};
}

/**
 * The Lab's editorial passes: an assessment and exact findings, each with an
 * optional restrained rewrite the writer compares as an alternative. Nothing
 * here edits the draft.
 */
export const review = action({
	args: { ...baseArgs, pass: v.string() },
	handler: async (
		ctx,
		input,
	): Promise<{ runId: Id<"aiRuns"> } & ReviewResult> => {
		validateBase(input);
		const pass = input.pass as ReviewPass;
		if (!REVIEW_PASSES.includes(pass))
			aiError("invalid_argument", "Invalid Lab review.");
		return await runPass(ctx, input, {
			name: pass,
			identity: {},
			maxTokens: MAX_LAB_TOKENS,
			messages: (source) => [
				{ role: "system", content: REVIEW_PROMPTS[pass] },
				{ role: "user", content: `Draft:\n${source}` },
			],
			parse: (reply, source) => parseReview(reply, source, pass),
		});
	},
});
