"use client";

import { useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import type { CommentDraft } from "@/components/review/comments-panel";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { caretAtOffset } from "@/lib/modes/caret";
import type { Mode } from "@/lib/modes/types";
import {
	type CommentAnchor,
	createAnchor,
	locateAnchor,
} from "@/lib/review/anchor";
import type { CommentHighlight } from "@/lib/review/comment-decorations-cm";
import type { CommentMark } from "@/lib/review/comment-decorations-pm";
import {
	ADD_COMMENT_SUMMON_EVENT,
	dispatchSetComments,
	setCommentingEnabledMirror,
	subscribeOpenComment,
} from "@/lib/review/summon";
import { toast } from "@/lib/ui/toast";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import type { WorkspaceState } from "@/lib/workspace/types";

type UseCommentHighlightsArgs = {
	activeDocId: Id<"documents"> | null;
	workspace: WorkspaceState | null;
	registry: DocumentModelRegistry;
	activeMode: Mode;
	/** Whether commenting is available on the active doc (≥ commenter access). */
	canComment: boolean;
	/** Live canonical markdown of the active doc (handle, falling back to sync). */
	getActiveMarkdown: () => string;
	/** Synced markdown — the change SIGNAL that re-derives highlights on edits. */
	syncedMarkdown: string;
};

export type UseCommentHighlightsResult = {
	commentsOpen: boolean;
	setCommentsOpen: React.Dispatch<React.SetStateAction<boolean>>;
	commentDraft: CommentDraft | null;
	setCommentDraft: React.Dispatch<React.SetStateAction<CommentDraft | null>>;
	focusedCommentId: string | null;
	setFocusedCommentId: React.Dispatch<React.SetStateAction<string | null>>;
	jumpToComment: (anchor: CommentAnchor) => void;
	summonAddComment: () => void;
};

/**
 * Comments (plan 010 Phase B). Owns the comment panel/draft/focused-comment state,
 * the comment query → anchor relocation → `dispatchSetComments` highlight pipeline
 * (debounced off the typing hot path), the selection→draft capture, and the
 * editor→panel open-comment wiring. Reads comments only — never rebinds the
 * editor's document value.
 */
export function useCommentHighlights({
	activeDocId,
	workspace,
	registry,
	activeMode,
	canComment,
	getActiveMarkdown,
	syncedMarkdown,
}: UseCommentHighlightsArgs): UseCommentHighlightsResult {
	const [commentsOpen, setCommentsOpen] = useState(false);
	const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
	// A comment to scroll into view + flash in the panel, set when its editor
	// highlight is clicked (editor→panel). The panel clears it after the flash.
	const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

	// Read comments for the active doc (reader only — never rebinds the editor's
	// document value). Keep the out-of-tree selection toolbar's "comment" button in
	// sync with whether commenting is available on the active doc.
	useEffect(() => {
		setCommentingEnabledMirror(canComment);
	}, [canComment]);

	const activeComments = useQuery(
		api.review.listComments,
		activeDocId && canComment ? { documentId: activeDocId } : "skip",
	);
	const activeCommentsRef = useRef(activeComments);
	activeCommentsRef.current = activeComments;

	// Locate each comment's anchor in the live canonical markdown and push the
	// resulting highlights to the active pane's editors. Orphaned comments (anchor
	// lost → locateAnchor returns null) carry no highlight but still render in the
	// panel. Debounced off the typing hot path; re-derived from the live editor text.
	const pushCommentHighlights = useCallback(() => {
		const comments = activeCommentsRef.current;
		if (!comments) {
			dispatchSetComments({ cm: [], pm: [] });
			return;
		}
		const markdown = getActiveMarkdown();
		const cm: CommentHighlight[] = [];
		const pm: CommentMark[] = [];
		for (const c of comments) {
			// Only top-level comments carry a highlight (replies share the thread).
			if (c.threadParentId) continue;
			const anchor = c.anchor;
			const range = locateAnchor(markdown, anchor);
			if (!range) continue; // orphaned — no highlight
			cm.push({
				commentId: c._id,
				from: range.from,
				to: range.to,
				resolved: c.resolved,
			});
			pm.push({
				commentId: c._id,
				quote: anchor.quote,
				resolved: c.resolved,
			});
		}
		dispatchSetComments({ cm, pm });
	}, [getActiveMarkdown]);

	const debouncedPushComments = useDebouncedCallback(
		pushCommentHighlights,
		250,
	);

	// Re-derive highlights whenever the comment set changes or the doc text changes
	// (the synced markdown is the change signal; the push re-reads the live handle).
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeComments + the synced markdown are the change SIGNALS; the debounced push re-reads the live handle and the latest comments ref
	useEffect(() => {
		debouncedPushComments();
	}, [activeComments, syncedMarkdown, debouncedPushComments]);

	// Scroll the active editor to a comment's anchor (offset-exact in CM; a
	// best-effort caret in Milkdown), mirroring jumpToHeading.
	const jumpToComment = useCallback(
		(anchor: CommentAnchor) => {
			if (!activeDocId || !workspace) return;
			const handle = registry.getPrimaryHandle(
				activeDocId,
				workspace.activePaneId,
			);
			if (!handle) return;
			const md = handle.getCanonicalMarkdown();
			const range = locateAnchor(md, anchor);
			if (!range) return; // orphaned — nothing to scroll to
			handle.importCaret(caretAtOffset(range.from, md.length));
			handle.focus();
		},
		[activeDocId, workspace, registry],
	);

	// Capture the active editor's selection into a comment draft + open the panel.
	// raw/vim: exportCaret offsets ARE markdown offsets. rich: serialize the selected
	// slice to markdown for the quote, then locate it in the canonical to get offsets
	// for prefix/suffix context. preview has no editable selection.
	const summonAddComment = useCallback(() => {
		if (!canComment || !activeDocId || !workspace) return;
		const mode = activeMode;
		if (mode === "preview") {
			setCommentsOpen(true);
			toast(
				"To anchor a comment, select text in Rich, Raw, or Vim. (Switch lens, select, then add a comment.)",
				"info",
			);
			return;
		}
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		if (!handle) return;
		const md = handle.getCanonicalMarkdown();

		let anchor: CommentAnchor | null = null;
		if (mode === "rich") {
			const selected = handle.getSelectedMarkdown?.() ?? null;
			if (selected) {
				// Locate the selected text in the canonical to capture prefix/suffix.
				const idx = md.indexOf(selected);
				anchor =
					idx >= 0
						? createAnchor(md, idx, idx + selected.length)
						: {
								quote: selected.slice(0, 200),
								prefix: "",
								suffix: "",
								offsetHint: 0,
							};
			}
		} else {
			const caret = handle.exportCaret();
			const from = Math.min(caret.anchor, caret.head);
			const to = Math.max(caret.anchor, caret.head);
			if (from !== to) anchor = createAnchor(md, from, to);
		}

		if (!anchor?.quote.trim()) {
			setCommentsOpen(true);
			toast("Select some text first, then add a comment.", "info");
			return;
		}
		setCommentDraft({ anchor });
		setCommentsOpen(true);
	}, [canComment, activeDocId, workspace, activeMode, registry]);

	useEffect(() => {
		const onSummon = () => summonAddComment();
		window.addEventListener(ADD_COMMENT_SUMMON_EVENT, onSummon);
		return () => window.removeEventListener(ADD_COMMENT_SUMMON_EVENT, onSummon);
	}, [summonAddComment]);

	// Clicking a comment highlight in either editor (editor→panel) opens the panel
	// and focuses that comment so the panel can scroll + flash it. Gated on
	// canComment so a non-commenter's click is a harmless no-op (the panel is
	// only rendered when canComment anyway).
	useEffect(() => {
		if (!canComment) return;
		return subscribeOpenComment((commentId) => {
			setCommentsOpen(true);
			setFocusedCommentId(commentId);
		});
	}, [canComment]);

	return {
		commentsOpen,
		setCommentsOpen,
		commentDraft,
		setCommentDraft,
		focusedCommentId,
		setFocusedCommentId,
		jumpToComment,
		summonAddComment,
	};
}
