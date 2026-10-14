"use client";

import { useCallback } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { HistoryController } from "@/lib/history/use-document-history";
import type { Mode } from "@/lib/modes/types";
import { toast } from "@/lib/ui/toast";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import { ghostContaining, ghosting, reviving } from "./edits";
import {
	emptyWritingState,
	validateWritingState,
	writingStateFor,
} from "./state";

type Deps = {
	registry: DocumentModelRegistry;
	activeDocId: Id<"documents"> | null;
	activePaneId: string | null;
	activeMode: Mode;
	getController: () => HistoryController | null;
};

/**
 * Ghost or revive on the web, recorded on one history node like the Mac. The
 * range is exact: raw and vim give Markdown offsets; rich gives the selected
 * Markdown, which is used only when it occurs once in the draft.
 */
export function useWritingActions({
	registry,
	activeDocId,
	activePaneId,
	activeMode,
	getController,
}: Deps) {
	const toggleGhost = useCallback(() => {
		if (!activeDocId || activeMode === "preview") {
			toast("Switch to Rich, Raw or Vim to ghost text.", "info");
			return;
		}
		const handle = registry.getPrimaryHandle(activeDocId, activePaneId);
		const controller = getController();
		if (!handle || !controller) return;
		controller.flush();
		const markdown = handle.getCanonicalMarkdown();
		let from: number | null = null;
		let to: number | null = null;
		if (activeMode === "rich") {
			const selected = handle.getSelectedMarkdown?.() ?? null;
			if (selected) {
				const at = markdown.indexOf(selected);
				if (at === -1 || markdown.indexOf(selected, at + 1) !== -1) {
					toast(
						"That text appears more than once. Select it in Raw to ghost it.",
						"info",
					);
					return;
				}
				from = at;
				to = at + selected.length;
			} else {
				const caret = handle.getMarkdownCaret?.() ?? null;
				if (caret !== null) from = to = caret;
			}
		} else {
			const caret = handle.exportCaret();
			from = Math.min(caret.anchor, caret.head);
			to = Math.max(caret.anchor, caret.head);
		}
		if (from === null || to === null) return;
		const current =
			writingStateFor(markdown, controller) ?? emptyWritingState();
		const ghost = ghostContaining(current, from);
		const next =
			ghost && to <= ghost.location + ghost.length
				? reviving(current, ghost.id)
				: ghosting(current, from, to, () => crypto.randomUUID());
		if (!next) {
			toast(
				"Select the text to ghost, or put the caret in a ghost to revive it.",
				"info",
			);
			return;
		}
		controller.commitWriting(
			JSON.stringify(validateWritingState(next, markdown)),
		);
	}, [registry, activeDocId, activePaneId, activeMode, getController]);

	return { toggleGhost };
}
