"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

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
	};
}

export function useAiTransform(args: {
	documentId: Id<"documents"> | null;
	getController: () => HistoryController | null;
	getDocMarkdown: () => string;
	mode: AiTransformMode;
}) {
	const { documentId, getController, getDocMarkdown, mode } = args;
	const { getToken } = useAuth();
	const [state, setState] = useState<AiTransformState>(INITIAL);
	const ownerRef = useRef(new AiRequestOwner());
	const documentIdRef = useRef<Id<"documents"> | null>(documentId);
	const previousDocumentRef = useRef<Id<"documents"> | null>(documentId);
	const pendingCommitRef = useRef<PendingAiCommit | null>(null);
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
		setState(phase === "sent" ? unknownOutcome() : INITIAL);
	}, [documentId]);

	const reset = useCallback(() => {
		const phase = ownerRef.current.supersede();
		pendingCommitRef.current = null;
		setState(phase === "sent" ? unknownOutcome() : INITIAL);
	}, []);

	const cancel = useCallback(() => {
		const phase = ownerRef.current.supersede();
		pendingCommitRef.current = null;
		setState(phase === "sent" ? unknownOutcome() : INITIAL);
	}, []);

	const transform = useCallback(
		async (input: {
			instruction: string;
			instructionLabel: string;
			range: TransformRange;
			selection: string;
			richReplace?: (aiText: string) => string | null;
		}) => {
			if (!documentId) {
				setState({ ...INITIAL, status: "error", error: "No active document" });
				return;
			}
			// Digest and token APIs both yield. Claim ownership before either starts.
			const ticket = ownerRef.current.begin(documentId);
			const controller = getController();
			const sourceNodeId = controller?.currentNodeId;
			if (!controller || !sourceNodeId) {
				ownerRef.current.finish(ticket);
				setState({ ...INITIAL, status: "error", error: "No active document" });
				return;
			}
			const sourceMarkdown = getDocMarkdown();
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
				if (!ownerRef.current.markSent(ticket)) return;
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
						selection: input.selection,
						platform: "web",
						traceContent: true,
					}),
					signal: ticket.controller.signal,
				});
				if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
				if (!response.ok) {
					const failure = await readAiTransformError(response);
					retryIsKnownSafe = !failure.outcomeUnknown;
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
					setState((current) => ({ ...current, partial: acc }));
				}
			} catch (error) {
				if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
				ownerRef.current.finish(ticket);
				if (ticket.phase === "sent" && !retryIsKnownSafe) {
					setState(unknownOutcome(acc));
					return;
				}
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
				setState({
					...INITIAL,
					status: "error",
					error: "The document changed. Run the transform again.",
				});
				return;
			}

			let nextMarkdown: string;
			if (input.richReplace) {
				const replaced = input.richReplace(aiText);
				if (replaced === null) {
					ownerRef.current.finish(ticket);
					setState({
						...INITIAL,
						status: "error",
						error: "Lost the selection. Select again and retry.",
					});
					return;
				}
				nextMarkdown = replaced;
			} else {
				nextMarkdown = applyTransform(sourceMarkdown, input.range, aiText);
			}
			if (!ownerRef.current.isCurrent(ticket, documentIdRef.current)) return;
			const committed = controller.commitProgrammatic(nextMarkdown, {
				origin: `ai:${input.instructionLabel}`,
			});
			ownerRef.current.finish(ticket);
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

	return { state, transform, accept, reject, cancel, reset };
}
