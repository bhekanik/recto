/**
 * A pane's mode switch snapshots the outgoing lens's live text so the incoming
 * one has something to seed from before it has mounted.
 */
export type PaneSnapshot = {
	markdown: string;
	/**
	 * The projection this snapshot was taken against, as a key scoped to the host
	 * instance and the document — not a bare counter.
	 *
	 * A counter restarts at 0 for every host and every document, so a snapshot
	 * taken in document A, or by a host that has since remounted, collided with
	 * document B's first publication and flushed A's text under B. It is not the
	 * markdown either: an undo republishes the exact text a superseded snapshot
	 * was taken against, which would bring it back to life.
	 */
	basisGeneration: string;
} | null;

/**
 * The snapshot a pane should still honour, or null to fall back to the
 * projection.
 *
 * A snapshot is valid only until the next publication. Holding it beyond that
 * pinned the pane to the text it had at the moment of the switch: a remote
 * update arriving while the pane sat in preview was never rendered, and
 * switching back to an editable lens seeded — and then flushed — that stale copy
 * under whichever node had since been adopted.
 */
export function activePaneSnapshot(
	snapshot: PaneSnapshot,
	projectionGeneration: string,
): string | null {
	if (!snapshot) return null;
	if (snapshot.basisGeneration !== projectionGeneration) return null;
	return snapshot.markdown;
}
