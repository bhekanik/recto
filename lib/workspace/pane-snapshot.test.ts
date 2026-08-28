import { describe, expect, it } from "vitest";

import { activePaneSnapshot, type PaneSnapshot } from "./pane-snapshot";

const AT_SWITCH = "text the writer had when they switched to preview";
const REMOTE = "text another device published while they were in preview";

describe("activePaneSnapshot", () => {
	it("has nothing to honour before a mode switch", () => {
		expect(activePaneSnapshot(null, AT_SWITCH)).toBeNull();
	});

	it("honours the snapshot while the projection has not moved", () => {
		const snapshot: PaneSnapshot = { markdown: AT_SWITCH, basis: AT_SWITCH };
		expect(activePaneSnapshot(snapshot, AT_SWITCH)).toBe(AT_SWITCH);
	});

	it("drops the snapshot as soon as a newer projection arrives", () => {
		// The whole preview -> remote update -> raw sequence, as state. Holding
		// the snapshot here is what hid the remote text and then flushed the stale
		// copy under the node that had since been adopted.
		const snapshot: PaneSnapshot = { markdown: AT_SWITCH, basis: AT_SWITCH };
		expect(activePaneSnapshot(snapshot, REMOTE)).toBeNull();
	});

	it("drops a snapshot taken before the first projection existed", () => {
		const snapshot: PaneSnapshot = { markdown: AT_SWITCH, basis: null };
		expect(activePaneSnapshot(snapshot, REMOTE)).toBeNull();
		// ...and keeps it while the document is still undecided.
		expect(activePaneSnapshot(snapshot, null)).toBe(AT_SWITCH);
	});

	it("honours a snapshot of empty text", () => {
		// Deleting everything before switching lens is a real snapshot, not an
		// absent one.
		const snapshot: PaneSnapshot = { markdown: "", basis: AT_SWITCH };
		expect(activePaneSnapshot(snapshot, AT_SWITCH)).toBe("");
	});
});
