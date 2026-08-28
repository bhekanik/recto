import { describe, expect, it } from "vitest";

import {
	describeDiscards,
	displaySyncStatus,
	syncIndicatorProps,
} from "./sync-indicator";

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

describe("syncIndicatorProps", () => {
	const settled = {
		syncStatus: "saved" as const,
		hasPendingWrites: false,
		blockedWrite: null,
	};

	it("passes the shell's three facts through in one place", () => {
		// The mapping is what was wrong before: calling displaySyncStatus from a
		// test proved the rule but not that the shell fed it the right values, so
		// deleting the wiring left every status test green.
		expect(syncIndicatorProps(settled)).toEqual({
			syncStatus: "saved",
			blocked: false,
		});
		expect(syncIndicatorProps({ ...settled, hasPendingWrites: true })).toEqual({
			syncStatus: "unsynced",
			blocked: false,
		});
		expect(
			syncIndicatorProps({
				...settled,
				hasPendingWrites: true,
				blockedWrite: { message: "refused" },
			}),
		).toEqual({ syncStatus: "unresolved", blocked: true });
	});

	it("reports blocked from the write itself, not from the label", () => {
		// The control that opens the details is gated on this, so it must not be
		// inferred from the status — a document can read "unsynced" for ordinary
		// reasons with nothing for the writer to decide.
		expect(
			syncIndicatorProps({ ...settled, syncStatus: "unsynced" }).blocked,
		).toBe(false);
	});
});

describe("describeDiscards", () => {
	it("names the work by what the writer would lose", () => {
		expect(
			describeDiscards({
				commits: 2,
				aiCommits: 1,
				pointers: 1,
				versions: 1,
			}),
		).toEqual([
			"2 unsaved edits (1 from AI)",
			"1 saved version",
			"1 history move",
		]);
	});

	it("says nothing about kinds that are not queued", () => {
		expect(
			describeDiscards({ commits: 1, aiCommits: 0, pointers: 0, versions: 0 }),
		).toEqual(["1 unsaved edit"]);
		expect(
			describeDiscards({ commits: 0, aiCommits: 0, pointers: 0, versions: 0 }),
		).toEqual([]);
	});
});
