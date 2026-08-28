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
