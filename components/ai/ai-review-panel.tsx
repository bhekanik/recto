"use client";

import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { useAiReview } from "@/lib/ai/use-ai-review";

type Props = {
	open: boolean;
	/** The review hook instance from the studio shell. */
	review: ReturnType<typeof useAiReview>;
	onClose: () => void;
	/** Open plan 010's review surface (where the AI comments now live). */
	onOpenReview: () => void;
};

/**
 * AI review progress/summary panel (plan 011, Phase A). Supersedes the read-only
 * critique panel: instead of a passive list of notes, the AI reviewer creates
 * real anchored comments through plan 010's primitives, and this panel just
 * reports the placement summary and points the owner at the review/comments
 * surface where the feedback lives. Chrome: fixed inset-y right aside,
 * recto-panel, scrim, Escape-to-close, focus restore.
 */
export function AiReviewPanel({ open, review, onClose, onOpenReview }: Props) {
	const { state, summary, error, run, reset, reconcile } = review;
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const activeElement = globalThis.document?.activeElement;
	if (
		open &&
		!restoreFocusRef.current &&
		activeElement &&
		activeElement instanceof globalThis.HTMLElement
	) {
		restoreFocusRef.current = activeElement;
	}

	// Kick off the review when the panel opens; reset (aborts in-flight) on close.
	useEffect(() => {
		if (open) {
			void run();
		} else {
			reset();
		}
	}, [open, run, reset]);

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					const restoreFocus = restoreFocusRef.current;
					onClose();
					queueMicrotask(() => restoreFocus?.focus());
				}
			}}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) restoreFocusRef.current = null;
			}}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="recto-scrim fixed inset-0 z-[90]" />
				<Dialog.Popup
					className="recto-panel fixed inset-y-0 right-0 z-[91] flex h-full w-[min(22rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l outline-none"
					initialFocus={closeRef}
					finalFocus={restoreFocusRef}
				>
					<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
						<Dialog.Title
							id="recto-ai-review-title"
							className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
						>
							AI review
						</Dialog.Title>
						<Dialog.Close
							ref={closeRef}
							autoFocus
							aria-label="Close AI review"
							className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
						>
							<X aria-hidden className="size-4" />
						</Dialog.Close>
					</header>

					<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-3)] py-[var(--space-3)]">
						{state === "loading" && (
							<p className="px-[var(--space-1)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
								Reading your draft and leaving notes…
							</p>
						)}
						{state === "error" && (
							<p className="px-[var(--space-1)] py-[var(--space-4)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
								{error}
							</p>
						)}
						{state === "outcome-unknown" && (
							<div className="flex flex-col gap-[var(--space-3)] px-[var(--space-1)] py-[var(--space-4)]">
								<p className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
									{error}
								</p>
								<button
									type="button"
									onClick={() => void reconcile()}
									className="self-start rounded-[var(--radius-md)] border border-[var(--color-line)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)] hover:text-[var(--color-ink-primary)]"
								>
									Check status
								</button>
							</div>
						)}
						{state === "done" && summary && (
							<div className="flex flex-col gap-[var(--space-3)] px-[var(--space-1)] py-[var(--space-2)]">
								{summary.commentsTotal === 0 && summary.editsTotal === 0 ? (
									<p className="text-[length:var(--text-ui-sm)] leading-[var(--leading-ui)] text-[var(--color-ink-tertiary)]">
										No notes — looks solid.
									</p>
								) : (
									<>
										<p className="text-[length:var(--text-ui-sm)] leading-[var(--leading-ui)] text-[var(--color-ink-secondary)]">
											Placed {summary.commentsPlaced} of {summary.commentsTotal}{" "}
											comment{summary.commentsTotal === 1 ? "" : "s"}
											{summary.editsTotal > 0 && (
												<>
													{" "}
													and {summary.editsPlaced} of {summary.editsTotal} edit
													{summary.editsTotal === 1 ? "" : "s"} in a review
													branch
												</>
											)}
											.
										</p>
										{(summary.commentsDropped > 0 ||
											summary.editsDropped > 0) && (
											<p className="text-[length:var(--text-ui-sm)] leading-[var(--leading-ui)] text-[var(--color-ink-tertiary)]">
												{summary.commentsDropped + summary.editsDropped}{" "}
												couldn't be anchored and {""}
												{summary.commentsDropped + summary.editsDropped === 1
													? "was"
													: "were"}{" "}
												skipped.
											</p>
										)}
										{(summary.commentsPlaced > 0 ||
											summary.editsPlaced > 0) && (
											<button
												type="button"
												onClick={onOpenReview}
												className="self-start rounded-[var(--radius-md)] border border-[var(--color-line)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)] transition-colors hover:text-[var(--color-ink-primary)]"
											>
												Open review
											</button>
										)}
									</>
								)}
							</div>
						)}
					</div>
					<footer className="shrink-0 border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-2)] text-[0.6875rem] text-[var(--color-ink-tertiary)]">
						AI comments appear in the comments panel; AI edits land on a review
						branch — review them like a human reviewer's.
					</footer>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
