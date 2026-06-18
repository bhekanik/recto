"use client";

import { useCallback, useRef, useState } from "react";

import type { HistoryController } from "@/lib/history/use-document-history";
import type { AiTransformMode } from "@/lib/studio/use-studio-settings";
import { applyTransform, type TransformRange } from "./apply-transform";

export type AiTransformStatus = "idle" | "streaming" | "committed" | "error";

export type AiTransformState = {
	status: AiTransformStatus;
	/** Partial (then full) streamed rewrite, for live display. */
	partial: string;
	error: string | null;
	/** True only in "pending" mode after a commit, until accept/reject. */
	awaitingDecision: boolean;
};

const INITIAL: AiTransformState = {
	status: "idle",
	partial: "",
	error: null,
	awaitingDecision: false,
};

/**
 * Reversible AI selection transform hook (plan 009, Phase A). Streams a rewrite
 * of the selected span from the Next route, displays the partial text, and on
 * completion commits the result as an undo-tree node via the history controller
 * (reversible by construction). Respects `aiTransformMode`:
 *  - "replace": commit and done (undo still rejects).
 *  - "pending": commit, then expose accept()/reject(); reject undoes the node.
 * Cancellation aborts the fetch and commits nothing.
 */
export function useAiTransform(args: {
	getController: () => HistoryController | null;
	getDocMarkdown: () => string;
	mode: AiTransformMode;
}) {
	const { getController, getDocMarkdown, mode } = args;
	const [state, setState] = useState<AiTransformState>(INITIAL);
	const abortRef = useRef<AbortController | null>(null);
	// The pre-AI nodeId, so reject can return precisely there.
	const preNodeRef = useRef<string | null>(null);

	const reset = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		preNodeRef.current = null;
		setState(INITIAL);
	}, []);

	const cancel = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setState(INITIAL);
	}, []);

	/**
	 * Stream + commit. For the CodeMirror lenses (raw/vim) `range` is offsets into
	 * the CURRENT doc markdown and the rewrite splices in via {@link applyTransform}.
	 * For the rich (Milkdown) lens ProseMirror positions are not markdown offsets,
	 * so `richReplace(aiText)` returns the new FULL canonical markdown with the
	 * selection replaced (computed by the editor handle); when present it is used
	 * instead of the offset splice. Either way the result is committed exactly once.
	 */
	const transform = useCallback(
		async (input: {
			instruction: string;
			instructionLabel: string;
			range: TransformRange;
			selection: string;
			/** Rich-lens path: compute new full markdown from the AI text. */
			richReplace?: (aiText: string) => string | null;
		}) => {
			const controller = getController();
			if (!controller) {
				setState({ ...INITIAL, status: "error", error: "No active document" });
				return;
			}
			abortRef.current?.abort();
			const ac = new AbortController();
			abortRef.current = ac;
			preNodeRef.current = controller.currentNodeId;
			setState({
				status: "streaming",
				partial: "",
				error: null,
				awaitingDecision: false,
			});

			let acc = "";
			try {
				const res = await fetch("/api/ai/transform", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						instruction: input.instruction,
						selection: input.selection,
					}),
					signal: ac.signal,
				});
				if (!res.ok || !res.body) {
					const msg =
						res.status === 401
							? "Sign in to use AI"
							: `AI request failed (${res.status})`;
					setState({ ...INITIAL, status: "error", error: msg });
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					acc += decoder.decode(value, { stream: true });
					setState((s) => ({ ...s, partial: acc }));
				}
			} catch (err) {
				if ((err as Error)?.name === "AbortError") {
					// Cancelled — commit nothing.
					setState(INITIAL);
					return;
				}
				setState({
					...INITIAL,
					status: "error",
					error: (err as Error).message || "AI request failed",
				});
				return;
			} finally {
				if (abortRef.current === ac) abortRef.current = null;
			}

			const aiText = acc.trim();
			if (aiText.length === 0) {
				setState({
					...INITIAL,
					status: "error",
					error: "The model returned nothing",
				});
				return;
			}

			// Compute the new full canonical markdown. Rich lens: ask the editor handle
			// to splice via a ProseMirror transaction over the live selection (no
			// offset math). CodeMirror lenses: splice by offset into the freshest doc
			// markdown (the live editor is the source of truth; re-read in case
			// anything shifted while streaming).
			let newDoc: string;
			if (input.richReplace) {
				const replaced = input.richReplace(aiText);
				if (replaced === null) {
					setState({
						...INITIAL,
						status: "error",
						error: "Lost the selection — select again and retry",
					});
					return;
				}
				newDoc = replaced;
			} else {
				const doc = getDocMarkdown();
				const range = clampRange(input.range, doc.length);
				try {
					newDoc = applyTransform(doc, range, aiText);
				} catch (err) {
					setState({
						...INITIAL,
						status: "error",
						error: (err as Error).message,
					});
					return;
				}
			}

			const committed = controller.commitProgrammatic(newDoc, {
				origin: `ai:${input.instructionLabel}`,
			});
			if (!committed) {
				// No-op edit (AI returned the same text) — nothing to confirm.
				setState({ ...INITIAL, status: "committed" });
				return;
			}

			if (mode === "replace") {
				setState({
					status: "committed",
					partial: aiText,
					error: null,
					awaitingDecision: false,
				});
			} else {
				setState({
					status: "committed",
					partial: aiText,
					error: null,
					awaitingDecision: true,
				});
			}
		},
		[getController, getDocMarkdown, mode],
	);

	/** Keep the AI node (no-op — it's already the tip). */
	const accept = useCallback(() => {
		preNodeRef.current = null;
		setState(INITIAL);
	}, []);

	/** Reject: undo back to the pre-AI node. */
	const reject = useCallback(() => {
		const controller = getController();
		controller?.undo();
		preNodeRef.current = null;
		setState(INITIAL);
	}, [getController]);

	return { state, transform, accept, reject, cancel, reset };
}

/** Clamp a range to a doc whose length may have shifted. */
function clampRange(range: TransformRange, len: number): TransformRange {
	const from = Math.max(0, Math.min(range.from, len));
	const to = Math.max(from, Math.min(range.to, len));
	return { from, to };
}
