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

type RecoverableReviewRun = NonNullable<ReviewRun> & {
	requestId: string;
};

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

type ReviewCancellation =
	| { cancelled: true }
	| {
			cancelled: false;
			reason: "not_found" | "outcome_unknown" | "terminal";
	  };

export type ReviewReconciliationResult =
	| ReviewRunResolution
	| { status: "stale" };

export async function reconcileReviewRun(args: {
	requestId: string;
	query: (requestId: string) => Promise<ReviewRun>;
	recovery?: {
		latest: () => Promise<RecoverableReviewRun | null>;
		adopt: (requestId: string, activeRequestId: string) => boolean;
	};
	cancel: (requestId: string) => Promise<ReviewCancellation>;
	acknowledge: (requestId: string) => Promise<boolean>;
	isCurrent: (requestId: string) => boolean;
}): Promise<ReviewReconciliationResult> {
	let requestId = args.requestId;
	try {
		let remoteRun = await args.query(requestId);
		if (!args.isCurrent(requestId)) return { status: "stale" };
		if (!remoteRun && args.recovery) {
			const activeRun = await args.recovery.latest();
			if (!args.isCurrent(requestId)) return { status: "stale" };
			if (activeRun?.requestId && activeRun.requestId !== requestId) {
				if (!args.recovery.adopt(requestId, activeRun.requestId)) {
					return { status: "stale" };
				}
				requestId = activeRun.requestId;
				if (!args.isCurrent(requestId)) return { status: "stale" };
			}
			remoteRun = activeRun;
		}
		let resolution = resolveReviewRun(remoteRun);
		if (remoteRun?.status === "reserved") {
			const cancelled = await args.cancel(requestId);
			if (!args.isCurrent(requestId)) return { status: "stale" };
			if (cancelled.cancelled) resolution = { status: "retry-safe" };
			else if (cancelled.reason === "terminal") {
				remoteRun = await args.query(requestId);
				if (!args.isCurrent(requestId)) return { status: "stale" };
				resolution = resolveReviewRun(remoteRun);
			}
		}
		if (
			resolution.status !== "retry-safe" &&
			resolution.status !== "succeeded"
		) {
			return resolution;
		}
		const acknowledged = await args.acknowledge(requestId);
		if (!args.isCurrent(requestId)) return { status: "stale" };
		return acknowledged ? resolution : { status: "unresolved" };
	} catch {
		return args.isCurrent(requestId)
			? { status: "unresolved" }
			: { status: "stale" };
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

export type UnresolvedReview = {
	requestId: string;
	documentId: string;
	generation: number;
};

export function reviewRequestMatchesDocument(
	unresolved: UnresolvedReview,
	documentId: string | null,
): boolean {
	return unresolved.documentId === documentId;
}

export function reviewReconciliationIsCurrent(
	captured: UnresolvedReview,
	current: UnresolvedReview | null,
	documentId: string | null,
	generation: number,
): boolean {
	return (
		current === captured &&
		current.requestId === captured.requestId &&
		current.documentId === captured.documentId &&
		current.generation === captured.generation &&
		documentId === captured.documentId &&
		generation === captured.generation
	);
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
	const reviewGenerationRef = useRef(0);
	const reconciliationDocumentRef = useRef<Id<"documents"> | null>(documentId);
	const documentRef = useRef(documentId);
	const previousDocumentRef = useRef(documentId);
	const recoveryReadyRef = useRef(false);
	if (reconciliationDocumentRef.current !== documentId) {
		reconciliationDocumentRef.current = documentId;
		reviewGenerationRef.current += 1;
	}
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
					reviewGenerationRef.current += 1;
					unresolvedRequestRef.current = {
						requestId: run.requestId,
						documentId,
						generation: reviewGenerationRef.current,
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
			reviewGenerationRef.current += 1;
			unresolvedRequestRef.current = {
				requestId,
				documentId,
				generation: reviewGenerationRef.current,
			};
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
		const generation = reviewGenerationRef.current;
		const isCurrent = () =>
			generation === reviewGenerationRef.current &&
			ownerRef.current.isCurrent(ticket, documentRef.current);
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
			if (!isCurrent()) return;
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
			if (!isCurrent()) return;
			const acknowledged = await acknowledgeRun({
				requestId: ticket.requestId,
			});
			if (!isCurrent()) return;
			if (!acknowledged.acknowledged) {
				throw new Error("The completed review could not be reconciled.");
			}
			if (!isCurrent()) return;
			ownerRef.current.finish(ticket);
			setSummary(result);
			setState("done");
		} catch (caught) {
			if (!isCurrent()) return;
			let unresolved: UnresolvedReview | null = null;
			let reconciliationRequestId = ticket.requestId;
			let reconciliationIsCurrent = (_requestId: string) => isCurrent();
			let resolution: ReviewReconciliationResult = { status: "retry-safe" };
			if (ticket.phase === "sent") {
				resolution = await reconcileReviewRun({
					requestId: ticket.requestId,
					query: async (requestId) =>
						await convex.query(api.ai.runs.get, {
							requestId,
						}),
					recovery: {
						latest: async () =>
							await convex.query(api.ai.runs.latestRecoverable, {
								documentId,
								kind: "review",
							}),
						adopt: (requestId, activeRequestId) => {
							if (!reconciliationIsCurrent(requestId)) return false;
							reviewGenerationRef.current += 1;
							unresolved = {
								requestId: activeRequestId,
								documentId,
								generation: reviewGenerationRef.current,
							};
							unresolvedRequestRef.current = unresolved;
							reconciliationRequestId = activeRequestId;
							reconciliationIsCurrent = (candidateRequestId) =>
								unresolved !== null &&
								reviewReconciliationIsCurrent(
									unresolved,
									unresolvedRequestRef.current,
									documentRef.current,
									reviewGenerationRef.current,
								) &&
								unresolved.requestId === candidateRequestId;
							return true;
						},
					},
					cancel: async (requestId) => await cancelRun({ requestId }),
					acknowledge: async (requestId) =>
						(
							await acknowledgeRun({
								requestId,
							})
						).acknowledged,
					isCurrent: (requestId) => reconciliationIsCurrent(requestId),
				});
			}
			if (
				resolution.status === "stale" ||
				!reconciliationIsCurrent(reconciliationRequestId)
			)
				return;
			ownerRef.current.finish(ticket);
			if (resolution.status === "succeeded") {
				unresolvedRequestRef.current = null;
				setSummary(resolution.summary);
				setState("done");
				setError(null);
				return;
			}
			const outcomeUnknown = resolution.status === "unresolved";
			if (outcomeUnknown) {
				if (!unresolved) {
					reviewGenerationRef.current += 1;
					unresolvedRequestRef.current = {
						requestId: ticket.requestId,
						documentId,
						generation: reviewGenerationRef.current,
					};
				}
			} else {
				unresolvedRequestRef.current = null;
			}
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
			!reviewReconciliationIsCurrent(
				unresolved,
				unresolvedRequestRef.current,
				documentRef.current,
				reviewGenerationRef.current,
			)
		)
			return;
		let currentUnresolved = unresolved;
		const isCurrent = (requestId = currentUnresolved.requestId) =>
			reviewReconciliationIsCurrent(
				currentUnresolved,
				unresolvedRequestRef.current,
				documentRef.current,
				reviewGenerationRef.current,
			) && currentUnresolved.requestId === requestId;
		setState("loading");
		setError(null);
		const resolution = await reconcileReviewRun({
			requestId: currentUnresolved.requestId,
			query: async (requestId) =>
				await convex.query(api.ai.runs.get, { requestId }),
			recovery: {
				latest: async () => {
					const currentDocumentId = documentRef.current;
					if (
						!currentDocumentId ||
						currentDocumentId !== currentUnresolved.documentId
					) {
						return null;
					}
					return await convex.query(api.ai.runs.latestRecoverable, {
						documentId: currentDocumentId,
						kind: "review",
					});
				},
				adopt: (requestId, activeRequestId) => {
					if (!isCurrent(requestId)) return false;
					reviewGenerationRef.current += 1;
					currentUnresolved = {
						...currentUnresolved,
						requestId: activeRequestId,
						generation: reviewGenerationRef.current,
					};
					unresolvedRequestRef.current = currentUnresolved;
					return true;
				},
			},
			cancel: async (requestId) => await cancelRun({ requestId }),
			acknowledge: async (requestId) =>
				(await acknowledgeRun({ requestId })).acknowledged,
			isCurrent,
		});
		if (resolution.status === "stale") return;
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
		if (!isCurrent()) return;
		setState("outcome-unknown");
		setError(UNKNOWN_REVIEW);
	}, [acknowledgeRun, cancelRun, convex]);

	return { state, summary, error, run, reset, reconcile };
}
