"use client";

import { useAuth } from "@clerk/nextjs";
import { useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { HistoryController } from "@/lib/history/use-document-history";
import { normalizeMarkdown } from "@/lib/markdown";
import type { AiTransformMode } from "@/lib/studio/use-studio-settings";
import { applyTransform, type TransformRange } from "./apply-transform";
import { requireConvexSiteUrl } from "./convex-http";
import { AiRequestOwner, sha256Text } from "./request-owner";

export type AiTransformStatus =
	| "idle"
	| "streaming"
	| "committed"
	| "outcome-unknown"
	| "error";

export type AiTransformState = {
	status: AiTransformStatus;
	partial: string;
	error: string | null;
	awaitingDecision: boolean;
};

const INITIAL: AiTransformState = {
	status: "idle",
	partial: "",
	error: null,
	awaitingDecision: false,
};

type AiCommitController = Pick<
	HistoryController,
	| "commitProgrammatic"
	| "getHeadNodeId"
	| "hasPendingDraft"
	| "materializeAt"
	| "navigateTo"
>;

export type PendingAiCommit = {
	documentId: string;
	controller: Pick<HistoryController, "commitProgrammatic" | "getHeadNodeId">;
	sourceNodeId: string;
	sourceMarkdown: string;
	aiNodeId: string;
	aiMarkdown: string;
};

export type AiTransformSnapshot = {
	sourceNodeId: string;
	sourceMarkdown: string;
	range: TransformRange;
	selection: string;
	richReplace?: (aiText: string) => string | null;
};

export function snapshotMatchesCurrent(
	snapshot: AiTransformSnapshot,
	controller: Pick<HistoryController, "currentNodeId"> | null,
	markdown: string,
): boolean {
	if (
		!controller ||
		controller.currentNodeId !== snapshot.sourceNodeId ||
		markdown !== snapshot.sourceMarkdown
	) {
		return false;
	}
	return (
		snapshot.richReplace !== undefined ||
		markdown.slice(snapshot.range.from, snapshot.range.to) ===
			snapshot.selection
	);
}

type TransformCommitController = Pick<
	HistoryController,
	"commitProgrammatic" | "flush" | "getHeadNodeId"
>;

type TransformCommitResult =
	| { status: "source-changed" }
	| {
			status: "committed";
			nodeId: string | null;
			sourceNodeId: string;
			aiMarkdown: string;
	  };

function commitTransformAtCurrentSource(args: {
	controller: TransformCommitController;
	getMarkdown: () => string;
	expectedSourceNodeId: string;
	sourceMarkdown: string;
	nextMarkdown: string;
	origin: string;
}): TransformCommitResult {
	if (args.controller.getHeadNodeId() !== args.expectedSourceNodeId) {
		return { status: "source-changed" };
	}
	args.controller.flush();
	const sourceNodeId = args.controller.getHeadNodeId();
	if (!sourceNodeId || args.getMarkdown() !== args.sourceMarkdown) {
		return { status: "source-changed" };
	}
	const aiMarkdown = normalizeMarkdown(args.nextMarkdown);
	const nodeId = args.controller.commitProgrammatic(aiMarkdown, {
		origin: args.origin,
	});
	return {
		status: "committed",
		nodeId,
		sourceNodeId,
		aiMarkdown,
	};
}

export async function commitTransformAfterAcknowledgement(args: {
	acknowledge: () => Promise<boolean>;
	snapshot: AiTransformSnapshot;
	controller: Pick<HistoryController, "currentNodeId"> &
		TransformCommitController;
	getMarkdown: () => string;
	isCurrent: () => boolean;
	nextMarkdown: string;
	origin: string;
}): Promise<TransformCommitResult | { status: "acknowledgement-failed" }> {
	try {
		if (!(await args.acknowledge())) {
			return { status: "acknowledgement-failed" };
		}
	} catch {
		return { status: "acknowledgement-failed" };
	}
	if (
		!args.isCurrent() ||
		!snapshotMatchesCurrent(args.snapshot, args.controller, args.getMarkdown())
	) {
		return { status: "source-changed" };
	}
	return commitTransformAtCurrentSource({
		controller: args.controller,
		getMarkdown: args.getMarkdown,
		expectedSourceNodeId: args.snapshot.sourceNodeId,
		sourceMarkdown: args.snapshot.sourceMarkdown,
		nextMarkdown: args.nextMarkdown,
		origin: args.origin,
	});
}

type TransformRun = {
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

type RecoverableTransformRun = NonNullable<TransformRun> & {
	requestId: string;
};

export type TransformRunResolution =
	| { status: "unresolved" }
	| { status: "retry-safe" }
	| { status: "succeeded"; output: string };

export function resolveTransformRun(run: TransformRun): TransformRunResolution {
	if (!run || run.status === "reserved") return { status: "unresolved" };
	if (run.status === "failed" || run.status === "cancelled") {
		return { status: "retry-safe" };
	}
	if (run.status === "succeeded" && run.applicable === false) {
		return { status: "retry-safe" };
	}
	if (
		run.status === "succeeded" &&
		run.applicable === true &&
		run.output !== undefined
	) {
		return { status: "succeeded", output: run.output };
	}
	return { status: "unresolved" };
}

type TransformCancellation =
	| { cancelled: true }
	| {
			cancelled: false;
			reason: "not_found" | "outcome_unknown" | "terminal";
	  };

export type TransformReconciliationResult =
	| TransformRunResolution
	| { status: "stale" };

export async function reconcileTransformRun(args: {
	requestId: string;
	query: (requestId: string) => Promise<TransformRun>;
	recovery?: {
		latest: () => Promise<RecoverableTransformRun | null>;
		adopt: (requestId: string, activeRequestId: string) => boolean;
	};
	cancel: (requestId: string) => Promise<TransformCancellation>;
	acknowledge: (requestId: string) => Promise<boolean>;
	isCurrent: (requestId: string) => boolean;
}): Promise<TransformReconciliationResult> {
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
		let resolution = resolveTransformRun(remoteRun);
		if (remoteRun?.status === "reserved") {
			const cancelled = await args.cancel(requestId);
			if (!args.isCurrent(requestId)) return { status: "stale" };
			if (cancelled.cancelled) resolution = { status: "retry-safe" };
			else if (cancelled.reason === "terminal") {
				remoteRun = await args.query(requestId);
				if (!args.isCurrent(requestId)) return { status: "stale" };
				resolution = resolveTransformRun(remoteRun);
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

export function canRejectAiCommit(
	pending: PendingAiCommit | null,
	documentId: string | null,
	controller: AiCommitController | null,
	currentMarkdown: string,
): pending is PendingAiCommit {
	return Boolean(
		pending &&
			controller &&
			documentId === pending.documentId &&
			controller.commitProgrammatic === pending.controller.commitProgrammatic &&
			controller.getHeadNodeId() === pending.aiNodeId &&
			controller.materializeAt(pending.sourceNodeId) ===
				pending.sourceMarkdown &&
			!controller.hasPendingDraft() &&
			pending.aiMarkdown === currentMarkdown,
	);
}

export function rejectAiCommit(
	pending: PendingAiCommit | null,
	documentId: string | null,
	controller: AiCommitController | null,
	currentMarkdown: string,
): boolean {
	if (
		!controller ||
		!canRejectAiCommit(pending, documentId, controller, currentMarkdown)
	) {
		return false;
	}
	controller.navigateTo(pending.sourceNodeId);
	return true;
}

function unknownOutcome(partial = ""): AiTransformState {
	return {
		status: "outcome-unknown",
		partial,
		error:
			"The provider may have processed this request. The result was not applied. Check AI usage before deciding whether to start another.",
		awaitingDecision: false,
	};
}

const aiTransformErrorSchema = z.object({
	error: z.string(),
	code: z.string().optional(),
});

export async function readAiTransformError(response: Response): Promise<{
	message: string;
	outcomeUnknown: boolean;
	retrySafe: boolean;
	requestInProgress: boolean;
}> {
	const body = await response
		.json()
		.then((value) => aiTransformErrorSchema.safeParse(value))
		.catch(() => null);
	return {
		message: body?.success
			? body.data.error
			: `AI request failed (${response.status})`,
		outcomeUnknown: Boolean(
			body?.success && body.data.code === "request_outcome_unknown",
		),
		requestInProgress: Boolean(
			body?.success && body.data.code === "request_in_progress",
		),
		retrySafe: Boolean(
			body?.success &&
				body.data.code &&
				body.data.code !== "request_outcome_unknown" &&
				body.data.code !== "request_in_progress",
		),
	};
}

export type UnresolvedTransform = {
	requestId: string;
	documentId: Id<"documents">;
	generation: number;
	snapshot?: AiTransformSnapshot;
	controller?: HistoryController;
	instructionLabel?: string;
	partial: string;
};

export function transformReconciliationIsCurrent(
	captured: UnresolvedTransform,
	current: UnresolvedTransform | null,
	documentId: Id<"documents"> | null,
	generation: number,
): boolean {
	return (
		current === captured &&
		current.generation === captured.generation &&
		generation === captured.generation &&
		current.requestId === captured.requestId &&
		current.documentId === captured.documentId &&
		documentId === captured.documentId
	);
}

export function useAiTransform(args: {
	documentId: Id<"documents"> | null;
	getController: () => HistoryController | null;
	getDocMarkdown: () => string;
	mode: AiTransformMode;
}) {
	const { documentId, getController, getDocMarkdown, mode } = args;
	const { getToken } = useAuth();
	const convex = useConvex();
	const cancelRun = useMutation(api.ai.runs.cancel);
	const acknowledgeRun = useMutation(api.ai.runs.acknowledge);
	const [state, setState] = useState<AiTransformState>(INITIAL);
	const ownerRef = useRef(new AiRequestOwner());
	const documentIdRef = useRef<Id<"documents"> | null>(documentId);
	const previousDocumentRef = useRef<Id<"documents"> | null>(documentId);
	const pendingCommitRef = useRef<PendingAiCommit | null>(null);
	const unresolvedRef = useRef<UnresolvedTransform | null>(null);
	const unresolvedGenerationRef = useRef(0);
	const reconciliationDocumentRef = useRef<Id<"documents"> | null>(documentId);
	const recoveryReadyRef = useRef(false);
	if (reconciliationDocumentRef.current !== documentId) {
		reconciliationDocumentRef.current = documentId;
		unresolvedGenerationRef.current += 1;
	}
	documentIdRef.current = documentId;

	useEffect(
		() => () => {
			ownerRef.current.supersede();
		},
		[],
	);

	useEffect(() => {
		if (previousDocumentRef.current === documentId) return;
		previousDocumentRef.current = documentId;
		const phase = ownerRef.current.supersede();
		const unresolved = unresolvedRef.current;
		unresolvedRef.current = null;
		pendingCommitRef.current = null;
		setState(
			phase === "sent" || unresolved
				? unknownOutcome(unresolved?.partial)
				: INITIAL,
		);
	}, [documentId]);

	useEffect(() => {
		let current = true;
		recoveryReadyRef.current = documentId === null;
		if (!documentId) return;
		setState((value) => (value.status === "idle" ? unknownOutcome() : value));
		void convex
			.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			})
			.then((run) => {
				if (!current || documentIdRef.current !== documentId) return;
				if (run) {
					unresolvedGenerationRef.current += 1;
					unresolvedRef.current = {
						requestId: run.requestId,
						documentId,
						generation: unresolvedGenerationRef.current,
						partial: "",
					};
					setState(unknownOutcome());
				} else if (!unresolvedRef.current) {
					setState(INITIAL);
				}
			})
			.catch(() => {
				if (current) setState(unknownOutcome());
			})
			.finally(() => {
				if (current) recoveryReadyRef.current = true;
			});
		return () => {
			current = false;
		};
	}, [convex, documentId]);

	const reset = useCallback(() => {
		const phase = ownerRef.current.supersede();
		pendingCommitRef.current = null;
		setState(
			phase === "sent" || unresolvedRef.current
				? unknownOutcome(unresolvedRef.current?.partial)
				: INITIAL,
		);
	}, []);

	const cancel = useCallback(() => {
		const phase = ownerRef.current.supersede();
		pendingCommitRef.current = null;
		setState(
			phase === "sent" || unresolvedRef.current
				? unknownOutcome(unresolvedRef.current?.partial)
				: INITIAL,
		);
	}, []);

	const transform = useCallback(
		async (input: {
			instruction: string;
			instructionLabel: string;
			snapshot: AiTransformSnapshot;
		}) => {
			if (!recoveryReadyRef.current || unresolvedRef.current) {
				setState(unknownOutcome(unresolvedRef.current?.partial));
				return;
			}
			if (!documentId) {
				setState({ ...INITIAL, status: "error", error: "No active document" });
				return;
			}
			const controller = getController();
			if (
				!controller ||
				!snapshotMatchesCurrent(input.snapshot, controller, getDocMarkdown())
			) {
				setState({
					...INITIAL,
					status: "error",
					error:
						"The document changed after you selected the text. Select it again.",
				});
				return;
			}
			// Digest and token APIs both yield. Claim ownership before either starts.
			const ticket = ownerRef.current.begin(documentId);
			const { sourceNodeId, sourceMarkdown } = input.snapshot;
			pendingCommitRef.current = null;
			setState({
				status: "streaming",
				partial: "",
				error: null,
				awaitingDecision: false,
			});

			let acc = "";
			let retryIsKnownSafe = false;
			try {
				const sourceHash = await sha256Text(sourceMarkdown);
				if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
				const token = await getToken({ template: "convex" });
				if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
				if (!token) throw new Error("Sign in to use AI");
				if (
					!snapshotMatchesCurrent(input.snapshot, controller, getDocMarkdown())
				) {
					ownerRef.current.finish(ticket);
					setState({
						...INITIAL,
						status: "error",
						error:
							"The document changed after you selected the text. Select it again.",
					});
					return;
				}
				if (!ownerRef.current.markSent(ticket)) return;
				unresolvedGenerationRef.current += 1;
				unresolvedRef.current = {
					requestId: ticket.requestId,
					documentId,
					generation: unresolvedGenerationRef.current,
					snapshot: input.snapshot,
					controller,
					instructionLabel: input.instructionLabel,
					partial: "",
				};
				const response = await fetch(`${requireConvexSiteUrl()}/ai/transform`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						requestId: ticket.requestId,
						documentId,
						sourceNodeId,
						sourceHash,
						instruction: input.instruction,
						selection: input.snapshot.selection,
						platform: "web",
						traceContent: true,
					}),
					signal: ticket.controller.signal,
				});
				if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
				if (!response.ok) {
					const failure = await readAiTransformError(response);
					if (!ownerRef.current.isCurrent(ticket, documentIdRef.current))
						return;
					if (failure.requestInProgress) {
						const captured = unresolvedRef.current;
						const activeRun = await convex.query(
							api.ai.runs.latestRecoverable,
							{ documentId, kind: "transform" },
						);
						if (!ownerRef.current.isCurrent(ticket, documentIdRef.current))
							return;
						if (
							captured &&
							transformReconciliationIsCurrent(
								captured,
								unresolvedRef.current,
								documentIdRef.current,
								unresolvedGenerationRef.current,
							) &&
							activeRun &&
							activeRun.requestId !== captured.requestId
						) {
							unresolvedGenerationRef.current += 1;
							unresolvedRef.current = {
								requestId: activeRun.requestId,
								documentId: captured.documentId,
								generation: unresolvedGenerationRef.current,
								partial: "",
							};
						}
					}
					retryIsKnownSafe = failure.retrySafe;
					throw new Error(failure.message);
				}
				if (!response.body) {
					throw new Error(`AI request failed (${response.status})`);
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				while (true) {
					const { value, done } = await reader.read();
					if (!ownerRef.current.isCurrent(ticket, documentIdRef.current))
						return;
					if (done) break;
					acc += decoder.decode(value, { stream: true });
					if (unresolvedRef.current?.requestId === ticket.requestId) {
						unresolvedRef.current.partial = acc;
					}
					setState((current) => ({ ...current, partial: acc }));
				}
				acc += decoder.decode();
			} catch (error) {
				if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
				ownerRef.current.finish(ticket);
				if (ticket.phase === "sent" && !retryIsKnownSafe) {
					setState(unknownOutcome(acc));
					return;
				}
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error: error instanceof Error ? error.message : "AI request failed",
				});
				return;
			}

			if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
			const aiText = acc;
			if (!aiText.trim()) {
				ownerRef.current.finish(ticket);
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error: "The model returned nothing",
				});
				return;
			}
			if (
				controller.currentNodeId !== sourceNodeId ||
				getDocMarkdown() !== sourceMarkdown ||
				!ownerRef.current.isCurrent(ticket, documentIdRef.current)
			) {
				ownerRef.current.finish(ticket);
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error: "The document changed. Run the transform again.",
				});
				return;
			}

			let nextMarkdown: string;
			if (input.snapshot.richReplace) {
				const replaced = input.snapshot.richReplace(aiText);
				if (replaced === null) {
					ownerRef.current.finish(ticket);
					unresolvedRef.current = null;
					setState({
						...INITIAL,
						status: "error",
						error: "Lost the selection. Select again and retry.",
					});
					return;
				}
				nextMarkdown = replaced;
			} else {
				nextMarkdown = applyTransform(
					sourceMarkdown,
					input.snapshot.range,
					aiText,
				);
			}
			if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
			const commit = await commitTransformAfterAcknowledgement({
				acknowledge: async () =>
					(
						await acknowledgeRun({
							requestId: ticket.requestId,
						})
					).acknowledged,
				snapshot: input.snapshot,
				controller,
				getMarkdown: getDocMarkdown,
				isCurrent: () =>
					ownerRef.current.isCurrent(ticket, documentIdRef.current),
				nextMarkdown,
				origin: `ai:${input.instructionLabel}`,
			});
			if (commit.status === "acknowledgement-failed") {
				ownerRef.current.finish(ticket);
				setState(unknownOutcome(aiText));
				return;
			}
			if (commit.status === "source-changed") {
				ownerRef.current.finish(ticket);
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error: "The document changed. Run the transform again.",
				});
				return;
			}
			const committed = commit.nodeId;
			ownerRef.current.finish(ticket);
			unresolvedRef.current = null;
			if (!committed) {
				setState({ ...INITIAL, status: "committed" });
				return;
			}
			pendingCommitRef.current = {
				documentId,
				controller,
				sourceNodeId: commit.sourceNodeId,
				sourceMarkdown,
				aiNodeId: committed,
				aiMarkdown: commit.aiMarkdown,
			};
			setState({
				status: "committed",
				partial: aiText,
				error: null,
				awaitingDecision: mode === "pending",
			});
		},
		[
			acknowledgeRun,
			convex,
			documentId,
			getController,
			getDocMarkdown,
			getToken,
			mode,
		],
	);

	const reconcile = useCallback(async () => {
		const initialUnresolved = unresolvedRef.current;
		if (
			!initialUnresolved ||
			!transformReconciliationIsCurrent(
				initialUnresolved,
				unresolvedRef.current,
				documentIdRef.current,
				unresolvedGenerationRef.current,
			)
		)
			return;
		let unresolved: UnresolvedTransform = initialUnresolved;
		const isCurrent = (requestId = unresolved.requestId) =>
			transformReconciliationIsCurrent(
				unresolved,
				unresolvedRef.current,
				documentIdRef.current,
				unresolvedGenerationRef.current,
			) && unresolved.requestId === requestId;
		setState({
			status: "streaming",
			partial: unresolved.partial,
			error: null,
			awaitingDecision: false,
		});
		const resolution = await reconcileTransformRun({
			requestId: unresolved.requestId,
			query: async (requestId) =>
				await convex.query(api.ai.runs.get, {
					requestId,
				}),
			recovery: {
				latest: async () =>
					await convex.query(api.ai.runs.latestRecoverable, {
						documentId: unresolved.documentId,
						kind: "transform",
					}),
				adopt: (requestId, activeRequestId) => {
					if (!isCurrent(requestId)) return false;
					unresolvedGenerationRef.current += 1;
					unresolved = {
						requestId: activeRequestId,
						documentId: unresolved.documentId,
						generation: unresolvedGenerationRef.current,
						partial: "",
					};
					unresolvedRef.current = unresolved;
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
			isCurrent,
		});
		if (resolution.status === "stale") return;
		if (resolution.status === "retry-safe") {
			unresolvedRef.current = null;
			setState({
				...INITIAL,
				status: "error",
				error:
					"The earlier transform stopped before completion. You can run it again.",
			});
			return;
		}
		if (resolution.status === "succeeded") {
			if (
				!unresolved.snapshot ||
				!unresolved.controller ||
				!unresolved.instructionLabel
			) {
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error:
						"The earlier transform finished, but its selection was lost after reload. Select the text again.",
				});
				return;
			}
			if (
				documentIdRef.current !== unresolved.documentId ||
				!snapshotMatchesCurrent(
					unresolved.snapshot,
					unresolved.controller,
					getDocMarkdown(),
				)
			) {
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error:
						"The transform finished, but the document changed. Select the text again.",
				});
				return;
			}
			const nextMarkdown = unresolved.snapshot.richReplace
				? unresolved.snapshot.richReplace(resolution.output)
				: applyTransform(
						unresolved.snapshot.sourceMarkdown,
						unresolved.snapshot.range,
						resolution.output,
					);
			if (nextMarkdown === null) {
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error:
						"The transform finished, but its selection could not be restored.",
				});
				return;
			}
			if (!isCurrent()) return;
			const commit = commitTransformAtCurrentSource({
				controller: unresolved.controller,
				getMarkdown: getDocMarkdown,
				expectedSourceNodeId: unresolved.snapshot.sourceNodeId,
				sourceMarkdown: unresolved.snapshot.sourceMarkdown,
				nextMarkdown,
				origin: `ai:${unresolved.instructionLabel}`,
			});
			if (commit.status === "source-changed") {
				unresolvedRef.current = null;
				setState({
					...INITIAL,
					status: "error",
					error:
						"The transform finished, but the document changed. Select the text again.",
				});
				return;
			}
			if (!isCurrent()) return;
			const committed = commit.nodeId;
			unresolvedRef.current = null;
			if (committed) {
				pendingCommitRef.current = {
					documentId: unresolved.documentId,
					controller: unresolved.controller,
					sourceNodeId: commit.sourceNodeId,
					sourceMarkdown: unresolved.snapshot.sourceMarkdown,
					aiNodeId: committed,
					aiMarkdown: commit.aiMarkdown,
				};
			}
			setState({
				status: "committed",
				partial: resolution.output,
				error: null,
				awaitingDecision: mode === "pending" && Boolean(committed),
			});
			return;
		}
		if (!isCurrent()) return;
		setState(unknownOutcome(unresolved.partial));
	}, [acknowledgeRun, cancelRun, convex, getDocMarkdown, mode]);

	const accept = useCallback(() => {
		pendingCommitRef.current = null;
		setState(INITIAL);
	}, []);

	const reject = useCallback(() => {
		rejectAiCommit(
			pendingCommitRef.current,
			documentIdRef.current,
			getController(),
			getDocMarkdown(),
		);
		pendingCommitRef.current = null;
		setState(INITIAL);
	}, [getController, getDocMarkdown]);

	return { state, transform, accept, reject, cancel, reset, reconcile };
}
