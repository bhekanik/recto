import { describe, expect, it } from "vitest";

import { activePaneSnapshot, type PaneSnapshot } from "./pane-snapshot";

const AT_SWITCH = "text the writer had when they switched to preview";

describe("activePaneSnapshot", () => {
	it("has nothing to honour before a mode switch", () => {
		expect(activePaneSnapshot(null, 3)).toBeNull();
	});

	it("honours the snapshot until the next publication", () => {
		const snapshot: PaneSnapshot = { markdown: AT_SWITCH, basisGeneration: 3 };
		expect(activePaneSnapshot(snapshot, 3)).toBe(AT_SWITCH);
	});

	it("drops the snapshot as soon as anything else is published", () => {
		// preview -> remote update -> raw. Holding the snapshot here hid the
		// remote text and then flushed the stale copy under the adopted node.
		const snapshot: PaneSnapshot = { markdown: AT_SWITCH, basisGeneration: 3 };
		expect(activePaneSnapshot(snapshot, 4)).toBeNull();
	});

	it("never reactivates a superseded snapshot", () => {
		// The reason this is a counter and not the text: an undo republishes the
		// exact markdown the snapshot was taken against. Keyed on equality, a
		// snapshot the writer had long moved past would come back to life and
		// overwrite what they are looking at.
		const snapshot: PaneSnapshot = { markdown: AT_SWITCH, basisGeneration: 3 };
		expect(activePaneSnapshot(snapshot, 4)).toBeNull();
		// Generation 5 republishes AT_SWITCH — same text, later publication.
		expect(activePaneSnapshot(snapshot, 5)).toBeNull();
	});

	it("honours a snapshot of empty text", () => {
		// Deleting everything before switching lens is a real snapshot, not an
		// absent one.
		const snapshot: PaneSnapshot = { markdown: "", basisGeneration: 7 };
		expect(activePaneSnapshot(snapshot, 7)).toBe("");
	});
});
