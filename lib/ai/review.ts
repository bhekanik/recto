/**
 * Pure builders + tool schemas + arg validators for the AI review pass
 * (plan 011). The model acts like a human reviewer: instead of returning one
 * structured JSON blob, it CALLS TOOLS — `create_comment` and `suggest_edit` —
 * naming the EXACT text each comment/edit attaches to. The server runs a
 * tool-calling loop (see lib/ai/review-loop.ts) that collects every well-formed
 * tool call into the SAME `{ comments, suggestions }` result the route has always
 * returned, so the client (lib/ai/use-ai-review.ts) and plan 010's
 * anchor/branch primitives are unchanged.
 *
 * Tool-call arguments are validated with the same field rules the legacy parser
 * used (`parseComment`/`parseSuggestion`): required `quote` + `body`/
 * `replacement` must be non-empty strings, optional fields kept only if string,
 * malformed calls dropped, never throw.
 *
 * `parseReview` (the legacy single-blob parser) is KEPT as a fallback: if the
 * model ever returns plain content with no tool calls, the loop parses that
 * content with `parseReview` so we degrade gracefully instead of returning empty.
 */

import type OpenAI from "openai";
import { type CommentAnchor, locateAnchor } from "@/lib/review/anchor";
import { AI_CHAT_MODEL } from "./config";
import type { ChatMessage } from "./transform-request";

/** Wire shape the review route accepts from the client. */
export type ReviewRequestBody = {
	/** The section or whole-document Markdown to review. */
	text: string;
};

/** One AI comment: a verbatim quote it attaches to plus the comment body. */
export type AiReviewComment = {
	/** EXACT verbatim substring of the provided text the comment attaches to. */
	quote: string;
	/** Up to ~40 chars immediately BEFORE the quote (disambiguates repeats). */
	prefix?: string;
	/** Up to ~40 chars immediately AFTER the quote. */
	suffix?: string;
	/** Short label e.g. Clarity, Pacing, Structure, Tone, Argument. */
	category?: string;
	/** The comment text. */
	body: string;
};

/** One AI tracked-change suggestion (Phase B applies these; Phase A ignores). */
export type AiReviewSuggestion = {
	/** EXACT verbatim substring of the provided text to replace. */
	quote: string;
	prefix?: string;
	suffix?: string;
	/** The proposed replacement text. */
	replacement: string;
	/** Why this edit. */
	rationale?: string;
};

export type AiReviewResult = {
	comments: AiReviewComment[];
	suggestions: AiReviewSuggestion[];
};

/**
 * Prettify a model id's last path segment into a short display label.
 * `"z-ai/glm-5.2"` → `"GLM 5.2"`: take the segment after the last `/`, replace
 * `-`/`_` with spaces, and upper-case any all-letter token (so `glm` → `GLM`)
 * while leaving version numbers (`5.2`) alone.
 */
export function modelLabel(model: string): string {
	const last = model.split("/").pop() ?? model;
	return last
		.replace(/[-_]+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean)
		.map((token) => (/^[a-z]+$/i.test(token) ? token.toUpperCase() : token))
		.join(" ");
}

/**
 * Stable synthetic attribution for AI-authored review feedback. The `addComment`
 * mutation honors this owner-only `author` override so AI comments are attributed
 * to a synthetic reviewer while the authenticated caller stays the owner.
 */
export const AI_REVIEWER_AUTHOR_ID = "ai-reviewer";
/** e.g. "AI · GLM 5.2" — derived from the configured chat model. */
export const AI_REVIEWER_AUTHOR_NAME = `AI · ${modelLabel(AI_CHAT_MODEL)}`;

/** Branch origin tag for the AI suggestion branch (Phase B). */
export function aiReviewOrigin(): string {
	return `ai:review:${AI_CHAT_MODEL}`;
}

const REVIEW_SYSTEM = [
	"You are a sharp, kind developmental editor reviewing a draft like a human",
	"reviewer would — pointing at the exact words, not vague impressions.",
	"",
	"Leave your feedback by CALLING TOOLS, not by writing prose:",
	"- Call `create_comment` to leave a comment on a span — what is weak, unclear,",
	"  or dragging, and why.",
	"- Call `suggest_edit` to propose a concrete replacement for a span.",
	"You may call these tools as many times as you need, across multiple turns.",
	"Make one tool call per distinct piece of feedback.",
	"",
	"RULES for the load-bearing `quote` argument (read carefully):",
	"- `quote` MUST be an EXACT, VERBATIM substring copied character-for-character",
	"  from the text provided below. Do NOT paraphrase, normalize, summarize, fix",
	"  typos, add or strip Markdown, or use an ellipsis. If `quote` is not an exact",
	"  substring of the provided text, it WILL be discarded.",
	"- Keep each `quote` reasonably short — a sentence or phrase, not paragraphs.",
	"- Include `prefix`/`suffix` (up to ~40 characters of the text immediately",
	"  before/after the quote, also copied verbatim) when the quote is short or",
	"  might appear more than once, so the feedback anchors to the right occurrence.",
	"",
	"`body` (for comments) and `replacement` (for edits) are required. `category`/",
	"`rationale` are optional. When you have left all your feedback, reply with a",
	"brief plain-text summary and STOP calling tools. If the draft needs no changes,",
	"call no tools and say so.",
].join("\n");

