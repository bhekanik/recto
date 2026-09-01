"use client";

import { useAction, useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

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
	branchId: string | null;
};

const reviewSummarySchema = z.object({
	commentsPlaced: z.number(),
	commentsTotal: z.number(),
	commentsDropped: z.number(),
	editsPlaced: z.number(),
	editsTotal: z.number(),
	editsDropped: z.number(),
	branchId: z.string().nullable(),
});

type ReviewRun = {
	status:
		| "reserved"
		| "provider_started"
		| "succeeded"
		| "failed"
		| "cancelled"
		| "outcome_unknown";
	output?: string;
} | null;

export type ReviewRunResolution =
	| { status: "unresolved" }
	| { status: "retry-safe" }
	| { status: "succeeded"; summary: AiReviewSummary };

export function resolveReviewRun(run: ReviewRun): ReviewRunResolution {
	if (!run || run.status === "reserved") return { status: "unresolved" };
	if (run.status === "failed" || run.status === "cancelled") {
		return { status: "retry-safe" };
	}
	if (run.status !== "succeeded" || !run.output) {
		return { status: "unresolved" };
	}
	try {
		const parsed = reviewSummarySchema.safeParse(JSON.parse(run.output));
		if (!parsed.success) return { status: "unresolved" };
		return { status: "succeeded", summary: parsed.data };
	} catch {
		return { status: "unresolved" };
	}
}

const UNKNOWN_REVIEW =
	"The review may have reached the provider. Check its status before starting another.";

export function useAiReview(args: {
	documentId: Id<"documents"> | null;
	getDocMarkdown: () => string;
	getSourceNodeId: () => string | null;
}) {
	const { documentId, getDocMarkdown, getSourceNodeId } = args;
	const runReview = useAction(api.ai.review.run);
	const convex = useConvex();
	const cancelRun = useMutation(api.ai.runs.cancel);
	const ownerRef = useRef(new AiRequestOwner());
	const unresolvedRequestRef = useRef<string | null>(null);
	const documentRef = useRef(documentId);
	const previousDocumentRef = useRef(documentId);
	documentRef.current = documentId;
	const [state, setState] = useState<AiReviewState>("idle");
	const [summary, setSummary] = useState<AiReviewSummary | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (previousDocumentRef.current === documentId) return;
		previousDocumentRef.current = documentId;
		const requestId = ownerRef.current.currentRequestId();
		const phase = ownerRef.current.supersede();
		if (phase === "sent") unresolvedRequestRef.current = requestId;
		const unresolved =
			phase === "sent" || unresolvedRequestRef.current !== null;
		setState(unresolved ? "outcome-unknown" : "idle");
		setSummary(null);
		setError(unresolved ? UNKNOWN_REVIEW : null);
	}, [documentId]);

	useEffect(
		() => () => {
			ownerRef.current.supersede();
		},
		[],
	);

	const reset = useCallback(() => {
		if (unresolvedRequestRef.current) {
			setState("outcome-unknown");
			setError(UNKNOWN_REVIEW);
			return;
		}
		const requestId = ownerRef.current.currentRequestId();
		const phase = ownerRef.current.supersede();
		if (phase === "sent") unresolvedRequestRef.current = requestId;
		setState(phase === "sent" ? "outcome-unknown" : "idle");
		setSummary(null);
		setError(phase === "sent" ? UNKNOWN_REVIEW : null);
	}, []);

	const run = useCallback(async () => {
		if (unresolvedRequestRef.current) {
			setState("outcome-unknown");
			setError(UNKNOWN_REVIEW);
			return;
		}
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
			unresolvedRequestRef.current = null;
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
			let resolution: ReviewRunResolution = { status: "retry-safe" };
			if (ticket.phase === "sent") {
				try {
					let remoteRun = await convex.query(api.ai.runs.get, {
						requestId: ticket.requestId,
					});
					if (!ownerRef.current.isCurrent(ticket, documentRef.current)) return;
					resolution = resolveReviewRun(remoteRun);
					if (remoteRun?.status === "reserved") {
						const cancelled = await cancelRun({ requestId: ticket.requestId });
						if (!ownerRef.current.isCurrent(ticket, documentRef.current))
							return;
						if (cancelled.cancelled) resolution = { status: "retry-safe" };
						else if (cancelled.reason === "terminal") {
							remoteRun = await convex.query(api.ai.runs.get, {
								requestId: ticket.requestId,
							});
							resolution = resolveReviewRun(remoteRun);
						}
					}
				} catch {
					resolution = { status: "unresolved" };
				}
			}
			ownerRef.current.finish(ticket);
			if (resolution.status === "succeeded") {
				unresolvedRequestRef.current = null;
				setSummary(resolution.summary);
				setState("done");
				setError(null);
				return;
			}
			const outcomeUnknown = resolution.status === "unresolved";
			unresolvedRequestRef.current = outcomeUnknown ? ticket.requestId : null;
			setState(outcomeUnknown ? "outcome-unknown" : "error");
			setError(
				outcomeUnknown
					? UNKNOWN_REVIEW
					: caught instanceof Error
						? caught.message
						: "AI review failed",
			);
		}
	}, [
		cancelRun,
		convex,
		documentId,
		getDocMarkdown,
		getSourceNodeId,
		runReview,
	]);

	const reconcile = useCallback(async () => {
		const requestId = unresolvedRequestRef.current;
		if (!requestId) return;
		setState("loading");
		setError(null);
		try {
			let remoteRun = await convex.query(api.ai.runs.get, { requestId });
			let resolution = resolveReviewRun(remoteRun);
			if (remoteRun?.status === "reserved") {
				const cancelled = await cancelRun({ requestId });
				if (cancelled.cancelled) resolution = { status: "retry-safe" };
				else if (cancelled.reason === "terminal") {
					remoteRun = await convex.query(api.ai.runs.get, { requestId });
					resolution = resolveReviewRun(remoteRun);
				}
			}
			if (resolution.status === "succeeded") {
				unresolvedRequestRef.current = null;
				setSummary(resolution.summary);
				setState("done");
				return;
			}
			if (resolution.status === "retry-safe") {
				unresolvedRequestRef.current = null;
				setState("error");
				setError(
					"The earlier review stopped before completion. You can run it again.",
				);
				return;
			}
		} catch {
			// Keep the unresolved request locked until its server state is known.
		}
		setState("outcome-unknown");
		setError(UNKNOWN_REVIEW);
	}, [cancelRun, convex]);

	return { state, summary, error, run, reset, reconcile };
}
