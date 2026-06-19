"use client";

import { useMutation } from "convex/react";
import { useCallback, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	type CommentAnchor,
	createAnchor,
	locateAnchor,
} from "@/lib/review/anchor";
import {
	AI_REVIEWER_AUTHOR_ID,
	AI_REVIEWER_AUTHOR_NAME,
	type AiReviewResult,
	type AiReviewSuggestion,
	parseReview,
} from "./review";
import { applyEdits } from "./review-apply";

export type AiReviewState = "idle" | "loading" | "done" | "error";

export type AiReviewSummary = {
	commentsPlaced: number;
	commentsTotal: number;
	commentsDropped: number;
	editsPlaced: number;
	editsTotal: number;
	editsDropped: number;
	branchId: Id<"reviewBranches"> | null;
};

/** The AI fields shared by comments and suggestions that drive anchoring. */
type AnchoredItem = { quote: string; prefix?: string; suffix?: string };

/**
 * Build a canonical {@link CommentAnchor} for an AI comment/suggestion against the
 * CURRENT live markdown. Preferred: locate the verbatim `quote` and call plan
 * 010's `createAnchor` at that offset so prefix/suffix/offsetHint are computed by
 * 010's own util (keeps the stored anchor shape identical to a human comment's).
 * Fallback: construct the anchor directly from the AI fields when the quote isn't
 * found inline (`locateAnchor` then decides whether it's placeable / drops it).
 */
function anchorForItem(markdown: string, item: AnchoredItem): CommentAnchor {
	const idx = markdown.indexOf(item.quote);
	if (idx >= 0) {
		return createAnchor(markdown, idx, idx + item.quote.length);
	}
	return {
		quote: item.quote,
		prefix: item.prefix ?? "",
		suffix: item.suffix ?? "",
		offsetHint: 0,
	};
}

/**
 * Client orchestration for the AI reviewer (plan 011).
 *
 * POSTs the live canonical markdown to /api/ai/review and parses the structured
 * `{ comments, suggestions }`, then:
 *  - COMMENTS (Phase A): for each comment resolves its quote against the CURRENT
 *    live markdown via plan 010's `locateAnchor` and — if located — creates a real
 *    anchored comment through 010's `addComment` mutation, attributed to the
 *    synthetic AI reviewer via the owner-only author override.
 *  - SUGGESTIONS (Phase B): merges the surviving `quote→replacement` edits into the
 *    full markdown via `applyEdits` (pure; drops unlocatable + overlapping edits),
 *    then — if any applied — pushes the merged markdown onto an AI suggestion
 *    BRANCH via `aiSuggestBranch`. The owner reviews that branch's word-level diff
 *    and accepts/rejects it in plan 010's review surface, exactly like a human
 *    reviewer's branch.
 *
 * Unlocatable comments + unlocatable/overlapping edits are DROPPED and COUNTED
 * (never mis-anchored / mis-applied). The authenticated caller stays the document
 * owner; only the *attributed* author/origin is the synthetic AI reviewer. The
 * suggestion path NEVER touches the owner's `documents` row — `aiSuggestBranch` is
 * append-only (isolation invariant) and the owner's live doc only changes on
 * Accept. (This hook never calls `commitProgrammatic` / document autosave.)
 */
