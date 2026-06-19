"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { Check, CornerDownRight, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommentAnchor } from "@/lib/review/anchor";

type CommentRow = {
	_id: Id<"comments">;
	authorUserId: string;
	authorName: string;
	anchor: CommentAnchor;
	body: string;
	threadParentId?: Id<"comments">;
	resolved: boolean;
	createdAt: number;
};

/** A pending comment draft captured from the active editor's selection. */
export type CommentDraft = { anchor: CommentAnchor };

type CommentsPanelProps = {
	documentId: Id<"documents">;
	open: boolean;
	/** Whether the active user owns the document (can resolve/delete any comment). */
	isOwner: boolean;
	/** A selection captured for a new comment, or null (then show a hint). */
	draft: CommentDraft | null;
	/** A comment to scroll into view + flash (its editor highlight was clicked). */
	focusedCommentId: string | null;
	/** Clear the focused comment (after the flash plays). */
	onClearFocusedComment: () => void;
	/** Clear the captured draft (after submit/cancel). */
	onClearDraft: () => void;
	/** Scroll the editor to a comment's anchor. */
	onJumpToComment: (anchor: CommentAnchor) => void;
	onClose: () => void;
};

const timeFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

/**
 * Comments side panel (plan 010, Phase B). Modeled on outline-panel.tsx /
 * history-panel.tsx chrome (fixed right aside, recto-panel, scrim, Escape-to-close,
 * focus restore). Lists threaded comments for the active doc, jumps to an anchor on
 * click, and composes new comments / replies / resolve / delete — all through the
 * Convex mutations (the only write path). Comments are read via useQuery (the panel
 * is a reader); it never rebinds the editor's document value.
 */
