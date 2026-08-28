import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { claimBlob } from "./accountPurge";
import { extractStorageTokens, storageFileTokens } from "./storageTokens";

type MutationCtx = GenericMutationCtx<DataModel>;

/**
 * One-shot backfills for the fields ADR-21 added that existing rows cannot
 * derive on their own. Each is an internal mutation run after deploy
 * (`bunx convex run --prod migrations:… '{}'`), each is idempotent, and each is
 * bounded so it can be run repeatedly until it reports `done`.
 *
 * Progress lives in `migrationProgress` rather than in the caller's hands: a
 * cursor the operator has to copy back in is a cursor that gets lost halfway
 * through, and these are exactly the jobs nobody runs twice on purpose.
 *
 * None of them is on any request path. Without them, account deletion is
 * correct for everything created after this deploy and conservatively
 * incomplete for what came before — which is the right way round.
 */

const BACKFILL_BATCH = 256;

/** `review:<userId>` is the origin `review.reviewerAppend` has always written. */
const REVIEW_ORIGIN_PREFIX = "review:";

async function readCursor(ctx: MutationCtx, name: string): Promise<number> {
	const row = await ctx.db
		.query("migrationProgress")
		.withIndex("by_name", (q) => q.eq("name", name))
		.unique();
	return row?.cursor ?? 0;
}

async function writeCursor(
	ctx: MutationCtx,
	name: string,
	cursor: number,
	done: boolean,
): Promise<void> {
	const row = await ctx.db
		.query("migrationProgress")
		.withIndex("by_name", (q) => q.eq("name", name))
		.unique();
	const now = Date.now();
	if (row) await ctx.db.patch(row._id, { cursor, done, updatedAt: now });
	else
		await ctx.db.insert("migrationProgress", {
			name,
			cursor,
			done,
			updatedAt: now,
		});
}

function clampLimit(limit: number | undefined, max: number): number {
	return Math.max(1, Math.min(limit ?? max, max));
}

/**
 * Copy the reviewer id out of `docNodes.origin` into the indexed
 * `authorUserId`, for suggestion nodes written before that field existed.
 * Nodes whose origin is not a `review:` tag are skipped — owner-authored nodes
 * have no separate author.
 */
export const backfillNodeAuthors = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const name = "backfillNodeAuthors";
		const limit = clampLimit(args.limit, BACKFILL_BATCH);
		const cursor = await readCursor(ctx, name);

		const nodes = await ctx.db
			.query("docNodes")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);

		let updated = 0;
		for (const node of nodes) {
			if (node.authorUserId !== undefined) continue;
			if (!node.origin.startsWith(REVIEW_ORIGIN_PREFIX)) continue;
			const reviewer = node.origin.slice(REVIEW_ORIGIN_PREFIX.length);
			if (!reviewer || reviewer === "deleted-user") continue;
			await ctx.db.patch(node._id, { authorUserId: reviewer });
			updated += 1;
		}

		const done = nodes.length < limit;
		await writeCursor(ctx, name, nodes.at(-1)?._creationTime ?? cursor, done);
		return { scanned: nodes.length, updated, done };
	},
});

/**
 * Attach `branchId` to suggestion nodes by walking each review branch from its
 * head back to its base — the only record of which nodes belong to a branch,
 * since branch membership was never stored.
 *
 * Without this, deletion falls back to the coarser "did this reviewer have ANY
 * accepted branch on this document" rule, which keeps a reviewer's rejected
 * work alongside their accepted work. Nodes whose branch cannot be derived
 * (the chain is broken, or the branch row is already gone) keep that fallback.
 */
export const backfillNodeBranches = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const name = "backfillNodeBranches";
		// Each branch costs a walk of its own length, so far fewer per pass.
		const limit = clampLimit(args.limit, 32);
		const cursor = await readCursor(ctx, name);

		const branches = await ctx.db
			.query("reviewBranches")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);

		let updated = 0;
		for (const branch of branches) {
			let nodeId: string | null = branch.headNodeId;
			// Bounded: a branch deeper than this is not one this backfill will
			// finish, and the fallback rule still covers it.
			for (let step = 0; step < 512 && nodeId !== null; step += 1) {
				if (nodeId === branch.baseNodeId) break;
				const node = await ctx.db
					.query("docNodes")
					.withIndex("by_document_node", (q) =>
						q
							.eq("documentId", branch.documentId)
							.eq("nodeId", nodeId as string),
					)
					.unique();
				if (!node) break;
				if (node.branchId === undefined && node.authorUserId !== undefined) {
					await ctx.db.patch(node._id, { branchId: branch._id });
					updated += 1;
				}
				nodeId = node.parentNodeId;
			}
		}

		const done = branches.length < limit;
		await writeCursor(
			ctx,
			name,
			branches.at(-1)?._creationTime ?? cursor,
			done,
		);
		return { scanned: branches.length, updated, done };
	},
});

// ---------------------------------------------------------------------------
// Blob ownership: reference rows first, then claims
// ---------------------------------------------------------------------------

