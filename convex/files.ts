import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { assertNotDeleting } from "./accountGuard";
import { requireUserId } from "./documents";

/**
 * Image (and other blob) storage lives in Convex's built-in `_storage` system
 * table — NOT inline in the Markdown string, whose ~1 MiB ceiling governs the
 * document text only (overview §8). The client uploads bytes through the HTTP
 * action and inserts its canonical `![alt](url)` reference.
 */

/**
 * Compatibility URL for tabs loaded before `/upload-image` shipped.
 *
 * Old code still asks this mutation for a URL and POSTs bytes to it. Returning
 * another signed storage URL would preserve the account-deletion race, so this
 * returns a one-hour capability URL handled by our own HTTP action. That action
 * stores and claims the file before replying with the same `{storageId}` shape
 * the old client expects.
 */
export const LEGACY_UPLOAD_GRANT_MS = 60 * 60 * 1000;
export const LEGACY_SIGNED_UPLOAD_CUTOVER_MS = 60 * 60 * 1000;
const LEGACY_SIGNED_UPLOAD_CUTOVER = "signed-storage-upload-v1";

export const generateUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const siteUrl = process.env.CONVEX_SITE_URL;
		if (!siteUrl) throw new Error("CONVEX_SITE_URL is unavailable");
		const token = crypto.randomUUID();
		await ctx.db.insert("legacyUploadGrants", {
			token,
			userId,
			expiresAt: Date.now() + LEGACY_UPLOAD_GRANT_MS,
		});
		return new URL(
			`/upload-image-legacy?token=${encodeURIComponent(token)}`,
			siteUrl,
		).toString();
	},
});

/**
 * Ceiling on one uploaded file. Convex storage itself allows far more; this is
 * about what a writing app should accept inline, and it keeps a single request
 * bounded.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const UPLOAD_TOO_LARGE_MESSAGE =
	"That image is too large to upload (20 MiB limit).";

/**
 * Claim a blob the HTTP upload action has just stored, and return its URL.
 * Internal because the storage id comes from the action that created it, and
 * the user id from the JWT that action already verified.
 */
export const claimUpload = internalMutation({
	args: { storageId: v.id("_storage"), userId: v.string() },
	handler: async (ctx, args) => {
		// Same fence as every user-facing mutation: an upload started before a
		// deletion must not land a file the purge has already been past.
		await assertNotDeleting(ctx, args.userId);
		const existing = await ctx.db
			.query("blobs")
			.withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
			.unique();
		if (!existing) {
			await ctx.db.insert("blobs", {
				storageId: args.storageId,
				ownerUserId: args.userId,
				kind: "upload",
				createdAt: Date.now(),
			});
		}
		return await ctx.storage.getUrl(args.storageId);
	},
});

/** Consume the capability returned to a pre-deploy browser tab. */
export const consumeLegacyUpload = internalMutation({
	args: { token: v.string(), storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		const grant = await ctx.db
			.query("legacyUploadGrants")
			.withIndex("by_token", (q) => q.eq("token", args.token))
			.unique();
		if (!grant || grant.expiresAt <= Date.now()) {
			if (grant) await ctx.db.delete(grant._id);
			return { accepted: false as const, url: null };
		}
		await assertNotDeleting(ctx, grant.userId);
		const url = await ctx.storage.getUrl(args.storageId);
		if (url === null) {
			await ctx.db.delete(grant._id);
			return { accepted: false as const, url: null };
		}
		const existing = await ctx.db
			.query("blobs")
			.withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
			.unique();
		if (!existing) {
			await ctx.db.insert("blobs", {
				storageId: args.storageId,
				ownerUserId: grant.userId,
				kind: "upload",
				createdAt: Date.now(),
			});
		}
		await ctx.db.delete(grant._id);
		return {
			accepted: true as const,
			url,
		};
	},
});

