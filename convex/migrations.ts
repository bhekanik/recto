import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { claimBlob } from "./accountPurge";

/**
 * One-shot backfills for the two fields ADR-21 added that existing rows cannot
 * derive on their own. Both are internal mutations run once after deploy
 * (`bunx convex run --prod migrations:… '{}'`), both are idempotent, and both
 * are bounded so they can be run repeatedly until they report `done`.
 *
 * Neither is on any request path. Without them, account deletion is correct for
 * everything created after this deploy and conservatively incomplete for what
 * came before — which is the right way round.
 */

const BACKFILL_BATCH = 256;

/** `review:<userId>` is the origin `review.reviewerAppend` has always written. */
const REVIEW_ORIGIN_PREFIX = "review:";

/**
 * Copy the reviewer id out of `docNodes.origin` into the indexed
 * `authorUserId`, for suggestion nodes written before that field existed.
 *
 * Scans forward through `docNodes` by creation time; `cursorCreationTime` is
 * the `_creationTime` the last call stopped at. Nodes whose origin is not a
 * `review:` tag are skipped — owner-authored nodes have no separate author.
 */
export const backfillNodeAuthors = internalMutation({
	args: {
		cursorCreationTime: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = Math.max(
			1,
			Math.min(args.limit ?? BACKFILL_BATCH, BACKFILL_BATCH),
		);
		const cursor = args.cursorCreationTime ?? 0;

		const nodes = await ctx.db
			.query("docNodes")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);

		let updated = 0;
		for (const node of nodes) {
			if (node.authorUserId !== undefined) continue;
			if (!node.origin.startsWith(REVIEW_ORIGIN_PREFIX)) continue;
			const reviewer = node.origin.slice(REVIEW_ORIGIN_PREFIX.length);
			if (!reviewer) continue;
			await ctx.db.patch(node._id, { authorUserId: reviewer });
			updated += 1;
		}

		const last = nodes.at(-1);
		return {
			scanned: nodes.length,
			updated,
			cursorCreationTime: last?._creationTime ?? cursor,
			done: nodes.length < limit,
		};
	},
});

/**
 * Attribute stored blobs that predate the `blobs` table.
 *
 * Ownership is inferred the only way it can be for an existing file — whose
 * text mentions its served URL — and **conservatively**: a file referenced by
 * more than one user's documents or history is left unattributed, so no
 * account deletion can take a file another account is still using. An
 * unattributed file is not lost; it stays reachable and the daily orphan sweep
 * collects it once nothing references it.
 *
 * Reads every document and node once per call, so it is bounded by `limit`
 * files per call rather than by the corpus: run it until `done`.
 */
export const backfillBlobOwners = internalMutation({
	args: {
		cursorCreationTime: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = Math.max(1, Math.min(args.limit ?? 64, 64));
		const cursor = args.cursorCreationTime ?? 0;

		const files = await ctx.db.system
			.query("_storage")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);
		if (files.length === 0) {
			return {
				scanned: 0,
				claimed: 0,
				shared: 0,
				cursorCreationTime: cursor,
				done: true,
			};
		}

		// Texts that can name a file, tagged with the user they belong to. Both
		// live markdown and history count: an image referenced only by an old
		// version is still that user's file.
		const texts: { userId: string; text: string }[] = [];
		const ownerByDocument = new Map<string, string>();
		for (const doc of await ctx.db.query("documents").collect()) {
			ownerByDocument.set(doc._id, doc.userId);
			texts.push({ userId: doc.userId, text: doc.markdown });
		}
		for (const node of await ctx.db.query("docNodes").collect()) {
			const owner = ownerByDocument.get(node.documentId);
			if (!owner) continue;
			texts.push({ userId: owner, text: node.patch });
			if (node.snapshot !== undefined) {
				texts.push({ userId: owner, text: node.snapshot });
			}
		}

		let claimed = 0;
		let shared = 0;
		for (const file of files) {
			const existing = await ctx.db
				.query("blobs")
				.withIndex("by_storage", (q) => q.eq("storageId", file._id))
				.unique();
			if (existing) continue;

			// The served URL's last segment is what a client actually inserts; the
			// raw id is checked too, as `files.orphanSweep` does.
			const url = await ctx.storage.getUrl(file._id);
			const segment =
				url === null ? null : new URL(url).pathname.split("/").pop();
			const id: string = file._id;

			const owners = new Set<string>();
			for (const entry of texts) {
				if (
					(segment && entry.text.includes(segment)) ||
					entry.text.includes(id)
				) {
					owners.add(entry.userId);
				}
			}

			if (owners.size !== 1) {
				// Zero owners: nothing references it, so the orphan sweep owns it.
				// More than one: shared between accounts, and guessing would let one
				// deletion take the other's file. Leave it unattributed either way.
				if (owners.size > 1) shared += 1;
				continue;
			}
			const [owner] = owners;
			if (owner && (await claimBlob(ctx, file._id, owner, "upload")))
				claimed += 1;
		}

		const last = files.at(-1);
		return {
			scanned: files.length,
			claimed,
			shared,
			cursorCreationTime: last?._creationTime ?? cursor,
			done: files.length < limit,
		};
	},
});
