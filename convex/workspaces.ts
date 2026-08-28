import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireUserId, utf8Length } from "./documents";

type QueryCtx = GenericQueryCtx<import("./_generated/dataModel").DataModel>;
type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

/**
 * Pane layout storage. Two shapes share this table during the migration to
 * per-device rows (plan 023 §4.1(3), ADR-21):
 *
 *  - LEGACY (`get` / `save`): one row per user, columns spelled out. Still
 *    served because a browser tab loaded before the migration keeps calling it,
 *    and because the new per-device path hydrates from it on a device's first
 *    run so nobody's layout resets on deploy day.
 *  - PER DEVICE (`getForDevice` / `saveForDevice` / `listForUser`): one row per
 *    (userId, deviceId), layout carried as an opaque JSON string.
 *
 * A Mac's four-way split is not a layout an iPhone can render, so sharing one
 * row across devices meant each device overwrote the others on every focus
 * change. Moving to another device's layout is now an explicit action —
 * `listForUser` to offer it, `getForDevice` to fetch it.
 */

/**
 * Ceiling on a device row's layout blob. The web's serialized tree is a few kB
 * (pane geometry plus per-pane scroll/selection); 256 KiB leaves room for a
 * many-pane Mac window and still fails loudly well under the Convex ~1 MiB
 * per-value limit.
 */
export const MAX_WORKSPACE_BYTES = 256 * 1024;

export const WORKSPACE_TOO_LARGE_MESSAGE =
	"Workspace layout is too large (256 KiB limit).";

/**
 * Most device rows a user keeps. Device ids live in device storage, so clearing
 * a browser's site data or reinstalling an app mints a new one; without a cap
 * the "resume from…" list grows forever with dead entries. On overflow the
 * least recently updated row is dropped — the device that has not been used in
 * longest is the one whose layout is least worth keeping.
 */
export const MAX_DEVICE_ROWS = 32;

const MAX_DEVICE_ID_LENGTH = 64;

/** `v.string()` accepts "", which would collide every anonymous client onto one row. */
function requireDeviceId(deviceId: string): string {
	if (deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH) {
		throw new Error("Invalid deviceId");
	}
	return deviceId;
}

const deviceClassValidator = v.union(
	v.literal("mac"),
	v.literal("ipad"),
	v.literal("iphone"),
	v.literal("web"),
);

/**
 * The user's legacy (device-less) row. Read by scanning their rows rather than
 * `.unique()` on `by_user`: once a device row exists there is more than one row
 * per user, and `.unique()` would throw inside the deployed client's own save.
 */
async function findLegacyRow(
	ctx: QueryCtx | MutationCtx,
	userId: string,
): Promise<Doc<"workspaces"> | null> {
	const rows = await ctx.db
		.query("workspaces")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.collect();
	return rows.find((row) => row.deviceId === undefined) ?? null;
}

/**
 * LEGACY: the single device-less workspace row, or null.
 *
 * Kept for tabs loaded before the per-device migration, and read once by each
 * migrating client to seed its own device row.
 */
export const get = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const row = await findLegacyRow(ctx, userId);

		// A row missing the legacy columns is not a legacy row; treat it as absent
		// rather than handing the caller a half-populated layout.
		if (
			!row ||
			row.paneTree === undefined ||
			row.activePaneId === undefined ||
			row.perPaneViewState === undefined
		) {
			return null;
		}

		return {
			_id: row._id,
			paneTree: row.paneTree,
			openDocumentIds: row.openDocumentIds ?? [],
			activePaneId: row.activePaneId,
			perPaneViewState: row.perPaneViewState,
			updatedAt: row.updatedAt,
		};
	},
});

/** LEGACY: upsert the device-less row (last-write-wins on the whole row). */
export const save = mutation({
	args: {
		paneTree: v.string(),
		openDocumentIds: v.array(v.id("documents")),
		activePaneId: v.string(),
		perPaneViewState: v.string(),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const updatedAt = Date.now();
		const existing = await findLegacyRow(ctx, userId);

		if (existing) {
			await ctx.db.patch(existing._id, { ...args, updatedAt });
			return { updatedAt };
		}

		await ctx.db.insert("workspaces", { userId, ...args, updatedAt });
		return { updatedAt };
	},
});

async function findDeviceRow(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	deviceId: string,
): Promise<Doc<"workspaces"> | null> {
	return await ctx.db
		.query("workspaces")
		.withIndex("by_user_device", (q) =>
			q.eq("userId", userId).eq("deviceId", deviceId),
		)
		.unique();
}

/** This device's stored layout, or null if it has never saved one. */
export const getForDevice = query({
	args: { deviceId: v.string() },
	handler: async (ctx, args) => {
		requireDeviceId(args.deviceId);
		const userId = await requireUserId(ctx);
		const row = await findDeviceRow(ctx, userId, args.deviceId);
		if (!row || row.json === undefined || row.deviceClass === undefined) {
			return null;
		}
		return {
			deviceId: args.deviceId,
			deviceClass: row.deviceClass,
			json: row.json,
			updatedAt: row.updatedAt,
		};
	},
});

/**
 * Upsert this device's layout. Last-write-wins with no compare-and-set: the
 * only writers of a device row are that device's own windows, and a stale
 * layout is not worth a conflict protocol the caller would have to resolve
 * by… taking the newest layout.
 */
export const saveForDevice = mutation({
	args: {
		deviceId: v.string(),
		deviceClass: deviceClassValidator,
		json: v.string(),
	},
	handler: async (ctx, args) => {
		requireDeviceId(args.deviceId);
		if (utf8Length(args.json) > MAX_WORKSPACE_BYTES) {
			throw new Error(WORKSPACE_TOO_LARGE_MESSAGE);
		}
		const userId = await requireUserId(ctx);
		const updatedAt = Date.now();

		const existing = await findDeviceRow(ctx, userId, args.deviceId);
		if (existing) {
			await ctx.db.patch(existing._id, {
				deviceClass: args.deviceClass,
				json: args.json,
				updatedAt,
			});
			return { updatedAt };
		}

		await ctx.db.insert("workspaces", {
			userId,
			deviceId: args.deviceId,
			deviceClass: args.deviceClass,
			json: args.json,
			updatedAt,
		});

		const deviceRows = (
			await ctx.db
				.query("workspaces")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.collect()
		).filter((row) => row.deviceId !== undefined);

		if (deviceRows.length > MAX_DEVICE_ROWS) {
			const stale = deviceRows
				.sort((a, b) => a.updatedAt - b.updatedAt)
				.slice(0, deviceRows.length - MAX_DEVICE_ROWS);
			for (const row of stale) await ctx.db.delete(row._id);
		}

		return { updatedAt };
	},
});

/**
 * Every device that has stored a layout, newest first — the menu behind
 * "Resume from <device> layout". Metadata only; the caller fetches the layout
 * it picks with `getForDevice`, so opening the menu does not ship every
 * device's tree.
 */
export const listForUser = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const rows = await ctx.db
			.query("workspaces")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();

		// flatMap rather than filter+map: the legacy row's `deviceId` and
		// `deviceClass` really are absent, and building the result inside the
		// narrowing is what lets the compiler see that, instead of a cast
		// asserting it.
		return rows
			.flatMap((row) =>
				row.deviceId !== undefined && row.deviceClass !== undefined
					? [
							{
								deviceId: row.deviceId,
								deviceClass: row.deviceClass,
								updatedAt: row.updatedAt,
							},
						]
					: [],
			)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	},
});
