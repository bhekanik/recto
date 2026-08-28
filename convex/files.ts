import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { assertNotDeleting } from "./accountGuard";
import { requireUserId } from "./documents";

/**
 * Image (and other blob) storage lives in Convex's built-in `_storage` system
 * table — NOT inline in the Markdown string, whose ~1 MiB ceiling governs the
 * document text only (overview §8). The client uploads bytes to a signed,
 * short-lived URL and inserts a canonical `![alt](url)` reference.
 */

/**
 * LEGACY signed-upload URL. Superseded by the `/upload-image` HTTP action
 * (`convex/http.ts`), which stores the bytes and claims ownership in one
 * server-side step.
 *
 * The two-step protocol could not be made correct: the bytes land in
 * `_storage` when the client POSTs them, and ownership was only recorded by a
 * separate `registerUpload` call afterwards. A crash, a rejected mutation, a
 * closed tab — or a browser tab still running the code deployed before this
 * change — leaves a file nothing can attribute, which account deletion then
 * cannot find. Kept only so those tabs keep working until they age out; it is
 * not used by this build.
 */
export const generateUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		await requireUserId(ctx); // single-user; only the owner may upload
		return await ctx.storage.generateUploadUrl();
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
