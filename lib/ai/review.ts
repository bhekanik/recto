/**
 * Pure builders + parser for the AI review pass (plan 011, Phase A). The model
 * acts like a human reviewer: it returns structured output naming the EXACT text
 * each comment/edit attaches to, and we anchor + create real comments through
 * plan 010's primitives (see lib/ai/use-ai-review.ts). Kept separate from the
 * legacy critique builder (lib/ai/transform-request.ts) so the new schema/prompt
 * don't bloat that file.
 *
 * The parser tolerance mirrors `parseCritique` exactly: strip a ```json fence,
 * slice the first `{`…last `}`, JSON.parse in a try/catch, validate each item's
 * field types, drop malformed items, never throw.
 */

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
	"You are a sharp, kind developmental editor leaving feedback on a draft like a",
	"human reviewer would — pointing at the exact words, not vague impressions.",
	"",
	"Return ONLY a single JSON object with exactly these two keys:",
	'  "comments": an array of comment items',
	'  "suggestions": an array of edit items',
	"",
	"A comment item is an object:",
	'  { "quote": string, "prefix"?: string, "suffix"?: string,',
	'    "category"?: string, "body": string }',
	"A suggestion item is an object:",
	'  { "quote": string, "prefix"?: string, "suffix"?: string,',
	'    "replacement": string, "rationale"?: string }',
	"",
	"RULES for the load-bearing `quote` field (read carefully):",
	"- `quote` MUST be an EXACT, VERBATIM substring copied character-for-character",
	"  from the text provided below. Do NOT paraphrase, normalize, summarize, fix",
	"  typos, add or strip Markdown, or use an ellipsis. If `quote` is not an exact",
	"  substring of the provided text, it WILL be discarded.",
	"- Keep each `quote` reasonably short — a sentence or phrase, not paragraphs.",
	"- Include `prefix`/`suffix` (up to ~40 characters of the text immediately",
	"  before/after the quote, also copied verbatim) when the quote is short or",
	"  might appear more than once, so the comment anchors to the right occurrence.",
	"",
	"`comments` should point at something specific — what is weak, unclear, or",
	"dragging, and why. `suggestions` propose a concrete `replacement` for the",
	"quoted span. `category`/`rationale` are optional; `body`/`replacement` are",
	"required for their item to count.",
	"",
	"Output ONLY the raw JSON object. No prose, no explanation, no code fence.",
].join("\n");

/** Build the review chat messages from a section/document. */
export function buildReviewMessages(body: ReviewRequestBody): ChatMessage[] {
	return [
		{ role: "system", content: REVIEW_SYSTEM },
		{ role: "user", content: body.text },
	];
}

/** A non-empty string, or undefined if the value isn't a usable string. */
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseComment(item: unknown): AiReviewComment | null {
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

function parseSuggestion(item: unknown): AiReviewSuggestion | null {
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
