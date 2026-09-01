"use client";

import { useCallback, useEffect, useState } from "react";

import type { AiTransformRequest } from "@/components/ai/ai-transform-popover";
import type { Id } from "@/convex/_generated/dataModel";
import type { TransformRange } from "@/lib/ai/apply-transform";
import { AI_TRANSFORM_SUMMON_EVENT, setAiEnabledMirror } from "@/lib/ai/summon";
import { useAiReview } from "@/lib/ai/use-ai-review";
import { useAiTransform } from "@/lib/ai/use-ai-transform";
import { useRag } from "@/lib/ai/use-rag";
import type { HistoryController } from "@/lib/history/use-document-history";
import { caretAtOffset } from "@/lib/modes/caret";
import type { Mode } from "@/lib/modes/types";
import type { AiTransformMode } from "@/lib/studio/use-studio-settings";
import { toast } from "@/lib/ui/toast";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import type { WorkspaceState } from "@/lib/workspace/types";

type AiPopoverState = {
	open: boolean;
	selection: {
		text: string;
		range: TransformRange;
		richReplace?: (replacement: string) => string | null;
	} | null;
};

type UseAiFeaturesArgs = {
	activeDocId: Id<"documents"> | null;
	workspace: WorkspaceState | null;
	registry: DocumentModelRegistry;
	activeMode: Mode;
	/** settings.aiEnabled && !activeDocShared — the EFFECTIVE AI gate (plans 009/010). */
	effectiveAiEnabled: boolean;
	aiTransformMode: AiTransformMode;
	/** Live canonical markdown of the active doc (handle, falling back to sync). */
	getActiveMarkdown: () => string;
	/** The active document's history controller (for transform commits + reindex). */
	getController: () => HistoryController | null;
	/** Point the active pane at a document (for opening a cited related passage). */
	setPaneDocument: (paneId: string, documentId: Id<"documents"> | null) => void;
};

export type UseAiFeaturesResult = {
	aiTransform: ReturnType<typeof useAiTransform>;
	aiPopover: AiPopoverState;
	setAiPopover: React.Dispatch<React.SetStateAction<AiPopoverState>>;
	aiReview: ReturnType<typeof useAiReview>;
	aiReviewOpen: boolean;
	setAiReviewOpen: React.Dispatch<React.SetStateAction<boolean>>;
	relatedOpen: boolean;
	setRelatedOpen: React.Dispatch<React.SetStateAction<boolean>>;
	summonAiTransform: () => void;
	runAiTransform: (req: AiTransformRequest) => void;
	handleReindex: () => Promise<void>;
	openRelatedPassage: (documentId: Id<"documents">, charStart: number) => void;
};

/**
 * AI features (plan 009 transform + RAG, plan 011 reviewer). Gated behind the
 * EFFECTIVE AI flag (settings.aiEnabled AND the active doc not being shared for
 * review). Owns the transform popover + review/related panel open state, the AI
 * transform summon/run wiring (incl. the out-of-tree selection toolbar event), the
 * on-demand re-index, opening a cited related passage, and keeping the selection
 * toolbar's AI button in sync with the EFFECTIVE flag.
 */
