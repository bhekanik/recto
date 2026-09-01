"use client";

import { useAuth } from "@clerk/nextjs";
import { useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { HistoryController } from "@/lib/history/use-document-history";
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

export type PendingAiCommit = {
	documentId: string;
	controller: Pick<HistoryController, "currentNodeId" | "nodes" | "navigateTo">;
	sourceNodeId: string;
	aiNodeId: string;
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

type TransformRun = {
	status:
		| "reserved"
		| "provider_started"
		| "succeeded"
		| "failed"
		| "cancelled"
		| "outcome_unknown";
	output?: string;
} | null;

export type TransformRunResolution =
	| { status: "unresolved" }
	| { status: "retry-safe" }
	| { status: "succeeded"; output: string };

export function resolveTransformRun(run: TransformRun): TransformRunResolution {
	if (!run || run.status === "reserved") return { status: "unresolved" };
	if (run.status === "failed" || run.status === "cancelled") {
		return { status: "retry-safe" };
	}
	if (run.status === "succeeded" && run.output !== undefined) {
		return { status: "succeeded", output: run.output };
	}
	return { status: "unresolved" };
}

export function canRejectAiCommit(
	pending: PendingAiCommit | null,
	documentId: string | null,
	controller: Pick<
		HistoryController,
		"currentNodeId" | "nodes" | "navigateTo"
	> | null,
): pending is PendingAiCommit {
	return Boolean(
		pending &&
			controller &&
			documentId === pending.documentId &&
			controller === pending.controller &&
			controller.currentNodeId === pending.aiNodeId &&
			controller.nodes.some(
				(node) =>
					node.nodeId === pending.aiNodeId &&
					node.parentNodeId === pending.sourceNodeId &&
					node.origin?.startsWith("ai:"),
			),
	);
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
		retrySafe: Boolean(
			body?.success &&
				body.data.code &&
				body.data.code !== "request_outcome_unknown" &&
				body.data.code !== "request_in_progress",
		),
	};
}

type UnresolvedTransform = {
	requestId: string;
	documentId: Id<"documents">;
	snapshot: AiTransformSnapshot;
	controller: HistoryController;
	instructionLabel: string;
	partial: string;
};

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
	const [state, setState] = useState<AiTransformState>(INITIAL);
	const ownerRef = useRef(new AiRequestOwner());
	const documentIdRef = useRef<Id<"documents"> | null>(documentId);
	const previousDocumentRef = useRef<Id<"documents"> | null>(documentId);
	const pendingCommitRef = useRef<PendingAiCommit | null>(null);
	const unresolvedRef = useRef<UnresolvedTransform | null>(null);
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
		pendingCommitRef.current = null;
		setState(
			phase === "sent" || unresolvedRef.current
				? unknownOutcome(unresolvedRef.current?.partial)
				: INITIAL,
		);
	}, [documentId]);

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
			if (unresolvedRef.current) {
				setState(unknownOutcome(unresolvedRef.current.partial));
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
				unresolvedRef.current = {
					requestId: ticket.requestId,
					documentId,
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
			const committed = controller.commitProgrammatic(nextMarkdown, {
				origin: `ai:${input.instructionLabel}`,
			});
			ownerRef.current.finish(ticket);
			unresolvedRef.current = null;
			if (!committed) {
				setState({ ...INITIAL, status: "committed" });
				return;
			}
			pendingCommitRef.current = {
				documentId,
				controller,
				sourceNodeId,
				aiNodeId: committed,
			};
			setState({
				status: "committed",
				partial: aiText,
				error: null,
				awaitingDecision: mode === "pending",
			});
		},
		[documentId, getController, getDocMarkdown, getToken, mode],
	);

	const reconcile = useCallback(async () => {
		const unresolved = unresolvedRef.current;
		if (!unresolved) return;
		setState({
			status: "streaming",
			partial: unresolved.partial,
			error: null,
			awaitingDecision: false,
		});
		try {
			let remoteRun = await convex.query(api.ai.runs.get, {
				requestId: unresolved.requestId,
			});
			let resolution = resolveTransformRun(remoteRun);
			if (remoteRun?.status === "reserved") {
				const cancelled = await cancelRun({ requestId: unresolved.requestId });
				if (cancelled.cancelled) resolution = { status: "retry-safe" };
				else if (cancelled.reason === "terminal") {
					remoteRun = await convex.query(api.ai.runs.get, {
						requestId: unresolved.requestId,
					});
					resolution = resolveTransformRun(remoteRun);
				}
			}
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
				unresolvedRef.current = null;
				if (
					documentIdRef.current !== unresolved.documentId ||
					!snapshotMatchesCurrent(
						unresolved.snapshot,
						unresolved.controller,
						getDocMarkdown(),
					)
				) {
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
					setState({
						...INITIAL,
						status: "error",
						error:
							"The transform finished, but its selection could not be restored.",
					});
					return;
				}
				const committed = unresolved.controller.commitProgrammatic(
					nextMarkdown,
					{
						origin: `ai:${unresolved.instructionLabel}`,
					},
				);
				if (committed) {
					pendingCommitRef.current = {
						documentId: unresolved.documentId,
						controller: unresolved.controller,
						sourceNodeId: unresolved.snapshot.sourceNodeId,
						aiNodeId: committed,
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
		} catch {
			// Keep the request locked until its server state is known.
		}
		setState(unknownOutcome(unresolved.partial));
	}, [cancelRun, convex, getDocMarkdown, mode]);

	const accept = useCallback(() => {
		pendingCommitRef.current = null;
		setState(INITIAL);
	}, []);

	const reject = useCallback(() => {
		const pending = pendingCommitRef.current;
		const controller = getController();
		if (canRejectAiCommit(pending, documentIdRef.current, controller)) {
			pending.controller.navigateTo(pending.sourceNodeId);
		}
		pendingCommitRef.current = null;
		setState(INITIAL);
	}, [getController]);

	return { state, transform, accept, reject, cancel, reset, reconcile };
}