/** Build the review chat messages from a section/document. */
export function buildReviewMessages(body: ReviewRequestBody): ChatMessage[] {
	return [
		{ role: "system", content: REVIEW_SYSTEM },
		{ role: "user", content: body.text },
	];
}

/** Tool names the model calls; also used to route tool-call args in the loop. */
export const CREATE_COMMENT_TOOL = "create_comment";
export const SUGGEST_EDIT_TOOL = "suggest_edit";

/** Shared JSON-schema fragment for the verbatim anchor fields. */
const ANCHOR_PROPERTIES = {
	quote: {
		type: "string",
		description:
			"EXACT verbatim substring of the provided text this attaches to, copied character-for-character.",
	},
	prefix: {
		type: "string",
		description:
			"Up to ~40 characters of the text immediately BEFORE the quote (verbatim); disambiguates repeated quotes.",
	},
	suffix: {
		type: "string",
		description:
			"Up to ~40 characters of the text immediately AFTER the quote (verbatim).",
	},
} as const;

/**
 * The two tools exposed to the model, in OpenAI/OpenRouter `tools` format. Their
 * argument fields mirror {@link AiReviewComment} / {@link AiReviewSuggestion}
 * exactly so the collected tool calls map straight onto the existing
 * `{ comments, suggestions }` result with no extra reshaping.
 */
export const REVIEW_TOOLS: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] =
	[
		{
			type: "function",
			function: {
				name: CREATE_COMMENT_TOOL,
				description:
					"Leave a comment anchored to a verbatim span of the draft (does not change the text).",
				parameters: {
					type: "object",
					properties: {
						...ANCHOR_PROPERTIES,
						category: {
							type: "string",
							description:
								"Short label, e.g. Clarity, Pacing, Structure, Tone, Argument.",
						},
						body: { type: "string", description: "The comment text." },
					},
					required: ["quote", "body"],
					additionalProperties: false,
				},
			},
		},
		{
			type: "function",
			function: {
				name: SUGGEST_EDIT_TOOL,
				description:
					"Propose replacing a verbatim span of the draft with new text (a tracked-change suggestion).",
				parameters: {
					type: "object",
					properties: {
						...ANCHOR_PROPERTIES,
						replacement: {
							type: "string",
							description: "The proposed replacement text for the quoted span.",
						},
						rationale: {
							type: "string",
							description: "Why this edit improves the draft.",
						},
					},
					required: ["quote", "replacement"],
					additionalProperties: false,
				},
			},
		},
	];

/** A non-empty string, or undefined if the value isn't a usable string. */
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate a parsed object as a comment; null if a required field is bad. */
export function parseComment(item: unknown): AiReviewComment | null {
	if (!item || typeof item !== "object") return null;
	const quote = (item as { quote?: unknown }).quote;
	const body = (item as { body?: unknown }).body;
	if (typeof quote !== "string" || quote.length === 0) return null;
	if (typeof body !== "string" || body.length === 0) return null;
	const comment: AiReviewComment = { quote, body };
	const prefix = optionalString((item as { prefix?: unknown }).prefix);
	const suffix = optionalString((item as { suffix?: unknown }).suffix);
	const category = optionalString((item as { category?: unknown }).category);
	if (prefix !== undefined) comment.prefix = prefix;
	if (suffix !== undefined) comment.suffix = suffix;
	if (category !== undefined) comment.category = category;
	return comment;
}

/** Validate a parsed object as a suggestion; null if a required field is bad. */
export function parseSuggestion(item: unknown): AiReviewSuggestion | null {
	if (!item || typeof item !== "object") return null;
	const quote = (item as { quote?: unknown }).quote;
	const replacement = (item as { replacement?: unknown }).replacement;
	if (typeof quote !== "string" || quote.length === 0) return null;
	if (typeof replacement !== "string" || replacement.length === 0) return null;
	const suggestion: AiReviewSuggestion = { quote, replacement };
	const prefix = optionalString((item as { prefix?: unknown }).prefix);
	const suffix = optionalString((item as { suffix?: unknown }).suffix);
	const rationale = optionalString((item as { rationale?: unknown }).rationale);
	if (prefix !== undefined) suggestion.prefix = prefix;
	if (suffix !== undefined) suggestion.suffix = suffix;
	if (rationale !== undefined) suggestion.rationale = rationale;
	return suggestion;
}

const EMPTY_RESULT: AiReviewResult = { comments: [], suggestions: [] };