export function CommentsPanel({
	documentId,
	open,
	isOwner,
	draft,
	focusedCommentId,
	onClearFocusedComment,
	onClearDraft,
	onJumpToComment,
	onClose,
}: CommentsPanelProps) {
	const { userId } = useAuth();
	const comments = useQuery(
		api.review.listComments,
		open ? { documentId } : "skip",
	) as CommentRow[] | undefined;

	const addComment = useMutation(api.review.addComment);
	const setResolved = useMutation(api.review.setCommentResolved);
	const removeComment = useMutation(api.review.removeComment);

	const [draftBody, setDraftBody] = useState("");
	const [replyTo, setReplyTo] = useState<Id<"comments"> | null>(null);
	const [replyBody, setReplyBody] = useState("");
	const [pending, setPending] = useState(false);
	// Synchronous in-flight guard for comment/reply submits. A state flag (`pending`)
	// flips only after React commits, so ⌘/Ctrl+Enter + a fast click (or a double
	// click) could both pass the check and fire addComment twice → a duplicate
	// comment (addComment has no idempotency key). This ref is set at call entry,
	// before any await, so the second caller bails immediately. `pending` stays for
	// the disabled-button UX.
	const submittingRef = useRef(false);

	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const draftRef = useRef<HTMLTextAreaElement | null>(null);
	// Per-comment DOM nodes, so a clicked highlight can scroll its panel row into
	// view and flash it.
	const commentNodesRef = useRef(new Map<string, HTMLLIElement>());

	useEffect(() => {
		if (open) {
			restoreFocusRef.current = document.activeElement as HTMLElement | null;
		} else if (restoreFocusRef.current) {
			restoreFocusRef.current.focus?.();
			restoreFocusRef.current = null;
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	// Focus the composer the moment a selection is captured for a new comment.
	useEffect(() => {
		if (open && draft) {
			setDraftBody("");
			requestAnimationFrame(() => draftRef.current?.focus());
		}
	}, [open, draft]);

	// A highlight was clicked (editor→panel): scroll that comment's row into view and
	// flash it briefly. `comments` is a dependency so a click that arrives before the
	// list has loaded still resolves once the row mounts. The flash class is removed
	// after the animation, and the focused id is cleared so re-clicking the same
	// comment re-triggers the flash.
	// biome-ignore lint/correctness/useExhaustiveDependencies: comments retriggers the lookup once rows mount; onClearFocusedComment is a stable setter
	useEffect(() => {
		if (!open || !focusedCommentId) return;
		const node = commentNodesRef.current.get(focusedCommentId);
		if (!node) return;
		node.scrollIntoView({ block: "center", behavior: "smooth" });
		node.classList.add("recto-comment-flash");
		const timer = window.setTimeout(() => {
			node.classList.remove("recto-comment-flash");
			onClearFocusedComment();
		}, 1200);
		return () => window.clearTimeout(timer);
	}, [open, focusedCommentId, comments]);

	// Group into top-level threads + their replies, oldest first (list is sorted).
	const threads = useMemo(() => {
		const roots: CommentRow[] = [];
		const repliesByParent = new Map<string, CommentRow[]>();
		for (const c of comments ?? []) {
			if (c.threadParentId) {
				const arr = repliesByParent.get(c.threadParentId) ?? [];
				arr.push(c);
				repliesByParent.set(c.threadParentId, arr);
			} else {
				roots.push(c);
			}
		}
		return roots.map((root) => ({
			root,
			replies: repliesByParent.get(root._id) ?? [],
		}));
	}, [comments]);

	const canModerate = useCallback(
		(c: CommentRow) => isOwner || c.authorUserId === userId,
		[isOwner, userId],
	);

	const submitDraft = useCallback(async () => {
		if (!draft) return;
		const body = draftBody.trim();
		if (!body) return;
		if (submittingRef.current) return; // a submit is already in flight
		submittingRef.current = true;
		setPending(true);
		try {
			await addComment({ documentId, anchor: draft.anchor, body });
			setDraftBody("");
			onClearDraft();
		} finally {
			submittingRef.current = false;
			setPending(false);
		}
	}, [addComment, documentId, draft, draftBody, onClearDraft]);

	const submitReply = useCallback(
		async (parentId: Id<"comments">, anchor: CommentAnchor) => {
			const body = replyBody.trim();
			if (!body) return;
			if (submittingRef.current) return; // a submit is already in flight
			submittingRef.current = true;
			setPending(true);
			try {
				await addComment({
					documentId,
					anchor,
					body,
					threadParentId: parentId,
				});
				setReplyBody("");
				setReplyTo(null);
			} finally {
				submittingRef.current = false;
				setPending(false);
			}
		},
		[addComment, documentId, replyBody],
	);

	if (!open) return null;

	const composerClass =
		"w-full resize-none rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-app)] px-[var(--space-2)] py-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-primary)] outline-none placeholder:text-[var(--color-ink-tertiary)] focus:border-[var(--color-accent)]";

	return (
		<div className="fixed inset-y-0 right-0 z-[90] flex">
			<button
				type="button"
				aria-label="Close comments"
				className="recto-scrim absolute inset-0 -left-[100vw]"
				onClick={onClose}
			/>
			<aside
				className="recto-panel relative z-10 flex h-full w-[min(22rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
				role="dialog"
				aria-modal="true"
				aria-labelledby="recto-comments-title"
			>
				<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
					<h2
						id="recto-comments-title"
						className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
					>
						Comments
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close comments"
						className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
					>
						<X aria-hidden className="size-4" />
					</button>
				</header>

				{/* New-comment composer (shown once a selection is captured). */}
				{draft && (
					<div className="shrink-0 border-b border-[var(--color-line)] bg-[var(--color-bg-app)] px-[var(--space-3)] py-[var(--space-3)]">
						<p className="mb-1.5 text-[0.6875rem] text-[var(--color-ink-tertiary)]">
							Commenting on:{" "}
							<span className="text-[var(--color-ink-secondary)]">
								“{draft.anchor.quote.slice(0, 80)}
								{draft.anchor.quote.length > 80 ? "…" : ""}”
							</span>
						</p>
						<textarea
							ref={draftRef}
							value={draftBody}
							onChange={(e) => setDraftBody(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									void submitDraft();
								}
							}}
							rows={3}
							placeholder="Write a comment… (⌘/Ctrl+Enter to post)"
							className={composerClass}
						/>
						<div className="mt-1.5 flex justify-end gap-[var(--space-2)]">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setDraftBody("");
									onClearDraft();
								}}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								disabled={pending || !draftBody.trim()}
								onClick={() => void submitDraft()}
							>
								Comment
							</Button>
						</div>
					</div>
				)}

				<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
					{comments === undefined ? (
						<p className="px-[var(--space-2)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							Loading…
						</p>
					) : threads.length === 0 ? (
						<p className="px-[var(--space-2)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							{draft
								? "Write your first comment above."
								: "No comments yet. Select text and add a comment."}
						</p>
					) : (
						<ul className="flex flex-col gap-[var(--space-2)]">
							{threads.map(({ root, replies }) => (
								<li
									key={root._id}
									ref={(node) => {
										if (node) commentNodesRef.current.set(root._id, node);
										else commentNodesRef.current.delete(root._id);
									}}
									className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-app)] p-[var(--space-2)]"
								>
									<CommentItem
										comment={root}
										canModerate={canModerate(root)}
										onJump={() => onJumpToComment(root.anchor)}
										onToggleResolved={() =>
											void setResolved({
												commentId: root._id,
												resolved: !root.resolved,
											})
										}
										onDelete={() => void removeComment({ commentId: root._id })}
									/>

									{replies.length > 0 && (
										<ul className="mt-[var(--space-1)] flex flex-col gap-[var(--space-1)] border-l border-[var(--color-line)] pl-[var(--space-2)]">
											{replies.map((reply) => (
												<li key={reply._id}>
													<CommentItem
														comment={reply}
														canModerate={canModerate(reply)}
														onToggleResolved={() =>
															void setResolved({
																commentId: reply._id,
																resolved: !reply.resolved,
															})
														}
														onDelete={() =>
															void removeComment({ commentId: reply._id })
														}
													/>
												</li>
											))}
										</ul>
									)}

									{/* Reply composer for this thread. */}
									{replyTo === root._id ? (
										<div className="mt-[var(--space-2)]">
											<textarea
												value={replyBody}
												onChange={(e) => setReplyBody(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
														e.preventDefault();
														void submitReply(root._id, root.anchor);
													}
													if (e.key === "Escape") {
														e.stopPropagation();
														setReplyTo(null);
														setReplyBody("");
													}
												}}
												rows={2}
												placeholder="Reply…"
												className={composerClass}
												// biome-ignore lint/a11y/noAutofocus: composer opened by an explicit user action
												autoFocus
											/>
											<div className="mt-1 flex justify-end gap-[var(--space-2)]">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => {
														setReplyTo(null);
														setReplyBody("");
													}}
												>
													Cancel
												</Button>
												<Button
													size="sm"
													disabled={pending || !replyBody.trim()}
													onClick={() =>
														void submitReply(root._id, root.anchor)
													}
												>
													Reply
												</Button>
											</div>
										</div>
									) : (
										<button
											type="button"
											onClick={() => {
												setReplyTo(root._id);
												setReplyBody("");
											}}
											className="mt-1 inline-flex items-center gap-1 text-[0.6875rem] text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-secondary)]"
										>
											<CornerDownRight aria-hidden className="size-3" />
											Reply
										</button>
									)}
								</li>
							))}
						</ul>
					)}
				</div>
			</aside>
		</div>
	);
}

