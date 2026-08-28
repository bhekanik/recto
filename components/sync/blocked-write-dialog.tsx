"use client";

import { useCallback, useEffect } from "react";

import { Button } from "@/components/ui/button";
import type { BlockedWrite } from "@/lib/history/use-document-history";
import { describeDiscards } from "@/lib/sync/sync-indicator";

type BlockedWriteDialogProps = {
	blocked: BlockedWrite | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRetry: () => void;
	onDiscard: () => void;
};

/**
 * What the writer sees when a write is stuck. It exists because discarding is
 * lossy and a one-click control could not say so: the server's own message, the
 * exact work that would be thrown away, and Retry offered first for anything
 * the server has not classified as a permanent refusal.
 */
export function BlockedWriteDialog({
	blocked,
	open,
	onOpenChange,
	onRetry,
	onDiscard,
}: BlockedWriteDialogProps) {
	const close = useCallback(() => onOpenChange(false), [onOpenChange]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [open, close]);

	if (!open || !blocked) return null;

	const discards = describeDiscards(blocked.discards);
	const retrySeconds = blocked.retryAfterMs
		? Math.ceil(blocked.retryAfterMs / 1000)
		: 0;

	return (
		<div
			className="recto-scrim fixed inset-0 z-[110] flex items-center justify-center p-[var(--space-4)]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="recto-blocked-title"
		>
			<button
				type="button"
				className="absolute inset-0"
				aria-label="Close"
				onClick={close}
			/>
			<div className="recto-panel relative z-10 w-full max-w-md p-[var(--space-5)]">
				<h2
					id="recto-blocked-title"
					className="text-[length:var(--text-ui)] font-[var(--font-reading)] text-[var(--color-ink-primary)]"
				>
					{blocked.terminal
						? "The server refused this change"
						: "Couldn't save this change"}
				</h2>
				<p className="mt-[var(--space-1)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
					{blocked.terminal
						? "Sending it again will get the same answer. Your text is safe on screen and in local recovery."
						: "This one may work on another attempt — a busy moment on the server, or a rate limit. Your text is safe on screen and in local recovery."}
				</p>

				<p className="mt-[var(--space-3)] rounded-[var(--radius-sm)] bg-[var(--color-bg-hover)] p-[var(--space-3)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
					{blocked.message}
				</p>

				{discards.length > 0 && (
					<div className="mt-[var(--space-3)]">
						<p className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
							Discarding gives up {discards.join(", ")}. The words on screen
							stay — your next edit saves them as a new change.
						</p>
					</div>
				)}

				<div className="mt-[var(--space-4)] flex justify-end gap-[var(--space-2)]">
					<Button variant="ghost" onClick={close}>
						Keep waiting
					</Button>
					{!blocked.terminal && (
						<Button
							onClick={() => {
								onRetry();
								close();
							}}
						>
							{retrySeconds > 0 ? `Try again in ${retrySeconds}s` : "Try again"}
						</Button>
					)}
					<Button
						variant={blocked.terminal ? "default" : "ghost"}
						onClick={() => {
							onDiscard();
							close();
						}}
					>
						Discard and keep my text
					</Button>
				</div>
			</div>
		</div>
	);
}