export const sweepLegacyUploadGrants = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const expired = await ctx.db
			.query("legacyUploadGrants")
			.withIndex("by_expires", (q) => q.lte("expiresAt", Date.now()))
			.take(Math.max(1, Math.min(args.limit ?? 256, 256)));
		for (const grant of expired) await ctx.db.delete(grant._id);
		return { deleted: expired.length };
	},
});

/**
 * Start the deploy cutover for signed URLs issued by the previous backend.
 * Repeated cron/manual calls preserve the first timestamp; moving it forward
 * would keep deletion disabled forever.
 */
export const startLegacyUploadCutover = internalMutation({
	args: {},
	handler: async (ctx) => {
		const existing = await ctx.db
			.query("legacyUploadCutovers")
			.withIndex("by_name", (q) => q.eq("name", LEGACY_SIGNED_UPLOAD_CUTOVER))
			.unique();
		if (existing) return { safeAfter: existing.safeAfter, started: false };
		const safeAfter = Date.now() + LEGACY_SIGNED_UPLOAD_CUTOVER_MS;
		await ctx.db.insert("legacyUploadCutovers", {
			name: LEGACY_SIGNED_UPLOAD_CUTOVER,
			safeAfter,
		});
		return { safeAfter, started: true };
	},
});

export const getLegacyUploadCutover = internalQuery({
	args: {},
	handler: async (ctx) => {
		const row = await ctx.db
			.query("legacyUploadCutovers")
			.withIndex("by_name", (q) => q.eq("name", LEGACY_SIGNED_UPLOAD_CUTOVER))
			.unique();
		return row ? { safeAfter: row.safeAfter } : null;
	},
});

/**
 * Record who owns a freshly uploaded blob, and hand back its servable URL.
 *
 * The signed-upload-URL pattern means the bytes never pass through a mutation,
 * so this is the first moment the server learns the storage id exists. Without
 * it a blob has no owner at all: account deletion would have to guess from
 * "whose markdown mentions this URL", which deletes someone else's file as soon
 * as a URL is shared and misses files referenced only from history (ADR-21).
 *
 * Replaces the `getImageUrl` round trip the upload path used to make — same one
 * call, now with ownership recorded. Idempotent on `storageId`.
 */
export const registerUpload = mutation({
	args: { storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);

		const existing = await ctx.db
			.query("blobs")
			.withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
			.unique();
		if (!existing) {
			await ctx.db.insert("blobs", {
				storageId: args.storageId,
				ownerUserId: userId,
				kind: "upload",
				createdAt: Date.now(),
			});
		}

		return await ctx.storage.getUrl(args.storageId);
	},
});

/**
 * Record ownership of a generated export blob. Called by the `export.docx`
 * action, which cannot write to the database itself; `userId` comes from the
 * JWT the action already verified, never from a caller argument.
 */
export const registerExport = internalMutation({
	args: { storageId: v.id("_storage"), userId: v.string() },
	handler: async (ctx, args) => {
		// The action authenticated before rendering, which can take long enough
		// for a deletion to run to completion underneath it. Without this the
		// export would register — and hand out a working bearer URL — for an
		// account that no longer exists. Throwing here makes `export.docx`'s
		// catch delete the file it just stored.
		await assertNotDeleting(ctx, args.userId);
		const existing = await ctx.db
			.query("blobs")
			.withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
			.unique();
		if (existing) return;
		await ctx.db.insert("blobs", {
			storageId: args.storageId,
			ownerUserId: args.userId,
			kind: "export",
			createdAt: Date.now(),
		});
	},
});

/** Resolve a stored file id to a servable URL (null if missing). Auth-gated. */
export const getImageUrl = query({
	args: { storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		await requireUserId(ctx);
		return await ctx.storage.getUrl(args.storageId);
	},
});

