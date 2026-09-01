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
	applicable?: boolean;
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
	if (run.status === "succeeded" && run.applicable === false) {
		return { status: "retry-safe" };
	}
	if (run.status !== "succeeded" || run.applicable !== true || !run.output) {
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

export function canStartAiReview(
	recoveryReady: boolean,
	unresolvedRequestId: string | null,
): boolean {
	return recoveryReady && unresolvedRequestId === null;
}

type UnresolvedReview = {
	requestId: string;
	documentId: string;
};

export function reviewRequestMatchesDocument(
	unresolved: UnresolvedReview,
	documentId: string | null,
): boolean {
	return unresolved.documentId === documentId;
}

export function useAiReview(args: {
	documentId: Id<"documents"> | null;
	getDocMarkdown: () => string;
	getSourceNodeId: () => string | null;
}) {
	const { documentId, getDocMarkdown, getSourceNodeId } = args;
	const runReview = useAction(api.ai.review.run);
	const convex = useConvex();
	const cancelRun = useMutation(api.ai.runs.cancel);
	const acknowledgeRun = useMutation(api.ai.runs.acknowledge);
	const ownerRef = useRef(new AiRequestOwner());
	const unresolvedRequestRef = useRef<UnresolvedReview | null>(null);
	const documentRef = useRef(documentId);
	const previousDocumentRef = useRef(documentId);
	const recoveryReadyRef = useRef(false);
	documentRef.current = documentId;
	const [state, setState] = useState<AiReviewState>("idle");
	const [summary, setSummary] = useState<AiReviewSummary | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (previousDocumentRef.current === documentId) return;
		previousDocumentRef.current = documentId;
		ownerRef.current.supersede();
		unresolvedRequestRef.current = null;
		setState("idle");
		setSummary(null);
		setError(null);
	}, [documentId]);

	useEffect(
		() => () => {
			ownerRef.current.supersede();
		},
		[],
	);

	useEffect(() => {
		let current = true;
		recoveryReadyRef.current = documentId === null;
		if (!documentId) return;
		setState("loading");
		void convex
			.query(api.ai.runs.latestRecoverable, { documentId, kind: "review" })
			.then((run) => {
				if (!current || documentRef.current !== documentId) return;
				if (run) {
					unresolvedRequestRef.current = {
						requestId: run.requestId,
						documentId,
					};
					setState("outcome-unknown");
					setError(UNKNOWN_REVIEW);
				} else if (!unresolvedRequestRef.current) {
					setState("idle");
					setError(null);
				}
			})
			.catch(() => {
				if (current) {
					setState("outcome-unknown");
					setError(UNKNOWN_REVIEW);
				}
			})
			.finally(() => {
				if (current) recoveryReadyRef.current = true;
			});
		return () => {
			current = false;
		};
	}, [convex, documentId]);

	const reset = useCallback(() => {
		if (
			!canStartAiReview(
				recoveryReadyRef.current,
				unresolvedRequestRef.current?.requestId ?? null,
			)
		) {
			setState("outcome-unknown");
			setError(UNKNOWN_REVIEW);
			return;
		}
		const requestId = ownerRef.current.currentRequestId();
		const phase = ownerRef.current.supersede();
		if (phase === "sent" && requestId && documentId) {
			unresolvedRequestRef.current = { requestId, documentId };
		}
		setState(phase === "sent" ? "outcome-unknown" : "idle");
		setSummary(null);
		setError(phase === "sent" ? UNKNOWN_REVIEW : null);
	}, [documentId]);

	const run = useCallback(async () => {
		if (
			!canStartAiReview(
				recoveryReadyRef.current,
				unresolvedRequestRef.current?.requestId ?? null,
			)
		) {
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
			const acknowledged = await acknowledgeRun({
				requestId: ticket.requestId,
			});
			if (!ownerRef.current.isCurrent(ticket, documentRef.current)) return;
			if (!acknowledged.acknowledged) {
				throw new Error("The completed review could not be reconciled.");
			}
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
				try {
					const acknowledged = await acknowledgeRun({
						requestId: ticket.requestId,
					});
					if (!acknowledged.acknowledged) throw new Error("not acknowledged");
				} catch {
					unresolvedRequestRef.current = {
						requestId: ticket.requestId,
						documentId,
					};
					setState("outcome-unknown");
					setError(UNKNOWN_REVIEW);
					return;
				}
				unresolvedRequestRef.current = null;
				setSummary(resolution.summary);
				setState("done");
				setError(null);
				return;
			}
			const outcomeUnknown = resolution.status === "unresolved";
			unresolvedRequestRef.current = outcomeUnknown
				? { requestId: ticket.requestId, documentId }
				: null;
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
		acknowledgeRun,
		cancelRun,
		convex,
		documentId,
		getDocMarkdown,
		getSourceNodeId,
		runReview,
	]);

	const reconcile = useCallback(async () => {
		const unresolved = unresolvedRequestRef.current;
		if (
			!unresolved ||
			!reviewRequestMatchesDocument(unresolved, documentRef.current)
		)
			return;
		const { requestId } = unresolved;
		setState("loading");
		setError(null);
		try {
			let remoteRun = await convex.query(api.ai.runs.get, { requestId });
			if (!reviewRequestMatchesDocument(unresolved, documentRef.current))
				return;
			let resolution = resolveReviewRun(remoteRun);
			if (remoteRun?.status === "reserved") {
				const cancelled = await cancelRun({ requestId });
				if (!reviewRequestMatchesDocument(unresolved, documentRef.current))
					return;
				if (cancelled.cancelled) resolution = { status: "retry-safe" };
				else if (cancelled.reason === "terminal") {
					remoteRun = await convex.query(api.ai.runs.get, { requestId });
					if (!reviewRequestMatchesDocument(unresolved, documentRef.current))
						return;
					resolution = resolveReviewRun(remoteRun);
				}
			}
			if (resolution.status === "succeeded") {
				const acknowledged = await acknowledgeRun({ requestId });
				if (!reviewRequestMatchesDocument(unresolved, documentRef.current))
					return;
				if (!acknowledged.acknowledged) throw new Error("not acknowledged");
				unresolvedRequestRef.current = null;
				setSummary(resolution.summary);
				setState("done");
				return;
			}
			if (resolution.status === "retry-safe") {
				const acknowledged = await acknowledgeRun({ requestId });
				if (!reviewRequestMatchesDocument(unresolved, documentRef.current))
					return;
				if (!acknowledged.acknowledged) throw new Error("not acknowledged");
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
	}, [acknowledgeRun, cancelRun, convex]);

	return { state, summary, error, run, reset, reconcile };
}