/**
 * Parse a tool call's `arguments` (a JSON string per the OpenAI/OpenRouter wire
 * format) into a plain object, or null if it isn't parseable JSON / isn't an
 * object. Defensive: never throws on malformed model output.
 */
function parseToolArgs(rawArgs: string): Record<string, unknown> | null {
	if (typeof rawArgs !== "string" || rawArgs.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawArgs);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed as Record<string, unknown>;
}

/**
 * Validate a `create_comment` tool call's raw `arguments` string into an
 * {@link AiReviewComment}, or null if malformed (bad JSON, missing/non-string
 * `quote` or `body`). Reuses {@link parseComment}'s field rules.
 */
export function parseCommentArgs(rawArgs: string): AiReviewComment | null {
	const obj = parseToolArgs(rawArgs);
	return obj ? parseComment(obj) : null;
}

/**
 * Validate a `suggest_edit` tool call's raw `arguments` string into an
 * {@link AiReviewSuggestion}, or null if malformed (bad JSON, missing/non-string
 * `quote` or `replacement`). Reuses {@link parseSuggestion}'s field rules.
 */
export function parseSuggestionArgs(
	rawArgs: string,
): AiReviewSuggestion | null {
	const obj = parseToolArgs(rawArgs);
	return obj ? parseSuggestion(obj) : null;
}

/**
 * Parse the model's review reply into `{ comments, suggestions }`, tolerating
 * fenced JSON or stray prose around the object. Returns empty arrays if nothing
 * parseable is found (the panel then shows a "no notes" state rather than
 * throwing). Pure. Modeled on `parseCritique`.
 */
export function parseReview(raw: string): AiReviewResult {
	const text = raw.trim();
	// Strip a ```json … ``` fence if present.
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced?.[1]?.trim() ?? text;
	// Find the first {...} object.
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return { ...EMPTY_RESULT };
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return { ...EMPTY_RESULT };
	}
	if (!parsed || typeof parsed !== "object") return { ...EMPTY_RESULT };

	const rawComments = (parsed as { comments?: unknown }).comments;
	const rawSuggestions = (parsed as { suggestions?: unknown }).suggestions;

	const comments: AiReviewComment[] = [];
	if (Array.isArray(rawComments)) {
		for (const item of rawComments) {
			const comment = parseComment(item);
			if (comment) comments.push(comment);
		}
	}

	const suggestions: AiReviewSuggestion[] = [];
	if (Array.isArray(rawSuggestions)) {
		for (const item of rawSuggestions) {
			const suggestion = parseSuggestion(item);
			if (suggestion) suggestions.push(suggestion);
		}
	}

	return { comments, suggestions };
}

/**
 * Build a {@link CommentAnchor} for an AI comment against the markdown it was
 * generated from. Preferred path: locate the verbatim `quote` in `markdown` and
 * call plan 010's `createAnchor` at that offset so prefix/suffix/offsetHint are
 * computed by 010's own util (canonical shape). Fallback: construct the anchor
 * directly from the AI-supplied fields (used when the quote can't be found in the
 * request markdown — `locateAnchor` then decides whether it's placeable).
 */
export function buildCommentAnchor(
	markdown: string,
	comment: AiReviewComment,
): CommentAnchor {
	const idx = markdown.indexOf(comment.quote);
	if (idx >= 0) {
		// `createAnchor` is imported lazily where the anchor is actually stored; here
		// we only need a locatable anchor, so reuse the AI fields when found inline.
		return {
			quote: comment.quote,
			prefix: comment.prefix ?? markdown.slice(Math.max(0, idx - 32), idx),
			suffix:
				comment.suffix ??
				markdown.slice(
					idx + comment.quote.length,
					idx + comment.quote.length + 32,
				),
			offsetHint: idx,
		};
	}
	return {
		quote: comment.quote,
		prefix: comment.prefix ?? "",
		suffix: comment.suffix ?? "",
		offsetHint: 0,
	};
}

/** A comment whose anchor was located in the live markdown, ready to store. */
export type ResolvedComment = {
	anchor: CommentAnchor;
	comment: AiReviewComment;
};

/**
 * Resolve a batch of AI comments against `markdown` using plan 010's
 * `locateAnchor` — the SAME locator humans' comments use. Comments whose quote
 * can't be located are DROPPED and COUNTED, never mis-anchored (plan 011's
 * load-bearing drop-and-count contract). Pure; testable without Convex.
 */
export function resolveComments(
	markdown: string,
	comments: AiReviewComment[],
): { placed: ResolvedComment[]; dropped: number } {
	const placed: ResolvedComment[] = [];
	let dropped = 0;
	for (const comment of comments) {
		const anchor = buildCommentAnchor(markdown, comment);
		const range = locateAnchor(markdown, anchor);
		if (!range) {
			dropped++;
			continue;
		}
		placed.push({ anchor, comment });
	}
	return { placed, dropped };
}
