import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
	MAX_DEVICE_ROWS,
	MAX_WORKSPACE_BYTES,
	WORKSPACE_TOO_LARGE_MESSAGE,
} from "./workspaces";

const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./workspaces.ts": () => import("./workspaces"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

const LEGACY_SAVE = {
	paneTree: '{"type":"pane","paneId":"p1"}',
	openDocumentIds: [],
	activePaneId: "p1",
	perPaneViewState: "{}",
};

describe("workspaces per-device rows", () => {
	it("requires authentication", async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.query(api.workspaces.getForDevice, { deviceId: "d1" }),
		).rejects.toThrow("Unauthenticated");
		await expect(
			t.mutation(api.workspaces.saveForDevice, {
				deviceId: "d1",
				deviceClass: "web",
				json: "{}",
			}),
		).rejects.toThrow("Unauthenticated");
		await expect(t.query(api.workspaces.listForUser, {})).rejects.toThrow(
			"Unauthenticated",
		);
	});

	it("round-trips one device's layout", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.workspaces.saveForDevice, {
			deviceId: "mac-1",
			deviceClass: "mac",
			json: '{"paneTree":"x"}',
		});

		expect(
			await owner.query(api.workspaces.getForDevice, { deviceId: "mac-1" }),
		).toMatchObject({
			deviceId: "mac-1",
			deviceClass: "mac",
			json: '{"paneTree":"x"}',
		});
	});

	it("keeps each device's layout separate", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.workspaces.saveForDevice, {
			deviceId: "mac-1",
			deviceClass: "mac",
			json: '{"where":"mac"}',
		});
		await owner.mutation(api.workspaces.saveForDevice, {
			deviceId: "phone-1",
			deviceClass: "iphone",
			json: '{"where":"phone"}',
		});

		const mac = await owner.query(api.workspaces.getForDevice, {
			deviceId: "mac-1",
		});
		expect(mac?.json).toBe('{"where":"mac"}');
		const phone = await owner.query(api.workspaces.getForDevice, {
			deviceId: "phone-1",
		});
		expect(phone?.json).toBe('{"where":"phone"}');
	});

	it("does not leak one user's device row to another user", async () => {
		const t = convexTest(schema, modules);
		await t.withIdentity(OWNER).mutation(api.workspaces.saveForDevice, {
			deviceId: "shared-id",
			deviceClass: "web",
			json: '{"secret":true}',
		});

		expect(
			await t
				.withIdentity(OTHER)
				.query(api.workspaces.getForDevice, { deviceId: "shared-id" }),
		).toBeNull();
	});

	it("rejects an empty deviceId", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		// v.string() accepts "", which would collide every client onto one row.
		await expect(
			owner.mutation(api.workspaces.saveForDevice, {
				deviceId: "",
				deviceClass: "web",
				json: "{}",
			}),
		).rejects.toThrow("Invalid deviceId");
		await expect(
			owner.query(api.workspaces.getForDevice, { deviceId: "" }),
		).rejects.toThrow("Invalid deviceId");
	});

	it("rejects an oversized layout", async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.withIdentity(OWNER).mutation(api.workspaces.saveForDevice, {
				deviceId: "mac-1",
				deviceClass: "mac",
				json: "x".repeat(MAX_WORKSPACE_BYTES + 1),
			}),
		).rejects.toThrow(WORKSPACE_TOO_LARGE_MESSAGE);
	});

	it("lists devices newest first, metadata only", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		// Real clock time: two saves in the same millisecond are genuinely tied,
		// and this asserts the ordering, not the tie-break.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
			await owner.mutation(api.workspaces.saveForDevice, {
				deviceId: "mac-1",
				deviceClass: "mac",
				json: "{}",
			});
			vi.setSystemTime(new Date("2026-08-28T11:00:00Z"));
			await owner.mutation(api.workspaces.saveForDevice, {
				deviceId: "ipad-1",
				deviceClass: "ipad",
				json: "{}",
			});
		} finally {
			vi.useRealTimers();
		}

		const listed = await owner.query(api.workspaces.listForUser, {});
		expect(listed.map((row) => row.deviceId)).toEqual(["ipad-1", "mac-1"]);
		expect(listed[0]).not.toHaveProperty("json");
	});

	it("drops the least recently used device once the cap is passed", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		for (let i = 0; i < MAX_DEVICE_ROWS + 3; i += 1) {
			await owner.mutation(api.workspaces.saveForDevice, {
				deviceId: `device-${i}`,
				deviceClass: "web",
				json: "{}",
			});
		}

		const listed = await owner.query(api.workspaces.listForUser, {});
		expect(listed).toHaveLength(MAX_DEVICE_ROWS);
		// The three oldest were evicted, the newest survive.
		expect(listed.map((row) => row.deviceId)).not.toContain("device-0");
		expect(listed.map((row) => row.deviceId)).toContain(
			`device-${MAX_DEVICE_ROWS + 2}`,
		);
	});
});

describe("workspaces legacy row alongside device rows", () => {
	it("keeps serving the legacy row after device rows exist", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.workspaces.save, LEGACY_SAVE);
		await owner.mutation(api.workspaces.saveForDevice, {
			deviceId: "web-1",
			deviceClass: "web",
			json: '{"paneTree":"device"}',
		});

		// `.unique()` on by_user would throw here — the legacy path has to find
		// its own row among the user's rows, not assume it is the only one.
		const legacy = await owner.query(api.workspaces.get, {});
		expect(legacy?.paneTree).toBe(LEGACY_SAVE.paneTree);
	});

	it("keeps updating the legacy row, not a device row, after the migration", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.workspaces.save, LEGACY_SAVE);
		await owner.mutation(api.workspaces.saveForDevice, {
			deviceId: "web-1",
			deviceClass: "web",
			json: '{"paneTree":"device"}',
		});
		await owner.mutation(api.workspaces.save, {
			...LEGACY_SAVE,
			activePaneId: "p2",
		});

		expect((await owner.query(api.workspaces.get, {}))?.activePaneId).toBe(
			"p2",
		);
		expect(
			(await owner.query(api.workspaces.getForDevice, { deviceId: "web-1" }))
				?.json,
		).toBe('{"paneTree":"device"}');
	});

	it("does not list the legacy row as a device", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.workspaces.save, LEGACY_SAVE);
		expect(await owner.query(api.workspaces.listForUser, {})).toEqual([]);
	});

	it("reports no legacy row when the user only has device rows", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.workspaces.saveForDevice, {
			deviceId: "web-1",
			deviceClass: "web",
			json: "{}",
		});
		expect(await owner.query(api.workspaces.get, {})).toBeNull();
	});
});
