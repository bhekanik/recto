import type { DiscardSummary } from "@/lib/history/use-document-history";
import type { SyncStatus } from "@/lib/sync/use-document-sync";

/**
 * What the status bar shows, from the three facts that decide it.
 *
 * The autosave's own status only knows about `documents.markdown`. Everything
 * the undo tree writes — node commits, pointer moves, version tags — goes
 * through a separate queue, and a VERSION tag publishes no projection at all,
 * so a manual version could sit uncreated while the autosave still reported
 * "Saved". Queue occupancy is therefore part of the answer.
 *
 * The three states mean different things and a writer should be able to tell
 * them apart:
 *
 * - "Saved" — everything this device produced is on the server.
 * - "Unsynced" — we have work the server has not confirmed yet. Normal; it
 *   clears on its own, including after a reconnect, because Convex keeps
 *   retrying a mutation until the server answers.
 * - "Not synced" — the server REFUSED a write and re-sending cannot fix it.
 *   Terminal, and the only one that needs the writer to do something.
 */
export function displaySyncStatus(args: {
	status: SyncStatus;
	hasPendingWrites: boolean;
	blocked: boolean;
}): SyncStatus {
	if (args.blocked) return "unresolved";
	// Never downgrade a status that is already telling the writer something —
	// "saving" and "unsynced" already say the document is not settled.
	if (
		args.hasPendingWrites &&
		(args.status === "saved" || args.status === "idle")
	) {
		return "unsynced";
	}
	return args.status;
}

/**
 * What discarding a stuck write would throw away, in words. The counts matter
 * to the writer: "your last two edits, one of them from the AI, a saved version
 * and a history move" is a decision they can make; "discard queued work" is not.
 */
export function describeDiscards(discards: DiscardSummary): string[] {
	const parts: string[] = [];
	if (discards.commits > 0) {
		const edits = `${discards.commits} unsaved ${discards.commits === 1 ? "edit" : "edits"}`;
		parts.push(
			discards.aiCommits > 0
				? `${edits} (${discards.aiCommits} from AI)`
				: edits,
		);
	}
	if (discards.versions > 0) {
		parts.push(
			`${discards.versions} saved ${discards.versions === 1 ? "version" : "versions"}`,
		);
	}
	if (discards.pointers > 0) {
		parts.push(
			`${discards.pointers} history ${discards.pointers === 1 ? "move" : "moves"}`,
		);
	}
	return parts;
}

/** The subset of the sync state the status indicator reads. */
export type SyncIndicatorSource = {
	syncStatus: SyncStatus;
	hasPendingWrites: boolean;
	blockedWrite: { message: string } | null;
};

/**
 * The status bar's props, derived in one place.
 *
 * Extracted because the mapping is the part that was wrong: calling
 * `displaySyncStatus` from a test proved the rule but not that the shell passed
 * it the right three values, so removing the wiring left every status test
 * green.
 */
export type SyncIndicatorProps = {
	syncStatus: SyncStatus;
	/** Whether there is a stuck write for the writer to decide about. */
	blocked: boolean;
};

export function syncIndicatorProps(
	source: SyncIndicatorSource,
): SyncIndicatorProps {
	const blocked = source.blockedWrite !== null;
	return {
		syncStatus: displaySyncStatus({
			status: source.syncStatus,
			hasPendingWrites: source.hasPendingWrites,
			blocked,
		}),
		blocked,
	};
}
