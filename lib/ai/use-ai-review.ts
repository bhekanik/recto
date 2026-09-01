"use client";

import { useAction, useConvex } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AiRequestOwner, sha256Text } from "./request-owner";

export type AiReviewState =
	| "idle"
	| "loading"
	| "done"
	| "outcome-unknown"
	| "error";

export type AiReviewSummary = {
	commentsPlaced: number;
	commentsTotal: number;
	commentsDropped: number;
	editsPlaced: number;
	editsTotal: number;
	editsDropped: number;
	branchId: Id<"reviewBranches"> | null;
};

export function useAiReview(args: {
	documentId: Id<"documents"> | null;
	getDocMarkdown: () => string;
	getSourceNodeId: () => string | null;
}) {
	const { documentId, getDocMarkdown, getSourceNodeId } = args;
	const runReview = useAction(api.ai.review.run);
	const convex = useConvex();
	const ownerRef = useRef(new AiRequestOwner());
	const documentRef = useRef(documentId);
	const previousDocumentRef = useRef(documentId);
	documentRef.current = documentId;
	const [state, setState] = useState<AiReviewState>("idle");
	const [summary, setSummary] = useState<AiReviewSummary | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (previousDocumentRef.current === documentId) return;
		previousDocumentRef.current = documentId;
		const phase = ownerRef.current.supersede();
		setState(phase === "sent" ? "outcome-unknown" : "idle");
		setSummary(null);
		setError(
			phase === "sent"
				? "The provider may have processed this review. Check the review panel before starting another."
				: null,
		);
	}, [documentId]);

	useEffect(
		() => () => {
			ownerRef.current.supersede();
		},
		[],
	);

	const reset = useCallback(() => {
		const phase = ownerRef.current.supersede();
		setState(phase === "sent" ? "outcome-unknown" : "idle");
		setSummary(null);
		setError(
			phase === "sent"
				? "The provider may have processed this review. Check the review panel before starting another."
				: null,
		);
	}, []);

	const run = useCallback(async () => {
		if (!documentId) {
			setState("error");
			setError("No active document");
			return;
		}
		const ticket = ownerRef.current.begin(documentId);
		const text = getDocMarkdown();
		const sourceNodeId = getSourceNodeId();
		if (!text.trim() || !sourceNodeId) {
			ownerRef.current.finish(ticket);
			setState("error");
			setError(
				text.trim()
					? "No active document"
					: "Nothing to review. The document is empty.",
			);
			return;
		}
		setState("loading");
		setSummary(null);
		setError(null);
		try {
			const sourceHash = await sha256Text(text);
			if (!ownerRef.current.isCurrent(ticket, documentRef.current)) return;
			if (!ownerRef.current.markSent(ticket)) return;
			const result = await runReview({
				requestId: ticket.requestId,
				documentId,
				sourceNodeId,
				sourceHash,
				text,
				platform: "web",
				traceContent: true,
			});
			if (!ownerRef.current.isCurrent(ticket, documentRef.current)) return;
			ownerRef.current.finish(ticket);
			setSummary(result);
			setState("done");
		} catch (caught) {
			if (!ownerRef.current.isCurrent(ticket, documentRef.current)) return;
			let outcomeUnknown = ticket.phase === "sent";
			if (outcomeUnknown) {
				try {
					const run = await convex.query(api.ai.runs.get, {
						requestId: ticket.requestId,
					});
					if (!ownerRef.current.isCurrent(ticket, documentRef.current)) return;
					outcomeUnknown =
						run?.status === "provider_started" ||
						run?.status === "outcome_unknown" ||
						run?.status === "succeeded";
				} catch {
					// If status cannot be read, the provider boundary remains unknown.
				}
			}
			ownerRef.current.finish(ticket);
			setState(outcomeUnknown ? "outcome-unknown" : "error");
			setError(
				outcomeUnknown
					? "The provider may have processed this review. Check the review panel before starting another."
					: caught instanceof Error
						? caught.message
						: "AI review failed",
			);
		}
	}, [convex, documentId, getDocMarkdown, getSourceNodeId, runReview]);

	return { state, summary, error, run, reset };
}
