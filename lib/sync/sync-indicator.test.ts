import { describe, expect, it } from "vitest";

import { displaySyncStatus } from "./sync-indicator";

describe("displaySyncStatus", () => {
	it("says nothing new when there is nothing outstanding", () => {
		expect(
			displaySyncStatus({
				status: "saved",
				hasPendingWrites: false,
				blocked: false,
			}),
		).toBe("saved");
	});

	it("never reports saved while the write queue still holds work", () => {
		// The autosave only knows about `documents.markdown`. A manual version tag
		// writes nothing there, so it was invisible: the writer saw "Saved" while
		// the version was still uncreated.
		expect(
			displaySyncStatus({
				status: "saved",
				hasPendingWrites: true,
				blocked: false,
			}),
		).toBe("unsynced");
		expect(
			displaySyncStatus({
				status: "idle",
				hasPendingWrites: true,
				blocked: false,
			}),
		).toBe("unsynced");
	});

	it("leaves a status that is already unsettled alone", () => {
		expect(
			displaySyncStatus({
				status: "saving",
				hasPendingWrites: true,
				blocked: false,
			}),
		).toBe("saving");
		expect(
			displaySyncStatus({
				status: "unsynced",
				hasPendingWrites: true,
				blocked: false,
			}),
		).toBe("unsynced");
	});

	it("reserves 'Not synced' for a write the server has refused", () => {
		// "Unsynced" clears on its own; this one cannot, and is the only status a
		// writer has to act on.
		for (const status of ["idle", "saving", "saved", "unsynced"] as const) {
			expect(
				displaySyncStatus({ status, hasPendingWrites: true, blocked: true }),
			).toBe("unresolved");
		}
	});
});