export function useAiFeatures({
	activeDocId,
	workspace,
	registry,
	activeMode,
	effectiveAiEnabled,
	aiTransformMode,
	getActiveMarkdown,
	getController,
	setPaneDocument,
}: UseAiFeaturesArgs): UseAiFeaturesResult {
	// Keep the out-of-tree selection toolbar's AI button in sync with the EFFECTIVE
	// flag so it hides on a shared document.
	useEffect(() => {
		setAiEnabledMirror(effectiveAiEnabled);
	}, [effectiveAiEnabled]);

	const aiTransform = useAiTransform({
		documentId: activeDocId,
		getController,
		getDocMarkdown: getActiveMarkdown,
		mode: aiTransformMode,
	});
	const [aiPopover, setAiPopover] = useState<AiPopoverState>({
		open: false,
		selection: null,
	});
	// AI reviewer (plan 011): on the owner's own un-shared doc, the AI leaves real
	// anchored comments through plan 010's primitives (it runs as the owner over
	// their own doc; the no-AI-on-shared gate keeps it off shared docs).
	const aiReview = useAiReview({
		documentId: activeDocId,
		getDocMarkdown: getActiveMarkdown,
		getSourceNodeId: () => getController()?.currentNodeId ?? null,
	});
	const [aiReviewOpen, setAiReviewOpen] = useState(false);
	const [relatedOpen, setRelatedOpen] = useState(false);

	const { reindexDocument } = useRag();

	// Summon the AI transform over the current selection. Works in the CodeMirror
	// lenses (raw/vim) — where exportCaret offsets ARE markdown offsets — and in the
	// rich (Milkdown) lens, where the handle serializes the selected slice to
	// markdown (no position→offset math). Preview has no editable selection.
	const summonAiTransform = useCallback(() => {
		if (!effectiveAiEnabled) return;
		const mode = activeMode;
		if (mode === "preview") {
			toast(
				"AI transform needs an editable selection. Switch to Rich, Raw, or Vim, select text, and try again.",
				"info",
			);
			return;
		}
		if (!activeDocId || !workspace) return;
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		if (!handle) return;

		if (mode === "rich") {
			// Rich lens: serialize the live selection to canonical markdown. The
			// offset range is unused on this path (richReplace splices via a PM
			// transaction at commit time), so carry a placeholder range.
			const text = handle.getSelectedMarkdown?.() ?? null;
			const richReplace =
				handle.captureSelectionMarkdownReplacement?.() ?? null;
			if (!text || !richReplace) {
				toast("Select some text first, then summon the AI transform.", "info");
				return;
			}
			aiTransform.reset();
			setAiPopover({
				open: true,
				selection: { text, range: { from: 0, to: 0 }, richReplace },
			});
			return;
		}

		const caret = handle.exportCaret();
		const from = Math.min(caret.anchor, caret.head);
		const to = Math.max(caret.anchor, caret.head);
		if (from === to) {
			toast("Select some text first, then summon the AI transform.", "info");
			return;
		}
		const doc = handle.getCanonicalMarkdown();
		const text = doc.slice(from, to);
		aiTransform.reset();
		setAiPopover({ open: true, selection: { text, range: { from, to } } });
	}, [
		effectiveAiEnabled,
		activeMode,
		activeDocId,
		workspace,
		registry,
		aiTransform,
	]);

	// The selection toolbar's AI button (out of tree) summons via this event.
	useEffect(() => {
		const onSummon = () => summonAiTransform();
		window.addEventListener(AI_TRANSFORM_SUMMON_EVENT, onSummon);
		return () =>
			window.removeEventListener(AI_TRANSFORM_SUMMON_EVENT, onSummon);
	}, [summonAiTransform]);

	const runAiTransform = useCallback(
		(req: AiTransformRequest) => {
			// Rich lens: hand the transform a closure that splices the AI text into
			// the live ProseMirror selection and returns the new full canonical
			// markdown (committed once by the hook). raw/vim use the offset path.
			const richReplace = aiPopover.selection?.richReplace;
			void aiTransform.transform({
				instruction: req.instruction,
				instructionLabel: req.instructionLabel,
				range: req.range,
				selection: req.selection,
				richReplace,
			});
		},
		[aiPopover.selection, aiTransform],
	);

	// "Re-index this draft for search" (Phase C) — chunk + embed via the Next
	// route, persist to Convex. Runs on demand, never per keystroke.
	const handleReindex = useCallback(async () => {
		if (!effectiveAiEnabled || !activeDocId) return;
		const history = getController();
		const currentNodeId = history?.currentNodeId;
		if (!currentNodeId) return;
		const markdown = getActiveMarkdown();
		try {
			const count = await reindexDocument({
				documentId: activeDocId,
				currentNodeId,
				markdown,
			});
			toast(`Indexed ${count} passage${count === 1 ? "" : "s"}.`, "success");
		} catch (err) {
			toast(`Re-index failed: ${(err as Error).message}`, "error");
		}
	}, [
		effectiveAiEnabled,
		activeDocId,
		getActiveMarkdown,
		getController,
		reindexDocument,
	]);

	// Open a cited related passage: switch the active pane to that doc, then jump
	// to the passage offset once the editor has mounted + seeded.
	const openRelatedPassage = useCallback(
		(documentId: Id<"documents">, charStart: number) => {
			if (!workspace?.activePaneId) return;
			setPaneDocument(workspace.activePaneId, documentId);
			setRelatedOpen(false);
			// Defer the caret jump until the editor for the new doc is mounted.
			let tries = 0;
			const tryJump = () => {
				const handle = registry.getPrimaryHandle(
					documentId,
					workspace.activePaneId,
				);
				if (handle) {
					const md = handle.getCanonicalMarkdown();
					handle.importCaret(caretAtOffset(charStart, md.length));
					handle.focus();
					return;
				}
				if (tries++ < 40) requestAnimationFrame(tryJump);
			};
			requestAnimationFrame(tryJump);
		},
		[workspace, setPaneDocument, registry],
	);

	return {
		aiTransform,
		aiPopover,
		setAiPopover,
		aiReview,
		aiReviewOpen,
		setAiReviewOpen,
		relatedOpen,
		setRelatedOpen,
		summonAiTransform,
		runAiTransform,
		handleReindex,
		openRelatedPassage,
	};
}
