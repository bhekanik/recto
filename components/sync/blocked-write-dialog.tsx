"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { BlockedWrite } from "@/lib/history/use-document-history";
import { describeDiscards } from "@/lib/sync/sync-indicator";

type BlockedWriteDialogProps = {
	blocked: BlockedWrite | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRetry: () => void;
	onDiscard: () => void;
};

/** Keep the destructive choice inside shadcn's focus-trapping AlertDialog. */
export function BlockedWriteDialog({
	blocked,
	open,
	onOpenChange,
	onRetry,
	onDiscard,
}: BlockedWriteDialogProps) {
	if (!blocked) return null;

	const discards = describeDiscards(blocked.discards);
	const retrySeconds = blocked.retryAfterMs
		? Math.ceil(blocked.retryAfterMs / 1000)
		: 0;

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{blocked.terminal
							? "The server refused this change"
							: "Couldn't save this change"}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{blocked.terminal
							? "Sending it again will get the same answer. Your text is safe on screen and in local recovery."
							: "Retrying may work. Your text is safe on screen and in local recovery."}
					</AlertDialogDescription>
				</AlertDialogHeader>

				<p
					data-testid="blocked-write-message"
					className="rounded-[var(--radius-sm)] bg-[var(--color-bg-hover)] p-[var(--space-3)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
				>
					{blocked.message}
				</p>

				{discards.length > 0 && (
					<p
						data-testid="blocked-write-discards"
						className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
					>
						Discarding gives up {discards.join(", ")}. The words on screen stay.
						Your next edit saves them as a new change.
					</p>
				)}

				<AlertDialogFooter>
					<AlertDialogCancel>Keep waiting</AlertDialogCancel>
					{!blocked.terminal && (
						<AlertDialogAction
							onClick={() => {
								onRetry();
								onOpenChange(false);
							}}
						>
							{retrySeconds > 0 ? `Try again in ${retrySeconds}s` : "Try again"}
						</AlertDialogAction>
					)}
					<AlertDialogAction
						variant={blocked.terminal ? "destructive" : "outline"}
						onClick={() => {
							onDiscard();
							onOpenChange(false);
						}}
					>
						Discard and keep my text
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