/**
 * Step 1 of the blob-owner backfill: record which user's text mentions which
 * storage token, one bounded batch of documents at a time.
 *
 * The first version of this read EVERY document and EVERY history node on each
 * 64-file batch, which is the shape that blows the per-transaction read limits
 * on any real corpus — and it did that work again for every batch. Building
 * `blobRefs` once, incrementally, makes step 2 a bounded index lookup per file.
 */
export const scanDocumentRefs = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const name = "scanDocumentRefs";
		const limit = clampLimit(args.limit, BACKFILL_BATCH);
		const cursor = await readCursor(ctx, name);

		const documents = await ctx.db
			.query("documents")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);

		let recorded = 0;
		for (const doc of documents) {
			for (const token of extractStorageTokens(doc.markdown)) {
				if (await recordRef(ctx, token, doc.userId)) recorded += 1;
			}
		}

		const done = documents.length < limit;
		await writeCursor(
			ctx,
			name,
			documents.at(-1)?._creationTime ?? cursor,
			done,
		);
		return { scanned: documents.length, recorded, done };
	},
});

/** Step 1b: the same, over history. An image can be referenced only from a node. */
export const scanNodeRefs = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const name = "scanNodeRefs";
		const limit = clampLimit(args.limit, BACKFILL_BATCH);
		const cursor = await readCursor(ctx, name);

		const nodes = await ctx.db
			.query("docNodes")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);

		let recorded = 0;
		const ownerCache = new Map<string, string | null>();
		for (const node of nodes) {
			let owner = ownerCache.get(node.documentId);
			if (owner === undefined) {
				owner = (await ctx.db.get(node.documentId))?.userId ?? null;
				ownerCache.set(node.documentId, owner);
			}
			if (owner === null) continue;
			const texts = [node.patch];
			if (node.snapshot !== undefined) texts.push(node.snapshot);
			for (const text of texts) {
				for (const token of extractStorageTokens(text)) {
					if (await recordRef(ctx, token, owner)) recorded += 1;
				}
			}
		}

		const done = nodes.length < limit;
		await writeCursor(ctx, name, nodes.at(-1)?._creationTime ?? cursor, done);
		return { scanned: nodes.length, recorded, done };
	},
});

async function recordRef(
	ctx: MutationCtx,
	token: string,
	ownerUserId: string,
): Promise<boolean> {
	const existing = await ctx.db
		.query("blobRefs")
		.withIndex("by_token_owner", (q) =>
			q.eq("token", token).eq("ownerUserId", ownerUserId),
		)
		.unique();
	if (existing) return false;
	await ctx.db.insert("blobRefs", { token, ownerUserId });
	return true;
}

/**
 * Step 2: attribute stored files using the reference rows.
 *
 * Conservative by construction — a token more than one user mentions is left
 * unattributed, so no account deletion can take a file another account is still
 * using. An unattributed file is not lost: it stays reachable, and the daily
 * orphan sweep collects it once nothing references it.
 *
 * Reads are bounded by `limit` files, each costing one `getUrl` and at most two
 * index lookups.
 */
export const backfillBlobOwners = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const name = "backfillBlobOwners";
		const limit = clampLimit(args.limit, 64);
		const cursor = await readCursor(ctx, name);

		const files = await ctx.db.system
			.query("_storage")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);

		let claimed = 0;
		let shared = 0;
		for (const file of files) {
			const already = await ctx.db
				.query("blobs")
				.withIndex("by_storage", (q) => q.eq("storageId", file._id))
				.unique();
			if (already) continue;

			// The served URL's token is what a client actually inserts; the raw id
			// is checked too, as `files.orphanSweep` does. Extracted with the same
			// function the document side uses, so the two cannot disagree.
			const tokens = storageFileTokens(
				file._id,
				await ctx.storage.getUrl(file._id),
			);

			const owners = new Set<string>();
			for (const token of tokens) {
				const refs = await ctx.db
					.query("blobRefs")
					.withIndex("by_token", (q) => q.eq("token", token))
					// Three is enough to know it is more than one.
					.take(3);
				for (const ref of refs) owners.add(ref.ownerUserId);
			}

			if (owners.size !== 1) {
				if (owners.size > 1) shared += 1;
				continue;
			}
			const [owner] = owners;
			if (owner && (await claimBlob(ctx, file._id, owner, "upload"))) {
				claimed += 1;
			}
		}

		const done = files.length < limit;
		await writeCursor(ctx, name, files.at(-1)?._creationTime ?? cursor, done);
		return { scanned: files.length, claimed, shared, done };
	},
});

/** Step 3: drop the scaffolding once the claims are in. Bounded; re-run until done. */
export const cleanupBlobRefs = internalMutation({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = clampLimit(args.limit, BACKFILL_BATCH);
		const rows = await ctx.db.query("blobRefs").take(limit);
		for (const row of rows) await ctx.db.delete(row._id);
		return { deleted: rows.length, done: rows.length < limit };
	},
});
