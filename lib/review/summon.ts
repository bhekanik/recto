/**
 * Editor-agnostic "add a comment on the current selection" signal (plan 010 Phase
 * B), mirroring lib/ai/summon.ts. The rich-mode selection toolbar mounts outside
 * the React settings provider (via a Milkdown plugin view), so it fires this event
 * and reads a module-level mirror to decide whether to render its button; the
 * studio-shell listens, reads the live selection, and opens the comment composer.
 */

import type { CommentHighlight } from "@/lib/review/comment-decorations-cm";
import type { CommentMark } from "@/lib/review/comment-decorations-pm";

export const ADD_COMMENT_SUMMON_EVENT = "recto:add-comment";

/**
 * Window event carrying located comment highlights for the active pane's editors.
 * studio-shell owns the comment query + anchoring; the active PaneEditor listens and
 * pushes the marks into its mounted CodeMirror / Milkdown handles (the same shape as
 * the prose-lint `recto:lint-count` event). This keeps "editor owns live state":
 * the editor's document value is never rebound, only its display-only decorations.
 */
export const SET_COMMENTS_EVENT = "recto:set-comments";

export type SetCommentsDetail = {
	cm: CommentHighlight[];
	pm: CommentMark[];
};

/** Push located comment highlights to the active pane's editors. */
export function dispatchSetComments(detail: SetCommentsDetail): void {
	window.dispatchEvent(new CustomEvent(SET_COMMENTS_EVENT, { detail }));
}

let commentingEnabledMirror = false;

/** Sync the module mirror with whether commenting is available on the active doc. */
export function setCommentingEnabledMirror(enabled: boolean): void {
	commentingEnabledMirror = enabled;
}

/** Read the mirrored flag (for out-of-tree UI like the selection toolbar). */
export function isCommentingEnabled(): boolean {
	return commentingEnabledMirror;
}

/** Ask the active editor's host to add a comment over the current selection. */
export function dispatchAddComment(): void {
	window.dispatchEvent(new CustomEvent(ADD_COMMENT_SUMMON_EVENT));
}
