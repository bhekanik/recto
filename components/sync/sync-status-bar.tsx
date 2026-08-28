"use client";

import { useState } from "react";

import { StatusBar, type StatusBarProps } from "@/components/status-bar";
import { BlockedWriteDialog } from "@/components/sync/blocked-write-dialog";
import { syncIndicatorProps } from "@/lib/sync/sync-indicator";
import type { DocumentSyncState } from "@/lib/workspace/workspace-context";

type SyncStatusBarProps = Omit<
	StatusBarProps,
	"syncStatus" | "onShowBlocked"
> & {
	/** The active document is the only source of sync state and actions. */
	sync: Pick<
		DocumentSyncState,
		| "syncStatus"
		| "hasPendingWrites"
		| "blockedWrite"
		| "retryBlockedWrite"
		| "resolveBlockedWrite"
	>;
};

/** Keep the indicator and its dialog wired to the same document state. */
export function SyncStatusBar({ sync, ...statusBarProps }: SyncStatusBarProps) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const { syncStatus, blocked } = syncIndicatorProps(sync);

	return (
		<>
			<StatusBar
				{...statusBarProps}
				syncStatus={syncStatus}
				onShowBlocked={blocked ? () => setDialogOpen(true) : undefined}
			/>
			<BlockedWriteDialog
				blocked={sync.blockedWrite}
				open={dialogOpen && sync.blockedWrite !== null}
				onOpenChange={setDialogOpen}
				onRetry={sync.retryBlockedWrite}
				onDiscard={sync.resolveBlockedWrite}
			/>
		</>
	);
}