export function useAiReview(args: {
	documentId: Id<"documents"> | null;
	getDocMarkdown: () => string;
}) {
	const { documentId, getDocMarkdown } = args;
	const addComment = useMutation(api.review.addComment);
	const aiSuggestBranch = useMutation(api.review.aiSuggestBranch);

	const [state, setState] = useState<AiReviewState>("idle");
	const [summary, setSummary] = useState<AiReviewSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const reset = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setState("idle");
		setSummary(null);
		setError(null);
	}, []);

	const run = useCallback(async () => {
		if (!documentId) {
			setState("error");
			setError("No active document");
			return;
		}
		const text = getDocMarkdown().trim();
		if (!text) {
			setState("error");
			setError("Nothing to review — the document is empty.");
			return;
		}

		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setState("loading");
		setSummary(null);
		setError(null);

		let result: AiReviewResult;
		try {
			const res = await fetch("/api/ai/review", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
				signal: ac.signal,
			});
			if (!res.ok) {
				setState("error");
				setError(
					res.status === 401
						? "Sign in to use AI"
						: `AI request failed (${res.status})`,
				);
				return;
			}
			// The route already parses; re-parse defensively so a malformed payload
			// degrades to empty arrays rather than throwing.
			const raw = (await res.json()) as Partial<AiReviewResult>;
			result = parseReview(JSON.stringify(raw));
		} catch (err) {
			if ((err as Error)?.name === "AbortError") return;
			setState("error");
			setError((err as Error).message || "AI request failed");
			return;
		}
		// NOTE: do NOT clear abortRef here. The write batch below (addComment loop +
		// aiSuggestBranch) is the part that actually mutates Convex, so reset()/a
		// re-run must still be able to abort THIS run mid-write. abortRef is cleared
		// only when the whole run finishes (or is superseded) — see below.

		// If reset()/a newer run() aborted this controller during the fetch, bail
		// before writing anything (idempotency: an aborted run must not write).
		if (ac.signal.aborted) return;

		// Resolve + create each comment against the CURRENT live markdown — it may
		// have shifted since the request was sent.
		const currentMarkdown = getDocMarkdown();
		const comments = result.comments;
		let placed = 0;
		let dropped = 0;
		for (const comment of comments) {
			// Re-check before EACH write: closing+reopening the panel (reset) or a
			// fresh run() supersedes this loop — bail so run #1 and run #2 can't both
			// write and produce duplicate AI comments.
			if (ac.signal.aborted) return;
			const anchor = anchorForItem(currentMarkdown, comment);
			const range = locateAnchor(currentMarkdown, anchor);
			if (!range) {
				dropped++;
				continue;
			}
			const body = comment.category
				? `[${comment.category}] ${comment.body}`
				: comment.body;
			try {
				await addComment({
					documentId,
					anchor,
					body,
					author: {
						authorName: AI_REVIEWER_AUTHOR_NAME,
						authorId: AI_REVIEWER_AUTHOR_ID,
					},
				});
				placed++;
			} catch {
				// A failed write (e.g. an empty body after trim) shouldn't sink the
				// whole batch — count it as dropped and keep going.
				dropped++;
			}
		}

		// Suggestions → AI suggestion branch (Phase B). Merge the surviving
		// `quote→replacement` edits into the full markdown (applyEdits drops
		// unlocatable + overlapping edits), then — if any applied — push the merged
		// markdown onto an AI branch off the owner's current node. This never writes
		// the owner's documents row: aiSuggestBranch is append-only.
		const suggestions = result.suggestions;
		const edits = suggestions.map((s: AiReviewSuggestion) => ({
			anchor: anchorForItem(currentMarkdown, s),
			replacement: s.replacement,
		}));
		const {
			markdown: branchMarkdown,
			applied: editsPlaced,
			dropped: editsDropped,
		} = applyEdits(currentMarkdown, edits);

		let branchId: Id<"reviewBranches"> | null = null;
		if (editsPlaced > 0) {
			// Superseded after the comment loop but before the branch write — bail so a
			// stale run doesn't churn a duplicate suggestion branch.
			if (ac.signal.aborted) return;
			try {
				const res = await aiSuggestBranch({ documentId, branchMarkdown });
				branchId = res.branchId;
			} catch {
				// A failed branch write shouldn't sink the comments that already landed —
				// surface the comment counts and treat the edits as dropped.
			}
		}

		// A run superseded during the final writes must not stomp the newer run's UI.
		if (ac.signal.aborted) return;
		// This run owns the result — release its controller so reset() goes idle.
		if (abortRef.current === ac) abortRef.current = null;

		setSummary({
			commentsPlaced: placed,
			commentsTotal: comments.length,
			commentsDropped: dropped,
			editsPlaced: branchId ? editsPlaced : 0,
			editsTotal: suggestions.length,
			editsDropped: branchId ? editsDropped : editsDropped + editsPlaced,
			branchId,
		});
		setState("done");
	}, [documentId, getDocMarkdown, addComment, aiSuggestBranch]);

	return { state, summary, error, run, reset };
}
