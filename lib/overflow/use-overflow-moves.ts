"use client";

import { useCallback } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { HistoryController } from "@/lib/history/use-document-history";
import { normalizeMarkdown } from "@/lib/markdown";
import type { Mode } from "@/lib/modes/types";
import { toast } from "@/lib/ui/toast";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import {
	appendToNotes,
	MAX_OVERFLOW_BYTES,
	removeFromNotes,
	utf8Bytes,
} from "./notes";
import type { OverflowNotes } from "./use-overflow-notes";

type Deps = {
	registry: DocumentModelRegistry;
	activeDocId: Id<"documents"> | null;
	activePaneId: string | null;
	activeMode: Mode;
	getController: () => HistoryController | null;
	notes: OverflowNotes;
};

/**
 * Moving text between the draft and Overflow on the web.
 *
 * Each move writes the destination first and the source second, so a failure
 * between them leaves the text in both places rather than in neither. The
 * draft half is one history node, so Undo puts the draft back; unlike the Mac,
 * the web does not also reverse the notes, because the record of the move
 * lives on the Mac that made it.
 */
export function useOverflowMoves({
	registry,
	activeDocId,
	activePaneId,
	activeMode,
	getController,
	notes,
}: Deps) {
	const editable = useCallback(() => {
		if (!activeDocId || activeMode === "preview") {
			toast("Switch to Rich, Raw or Vim to move text.", "info");
			return null;
		}
		const handle = registry.getPrimaryHandle(activeDocId, activePaneId);
		const controller = getController();
		if (!handle || !controller) return null;
		return { handle, controller };
	}, [registry, activeDocId, activePaneId, activeMode, getController]);

	/** Commit `next` as one node, only if the draft is still `source`. */
	const commitDraft = useCallback(
		(
			controller: HistoryController,
			getMarkdown: () => string,
			source: string,
			head: string | null,
			next: string,
		): boolean => {
			if (controller.getHeadNodeId() !== head) return false;
			controller.flush();
			if (getMarkdown() !== source) return false;
			return (
				controller.commitProgrammatic(normalizeMarkdown(next), {
					origin: "overflow",
				}) !== null
			);
		},
		[],
	);

	const stash = useCallback(async () => {
		const target = editable();
		if (!target) return;
		const { handle, controller } = target;
		controller.flush();
		const head = controller.getHeadNodeId();
		const source = handle.getCanonicalMarkdown();
		let passage = "";
		let next: string | null = null;
		if (activeMode === "rich") {
			const captured = handle.captureAiSelection?.() ?? null;
			if (captured) {
				passage = captured.markdown;
				next = captured.replace("");
			}
		} else {
			const caret = handle.exportCaret();
			const from = Math.min(caret.anchor, caret.head);
			const to = Math.max(caret.anchor, caret.head);
			passage = source.slice(from, to);
			next = source.slice(0, from) + source.slice(to);
		}
		if (passage.trim().length === 0 || next === null) {
			toast("Select the text to stash in Overflow.", "info");
			return;
		}
		const notesNext = appendToNotes(notes.currentText(), passage);
		if (utf8Bytes(notesNext) > MAX_OVERFLOW_BYTES) {
			toast("Overflow can hold up to 64 KiB of notes.", "error");
			return;
		}
		if (!(await notes.replaceAndSave(notesNext))) {
			toast(
				"Overflow could not be saved, so the passage stays in the draft.",
				"error",
			);
			return;
		}
		if (
			!commitDraft(
				controller,
				() => handle.getCanonicalMarkdown(),
				source,
				head,
				next,
			)
		) {
			toast(
				"The draft changed while stashing. The passage is in Overflow and still in the draft.",
				"info",
			);
		}
	}, [editable, activeMode, notes, commitDraft]);

	const moveIntoDraft = useCallback(
		async (from: number, text: string) => {
			const target = editable();
			if (!target) return;
			const { handle, controller } = target;
			controller.flush();
			const head = controller.getHeadNodeId();
			const source = handle.getCanonicalMarkdown();
			const caret =
				activeMode === "rich"
					? (handle.getMarkdownCaret?.() ?? null)
					: handle.exportCaret().head;
			if (caret === null || caret < 0 || caret > source.length) {
				toast(
					"Put the caret where the text belongs in the draft first.",
					"info",
				);
				return;
			}
			const next = source.slice(0, caret) + text + source.slice(caret);
			if (
				!commitDraft(
					controller,
					() => handle.getCanonicalMarkdown(),
					source,
					head,
					next,
				)
			) {
				toast("The draft changed. Try again.", "info");
				return;
			}
			const remaining = removeFromNotes(notes.currentText(), from, text);
			if (remaining === null || !(await notes.replaceAndSave(remaining))) {
				toast("The text is in the draft and still in Overflow.", "info");
			}
		},
		[editable, activeMode, notes, commitDraft],
	);

	return { stash, moveIntoDraft };
}
