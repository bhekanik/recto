import { describe, expect, it } from "vitest";

import { activePaneSnapshot, type PaneSnapshot } from "./pane-snapshot";

const AT_SWITCH = "text the writer had when they switched to preview";
const HOST_A = "host-a:doc-1:3";
const HOST_A_NEXT = "host-a:doc-1:4";

describe("activePaneSnapshot", () => {
	it("has nothing to honour before a mode switch", () => {
		expect(activePaneSnapshot(null, HOST_A)).toBeNull();
	});

	it("honours the snapshot until the next publication", () => {
		const snapshot: PaneSnapshot = {
			markdown: AT_SWITCH,
			basisGeneration: HOST_A,
		};
		expect(activePaneSnapshot(snapshot, HOST_A)).toBe(AT_SWITCH);
	});

	it("drops the snapshot as soon as anything else is published", () => {
		// preview -> remote update -> raw. Holding the snapshot here hid the
		// remote text and then flushed the stale copy under the adopted node.
		const snapshot: PaneSnapshot = {
			markdown: AT_SWITCH,
			basisGeneration: HOST_A,
		};
		expect(activePaneSnapshot(snapshot, HOST_A_NEXT)).toBeNull();
	});

	it("never reactivates a superseded snapshot", () => {
		// The reason this is not the markdown: an undo republishes the exact text
		// the snapshot was taken against, and equality would bring a snapshot the
		// writer had long moved past back to life.
		const snapshot: PaneSnapshot = {
			markdown: AT_SWITCH,
			basisGeneration: HOST_A,
		};
		expect(activePaneSnapshot(snapshot, HOST_A_NEXT)).toBeNull();
		expect(activePaneSnapshot(snapshot, "host-a:doc-1:5")).toBeNull();
	});

	it("never matches another document's publication", () => {
		// A pane outlives the document it was showing. Keyed on a bare counter,
		// this snapshot of document 1 matched document 2's first publication and
		// was flushed under document 2's head.
		const snapshot: PaneSnapshot = {
			markdown: AT_SWITCH,
			basisGeneration: "host-a:doc-1:0",
		};
		expect(activePaneSnapshot(snapshot, "host-a:doc-2:0")).toBeNull();
	});

	it("never matches a publication from a host that replaced this one", () => {
		// Same collision from the other direction: the host remounts, its counter
		// restarts, and a snapshot from the previous instance matched.
		const snapshot: PaneSnapshot = {
			markdown: AT_SWITCH,
			basisGeneration: "host-a:doc-1:0",
		};
		expect(activePaneSnapshot(snapshot, "host-b:doc-1:0")).toBeNull();
	});

	it("honours a snapshot of empty text", () => {
		// Deleting everything before switching lens is a real snapshot, not an
		// absent one.
		const snapshot: PaneSnapshot = { markdown: "", basisGeneration: HOST_A };
		expect(activePaneSnapshot(snapshot, HOST_A)).toBe("");
	});
});
