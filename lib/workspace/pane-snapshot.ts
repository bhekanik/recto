/**
 * A pane's mode switch snapshots the outgoing lens's live text so the incoming
 * one has something to seed from before it has mounted.
 */
export type PaneSnapshot = {
	markdown: string;
	/**
	 * The projection generation this snapshot was taken against. A counter, not
	 * the text: an undo can republish the exact markdown a superseded snapshot
	 * was keyed on, and equality would then bring that snapshot back to life
	 * after a newer projection had already replaced it.
	 */
	basisGeneration: number;
} | null;

/**
 * The snapshot a pane should still honour, or null to fall back to the
 * projection.
 *
 * A snapshot is valid only until the next projection. Holding it beyond that
 * pinned the pane to the text it had at the moment of the switch: a remote
 * update arriving while the pane sat in preview was never rendered, and
 * switching back to an editable lens seeded — and then flushed — that stale
 * copy under whichever node had since been adopted. The generation is
 * monotonic, so once superseded a snapshot can never reactivate.
 */
export function activePaneSnapshot(
	snapshot: PaneSnapshot,
	projectionGeneration: number,
): string | null {
	if (!snapshot) return null;
	if (snapshot.basisGeneration !== projectionGeneration) return null;
	return snapshot.markdown;
}