/**
 * Grace window before an unreferenced blob may be deleted. Prevents racing an
 * upload whose `![alt](url)` markdown insert hasn't synced yet (the client
 * uploads bytes first, then writes the reference). 24h is deliberate — longer
 * than the sync debounce + any plausible offline window; don't shorten it
 * (plan 013 maintenance notes).
 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Orphaned-blob GC sweep (plan 013), run daily by cron. A stored file is
 * referenced iff the last path segment of its SERVED URL appears as a substring
 * of some reachable markdown. The served URL embeds a storage UUID distinct
 * from the `_storage` document id (verified live 2026-07-05: doc id
 * `kg2...yj43` served as `.../api/storage/43175506-...`), which is why the
 * check resolves each candidate via `ctx.storage.getUrl` instead of matching
 * `_id` — an `_id` substring check never matches what the client actually
 * inserts (lib/editor/image-upload.ts inserts the served URL). The raw `_id`
 * is still checked as belt-and-braces for any markdown that ever embedded a
 * raw id. Reachable markdown lives in TWO places: `documents.markdown` (live
 * text) and `docNodes` rows (snapshots + patch inserts — history that restore
 * can resurrect, so a history-only reference still counts). Patches are plain
 * JSON `{from,to,insert}` strings, so the substring check sees them.
 *
 * Deletes every file that is (a) unreferenced AND (b) older than the grace
 * window. Files whose URL cannot be resolved are SKIPPED (conservative — never
 * delete what you can't resolve). `graceMs` is overridable for tests only —
 * never weaken the default.
 */
export const orphanSweep = internalMutation({
	args: { graceMs: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const cutoff = Date.now() - (args.graceMs ?? ORPHAN_GRACE_MS);

		// One pass over all reference-bearing texts (single-user-small corpus).
		const texts: string[] = [];
		for (const doc of await ctx.db.query("documents").collect()) {
			texts.push(doc.markdown);
		}
		for (const node of await ctx.db.query("docNodes").collect()) {
			texts.push(node.patch);
			if (node.snapshot !== undefined) texts.push(node.snapshot);
		}

		const files = await ctx.db.system.query("_storage").collect();
		let deleted = 0;
		for (const file of files) {
			if (file._creationTime >= cutoff) continue; // within grace window
			// Resolve the served URL only past the grace cutoff (getUrl per file is
			// the expensive part; the grace window filters most candidates).
			const url = await ctx.storage.getUrl(file._id);
			if (url === null) continue; // unresolvable — skip, never delete blind
			const segment = new URL(url).pathname.split("/").pop();
			const id: string = file._id;
			const referenced = texts.some(
				(text) => (!!segment && text.includes(segment)) || text.includes(id),
			);
			if (!referenced) {
				await deleteBlobRow(ctx, file._id);
				await ctx.storage.delete(file._id);
				deleted += 1;
			}
		}

		return { scanned: files.length, deleted };
	},
});

/**
 * Delete one stored blob. Used by the scheduler to expire a generated `.docx`
 * (convex/export.ts).
 *
 * `ctx.storage.delete` throws "Delete on non-existent doc" for a file that is
 * already gone, and an expiry can genuinely fire after the account purge or an
 * earlier sweep removed the same blob. That is the outcome this wanted, not a
 * failure worth retrying, so the row is checked first.
 */
export const deleteStoredFile = internalMutation({
	args: { storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		await deleteBlobRow(ctx, args.storageId);
		const existing = await ctx.db.system.get(args.storageId);
		if (existing === null) return;
		await ctx.storage.delete(args.storageId);
	},
});

/**
 * Drop the ownership row for a blob that is going away. Every path that deletes
 * a stored file goes through this, or `blobs` accumulates rows pointing at
 * storage ids that no longer exist and the account purge keeps "finding" work.
 */
export async function deleteBlobRow(
	ctx: GenericMutationCtx<DataModel>,
	storageId: Id<"_storage">,
): Promise<void> {
	const row = await ctx.db
		.query("blobs")
		.withIndex("by_storage", (q) => q.eq("storageId", storageId))
		.unique();
	if (row) await ctx.db.delete(row._id);
}
