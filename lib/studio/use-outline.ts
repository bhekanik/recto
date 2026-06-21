"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import type { Id } from "@/convex/_generated/dataModel";
import { caretAtOffset } from "@/lib/modes/caret";
import { extractOutline, type OutlineHeading } from "@/lib/outline/extract";
import { scrollRootToHeadingIndex } from "@/lib/outline/scroll-to-heading";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import type { WorkspaceState } from "@/lib/workspace/types";

type UseOutlineArgs = {
	activeDocId: Id<"documents"> | null;
	workspace: WorkspaceState | null;
	registry: DocumentModelRegistry;
	/** Synced markdown — the change SIGNAL that re-arms the debounced refresh. */
	syncedMarkdown: string;
	/** The outline panel is open (refresh immediately when it opens). */
	outlinePanelOpen: boolean;
	/** The headings command palette is open (refresh immediately when it opens). */
	headingsPaletteOpen: boolean;
};

export type UseOutlineResult = {
	outline: OutlineHeading[];
	jumpToHeading: (index: number) => void;
};

/**
 * Document outline (plan 005). Reads from the live handle (falling back to the
 * synced markdown), recomputing on a debounce (D3) so typing stays off the parse
 * hot path; refreshes immediately when the panel or the headings palette opens.
 * Exposes the extracted outline and a heading-jump that scrolls the rendered DOM
 * and best-effort moves the caret.
 */
export function useOutline({
	activeDocId,
	workspace,
	registry,
	syncedMarkdown,
	outlinePanelOpen,
	headingsPaletteOpen,
}: UseOutlineArgs): UseOutlineResult {
	const [outlineMarkdown, setOutlineMarkdown] = useState("");
	const refreshOutlineMarkdown = useCallback(() => {
		if (!activeDocId || !workspace) {
			setOutlineMarkdown("");
			return;
		}
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		const markdown = handle?.getCanonicalMarkdown() ?? syncedMarkdown;
		setOutlineMarkdown(markdown);
	}, [activeDocId, workspace, registry, syncedMarkdown]);

	// The arg is the change signal only — the refresh always re-reads the live
	// handle (the synced markdown can lag the live editor by a frame).
	const debouncedRefreshOutline = useDebouncedCallback((_signal: string) => {
		refreshOutlineMarkdown();
	}, 250);

	// Re-arm the debounced refresh whenever the synced markdown changes.
	useEffect(() => {
		debouncedRefreshOutline(syncedMarkdown);
	}, [syncedMarkdown, debouncedRefreshOutline]);

	// Refresh immediately when the panel or the headings palette opens, so the
	// list is current the moment it's shown (the debounce can lag a recent edit).
	useEffect(() => {
		if (outlinePanelOpen || headingsPaletteOpen) refreshOutlineMarkdown();
	}, [outlinePanelOpen, headingsPaletteOpen, refreshOutlineMarkdown]);

	const outline = useMemo(
		() => extractOutline(outlineMarkdown),
		[outlineMarkdown],
	);
	const outlineRef = useRef(outline);
	outlineRef.current = outline;

	const jumpToHeading = useCallback(
		(index: number) => {
			if (!activeDocId || !workspace) return;
			const handle = registry.getPrimaryHandle(
				activeDocId,
				workspace.activePaneId,
			);
			// Scroll (works in rich/preview via rendered <hN> elements under the root).
			let root = handle?.getRootElement() ?? null;
			// Preview mode registers no handle — reach the active pane's preview DOM (D1a).
			if (!root) {
				root =
					document.querySelector<HTMLElement>(
						`[data-pane-id="${workspace.activePaneId}"] .recto-preview`,
					) ?? document.querySelector<HTMLElement>(".recto-preview");
			}
			scrollRootToHeadingIndex(root, index);
			// Best-effort caret: offset-exact for CodeMirror (raw/vim), a bonus for
			// Milkdown where the offset space differs. Focusing scrolls CM to the caret.
			const h = outlineRef.current[index];
			if (handle && h) {
				const md = handle.getCanonicalMarkdown();
				handle.importCaret(caretAtOffset(h.offset, md.length));
				handle.focus();
			}
		},
		[activeDocId, workspace, registry],
	);

	return { outline, jumpToHeading };
}
