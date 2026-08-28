/**
 * A pane's mode switch snapshots the outgoing lens's live text so the incoming
 * one has something to seed from before it has mounted.
 */
export type PaneSnapshot = {
	markdown: string;
	/** The published projection this snapshot was taken against. */
	basis: string | null;
} | null;

/**
 * The snapshot a pane should still honour, or null to fall back to the
 * projection.
 *
 * A snapshot is only valid while the projection it was taken against is
 * unchanged. Holding it indefinitely pinned the pane to the text it had at the
 * moment of the switch: a remote projection arriving while the pane sat in
 * preview was never rendered, and switching back to an editable lens seeded —
 * and then flushed — that stale snapshot under whichever node had since been
 * adopted.
 */
export function activePaneSnapshot(
	snapshot: PaneSnapshot,
	projection: string | null,
): string | null {
	if (!snapshot) return null;
	// A newer projection supersedes the snapshot, whatever the pane is doing.
	if (snapshot.basis !== projection) return null;
	return snapshot.markdown;
}
