import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId, utf8Length } from "./documents";

/**
 * Synced writer preferences (plan 023 §4.1(2), ADR-21).
 *
 * The server stores one opaque JSON object per user and never looks inside it.
 * That is deliberate: the settings shape changes with almost every feature, and
 * a validated column per setting would mean a schema migration each time, plus
 * a window where a native client that knows a key the server does not has that
 * key silently dropped. The client owns the shape; the server owns the row.
 *
 * The trade-off is that the server cannot merge two devices' writes, so this is
 * last-write-wins over the whole object, with an optional compare-and-set for
 * callers that would rather be told they lost than overwrite blindly.
 *
 * NOT every setting lives here — device-local preferences (light/dark, text
 * zoom, which panels are open) stay in device storage. The split and its
 * reasoning are in docs/blueprint/10-sync-persistence.md §8.
 */

/**
 * Ceiling on the stored blob. Settings are a few hundred bytes of flags; a
 * megabyte of them is a bug or an attempt to use the row as a document store.
 * Far below the Convex ~1 MiB per-value limit so this fails with a message the
 * client can show rather than an opaque transaction rejection.
 */
export const MAX_SETTINGS_BYTES = 64 * 1024;

export const SETTINGS_TOO_LARGE_MESSAGE =
	"Settings payload is too large (64 KiB limit).";

export const SETTINGS_NOT_OBJECT_MESSAGE =
	"settings.json must be a JSON object.";

/**
 * Reject anything that is not a JSON *object* — `v.string()` accepts "", and a
 * scalar or array would be parsed by every client into something it did not
 * expect. Cheap to check here; impossible to recover from once stored.
 */
function requireJsonObject(json: string): void {
	if (utf8Length(json) > MAX_SETTINGS_BYTES) {
		throw new Error(SETTINGS_TOO_LARGE_MESSAGE);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error(SETTINGS_NOT_OBJECT_MESSAGE);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(SETTINGS_NOT_OBJECT_MESSAGE);
	}
}

/** The authenticated user's settings row, or null if they have never saved. */
export const get = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const row = await ctx.db
			.query("settings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();
		if (!row) return null;
		return { json: row.json, updatedAt: row.updatedAt };
	},
});

/**
 * Write the whole settings object.
 *
 * Without `expectedUpdatedAt` this is plain last-write-wins. With it, the write
 * only lands if the row is still the one the caller read; otherwise nothing is
 * written and the caller gets the state that won, so it can merge and retry
 * instead of silently clobbering another device's change.
 */
export const save = mutation({
	args: {
		json: v.string(),
		/** The `updatedAt` the caller last read. Omit for unconditional LWW. */
		expectedUpdatedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		requireJsonObject(args.json);
		const userId = await requireUserId(ctx);

		const existing = await ctx.db
			.query("settings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();

		if (
			args.expectedUpdatedAt !== undefined &&
			args.expectedUpdatedAt !== (existing?.updatedAt ?? null)
		) {
			return {
				saved: false as const,
				conflict: true as const,
				json: existing?.json ?? null,
				updatedAt: existing?.updatedAt ?? null,
			};
		}

		// Strictly increasing, not just `Date.now()`: two saves inside the same
		// millisecond would otherwise share a stamp, and the second caller's CAS
		// against the first one's value would wrongly pass.
		const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);

		if (existing) {
			await ctx.db.patch(existing._id, { json: args.json, updatedAt });
		} else {
			await ctx.db.insert("settings", { userId, json: args.json, updatedAt });
		}

		return { saved: true as const, conflict: false as const, updatedAt };
	},
});
