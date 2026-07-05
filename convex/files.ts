import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUserId } from "./documents";

/**
 * Image (and other blob) storage lives in Convex's built-in `_storage` system
 * table — NOT inline in the Markdown string, whose ~1 MiB ceiling governs the
 * document text only (overview §8). The client uploads bytes to a signed,
 * short-lived URL and inserts a canonical `![alt](url)` reference.
 */

/** Signed, short-lived URL the client POSTs the image bytes to. Auth-gated. */
export const generateUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		await requireUserId(ctx); // single-user; only the owner may upload
		return await ctx.storage.generateUploadUrl();
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
 * referenced iff its storage id appears as a substring of some reachable
 * markdown — servable URLs embed the id (`.../api/storage/<storageId>`).
 * Reachable markdown lives in TWO places: `documents.markdown` (live text) and
 * `docNodes` rows (snapshots + patch inserts — history that restore can
 * resurrect, so a history-only reference still counts). Patches are plain JSON
 * `{from,to,insert}` strings, so the substring check sees them.
 *
 * Deletes every file that is (a) unreferenced AND (b) older than the grace
 * window. `graceMs` is overridable for tests only — never weaken the default.
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
			const id: string = file._id;
			if (!texts.some((text) => text.includes(id))) {
				await ctx.storage.delete(file._id);
				deleted += 1;
			}
		}

		return { scanned: files.length, deleted };
	},
});
