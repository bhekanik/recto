import type { GenericMutationCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import { extractStorageTokens } from "./storageTokens";

type MutationCtx = GenericMutationCtx<DataModel>;
export type BlobReferenceSource = "document" | "node";

/**
 * One editor commit can replace both a node and document source. Each removed
 * and added token costs an indexed query plus a write, so this leaves room
 * under Convex's 4,096-query and 16,000-write transaction ceilings.
 */
export const MAX_BLOB_REFERENCES_PER_SOURCE = 512;

export const TOO_MANY_BLOB_REFERENCES_MESSAGE =
	"Document contains too many stored-file references (512 limit).";

function tokensIn(texts: readonly string[]): string[] {
	const tokens = new Set<string>();
	for (const text of texts) {
		for (const token of extractStorageTokens(text)) tokens.add(token);
	}
	if (tokens.size > MAX_BLOB_REFERENCES_PER_SOURCE) {
		throw new Error(TOO_MANY_BLOB_REFERENCES_MESSAGE);
	}
	return [...tokens].sort();
}

async function increment(
	ctx: MutationCtx,
	token: string,
	ownerUserId: string,
): Promise<void> {
	const aggregate = await ctx.db
		.query("blobRefs")
		.withIndex("by_token_owner", (q) =>
			q.eq("token", token).eq("ownerUserId", ownerUserId),
		)
		.unique();
	if (aggregate) {
		await ctx.db.patch(aggregate._id, { count: (aggregate.count ?? 1) + 1 });
		return;
	}
	await ctx.db.insert("blobRefs", { token, ownerUserId, count: 1 });
}

async function decrement(
	ctx: MutationCtx,
	token: string,
	ownerUserId: string,
): Promise<void> {
	const aggregate = await ctx.db
		.query("blobRefs")
		.withIndex("by_token_owner", (q) =>
			q.eq("token", token).eq("ownerUserId", ownerUserId),
		)
		.unique();
	if (!aggregate) return;
	const count = aggregate.count ?? 1;
	if (count <= 1) await ctx.db.delete(aggregate._id);
	else await ctx.db.patch(aggregate._id, { count: count - 1 });
}

/** Keep the exact source row and its token-owner aggregates in one transaction. */
export async function syncBlobReferences(
	ctx: MutationCtx,
	ownerUserId: string,
	source: BlobReferenceSource,
	sourceId: string,
	texts: readonly string[],
): Promise<void> {
	const next = tokensIn(texts);
	const row = await ctx.db
		.query("blobRefSources")
		.withIndex("by_source", (q) =>
			q.eq("source", source).eq("sourceId", sourceId),
		)
		.unique();
	const previous = new Set(row?.tokens ?? []);
	const wanted = new Set(next);

	if (row && row.ownerUserId !== ownerUserId) {
		for (const token of previous) await decrement(ctx, token, row.ownerUserId);
		for (const token of wanted) await increment(ctx, token, ownerUserId);
	} else {
		for (const token of previous) {
			if (!wanted.has(token)) await decrement(ctx, token, ownerUserId);
		}
		for (const token of wanted) {
			if (!previous.has(token)) await increment(ctx, token, ownerUserId);
		}
	}

	if (next.length === 0) {
		if (row) await ctx.db.delete(row._id);
		return;
	}
	if (row) {
		await ctx.db.patch(row._id, { ownerUserId, tokens: next });
		return;
	}
	await ctx.db.insert("blobRefSources", {
		ownerUserId,
		source,
		sourceId,
		tokens: next,
	});
}

export async function removeBlobReferences(
	ctx: MutationCtx,
	source: BlobReferenceSource,
	sourceId: string,
): Promise<boolean> {
	const row = await ctx.db
		.query("blobRefSources")
		.withIndex("by_source", (q) =>
			q.eq("source", source).eq("sourceId", sourceId),
		)
		.unique();
	if (!row) return false;
	for (const token of row.tokens) await decrement(ctx, token, row.ownerUserId);
	await ctx.db.delete(row._id);
	return true;
}

/** Remove a bounded number of a user's source rows during account deletion. */
export async function removeBlobReferenceSourcesForOwner(
	ctx: MutationCtx,
	ownerUserId: string,
	limit: number,
): Promise<number> {
	const rows = (
		await ctx.db
			.query("blobRefSources")
			.withIndex("by_owner", (q) => q.eq("ownerUserId", ownerUserId))
			.paginate({
				cursor: null,
				numItems: Math.min(limit, 64),
				maximumRowsRead: Math.min(limit, 64),
				maximumBytesRead: 1024 * 1024,
			})
	).page;
	let removed = 0;
	let tokenQueries = 0;
	for (const row of rows) {
		// Each token removal is one aggregate lookup. Preserve half the query
		// budget for the rest of accountPurge.purgeData.
		if (removed > 0 && tokenQueries + row.tokens.length > 2_048) break;
		await removeBlobReferences(ctx, row.source, row.sourceId);
		removed += 1;
		tokenQueries += row.tokens.length;
	}
	return removed;
}

export async function hasForeignBlobReference(
	ctx: MutationCtx,
	tokens: readonly string[],
	ownerUserId: string,
): Promise<boolean> {
	for (const token of tokens) {
		// One aggregate row per owner means two rows are enough: if one is this
		// user, the other is foreign; if neither is, the first already proves it.
		const refs = await ctx.db
			.query("blobRefs")
			.withIndex("by_token", (q) => q.eq("token", token))
			.take(2);
		if (refs.some((ref) => ref.ownerUserId !== ownerUserId)) return true;
	}
	return false;
}

export async function hasBlobReferenceFrom(
	ctx: MutationCtx,
	tokens: readonly string[],
	ownerUserId: string,
): Promise<boolean> {
	for (const token of tokens) {
		const ref = await ctx.db
			.query("blobRefs")
			.withIndex("by_token_owner", (q) =>
				q.eq("token", token).eq("ownerUserId", ownerUserId),
			)
			.unique();
		if (ref) return true;
	}
	return false;
}