type CommentItemProps = {
	comment: CommentRow;
	canModerate: boolean;
	onJump?: () => void;
	onToggleResolved: () => void;
	onDelete: () => void;
};

function CommentItem({
	comment,
	canModerate,
	onJump,
	onToggleResolved,
	onDelete,
}: CommentItemProps) {
	return (
		<div className={comment.resolved ? "opacity-60" : undefined}>
			<div className="flex items-center justify-between gap-[var(--space-2)]">
				<div className="flex min-w-0 items-center gap-[var(--space-2)]">
					<span className="truncate text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-primary)]">
						{comment.authorName}
					</span>
					<span className="shrink-0 text-[0.625rem] text-[var(--color-ink-tertiary)]">
						{timeFmt.format(comment.createdAt)}
					</span>
				</div>
				{canModerate && (
					<div className="flex shrink-0 items-center gap-0.5">
						<button
							type="button"
							onClick={onToggleResolved}
							aria-label={comment.resolved ? "Unresolve" : "Resolve"}
							title={comment.resolved ? "Unresolve" : "Resolve"}
							className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-tertiary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-primary)]"
						>
							{comment.resolved ? (
								<RotateCcw aria-hidden className="size-3.5" />
							) : (
								<Check aria-hidden className="size-3.5" />
							)}
						</button>
						<button
							type="button"
							onClick={onDelete}
							aria-label="Delete comment"
							title="Delete"
							className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-tertiary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)]"
						>
							<Trash2 aria-hidden className="size-3.5" />
						</button>
					</div>
				)}
			</div>

			{/* Anchor quote — click to jump (root comments only). */}
			{onJump && (
				<button
					type="button"
					onClick={onJump}
					className="mt-0.5 block w-full truncate text-left text-[0.6875rem] text-[var(--color-comment)] transition-colors hover:underline"
					title="Jump to highlighted text"
				>
					“{comment.anchor.quote.slice(0, 80)}
					{comment.anchor.quote.length > 80 ? "…" : ""}”
				</button>
			)}

			<p className="mt-1 whitespace-pre-wrap text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
				{comment.body}
			</p>
		</div>
	);
}
