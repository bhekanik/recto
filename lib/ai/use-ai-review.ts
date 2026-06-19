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
	type AiReviewComment,
	type AiReviewResult,
	parseReview,
} from "./review";

export type AiReviewState = "idle" | "loading" | "done" | "error";

export type AiReviewSummary = {
	commentsPlaced: number;
	commentsTotal: number;
	commentsDropped: number;
};

/**
 * Build a canonical {@link CommentAnchor} for an AI comment against the CURRENT
 * live markdown. Preferred: locate the verbatim `quote` and call plan 010's
 * `createAnchor` at that offset so prefix/suffix/offsetHint are computed by 010's
 * own util (keeps the stored anchor shape identical to a human comment's).
 * Fallback: construct the anchor directly from the AI fields when the quote isn't
 * found inline (`locateAnchor` then decides whether it's placeable / drops it).
 */
function anchorForComment(
	markdown: string,
	comment: AiReviewComment,
): CommentAnchor {
	const idx = markdown.indexOf(comment.quote);
	if (idx >= 0) {
		return createAnchor(markdown, idx, idx + comment.quote.length);
	}
	return {
		quote: comment.quote,
		prefix: comment.prefix ?? "",
		suffix: comment.suffix ?? "",
		offsetHint: 0,
	};
}

/**
 * Client orchestration for the AI reviewer (plan 011, Phase A — comments path).
 * POSTs the live canonical markdown to /api/ai/review, parses the structured
 * `{ comments, suggestions }`, then for EACH comment resolves its quote against
 * the CURRENT live markdown via plan 010's `locateAnchor` and — if located —
 * creates a real anchored comment through 010's `addComment` mutation, attributed
 * to the synthetic AI reviewer via the owner-only author override. Unlocatable
 * comments are DROPPED and COUNTED (never mis-anchored). Suggestions are parsed
 * but ignored in Phase A (Phase B builds the AI suggestion branch).
 *
 * The authenticated caller stays the document owner; only the *attributed* author
 * is the synthetic AI reviewer (addComment honors `author` only for the owner).
 */
export function useAiReview(args: {
	documentId: Id<"documents"> | null;
	getDocMarkdown: () => string;
}) {
	const { documentId, getDocMarkdown } = args;
	const addComment = useMutation(api.review.addComment);

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
		} finally {
			if (abortRef.current === ac) abortRef.current = null;
		}

		// Resolve + create each comment against the CURRENT live markdown — it may
		// have shifted since the request was sent.
		const currentMarkdown = getDocMarkdown();
		const comments = result.comments;
		let placed = 0;
		let dropped = 0;
		for (const comment of comments) {
			const anchor = anchorForComment(currentMarkdown, comment);
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

		setSummary({
			commentsPlaced: placed,
			commentsTotal: comments.length,
			commentsDropped: dropped,
		});
		setState("done");
	}, [documentId, getDocMarkdown, addComment]);

	return { state, summary, error, run, reset };
}
