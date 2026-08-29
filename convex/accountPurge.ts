import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import {
	hasBlobReferenceFrom,
	hasForeignBlobReference,
	MAX_BLOB_REFERENCES_PER_SOURCE,
	removeBlobReferenceSourcesForOwner,
	removeBlobReferences,
} from "./blobReferences";
import { storageFileTokens } from "./storageTokens";

type MutationCtx = GenericMutationCtx<DataModel>;

/**
 * The database half of account deletion (plan 023 §4.1(4), guideline 5.1.1(v)).
 * The action that drives it — and the Clerk/Apple half — is in
 * `convex/account.ts`; these mutations exist separately because an action
 * cannot touch the database and a Convex mutation is capped in how much it may
 * read and write, so a purge has to be a loop of bounded steps.
 *
 * Every step is "delete some of what is left", which makes the whole thing
 * idempotent for free: a purge interrupted halfway is finished by running it
 * again, and a purge run against an already-empty account deletes nothing and
 * reports done. Nothing here reads or writes an unbounded amount — the
 * transaction limits (16 MiB read, 32k documents scanned) are real, and a user
 * with a few thousand documents would otherwise blow past them mid-deletion
 * with no way to resume.
 */

/** Rows deleted per `purgeData` call. Well under the Convex per-mutation write ceiling. */
export const PURGE_BATCH = 256;

/** Documents inspected per `purgeData` call (each fans out into six dependent tables). */
const DOCUMENT_BATCH = 16;

/** Owned blobs deleted per `purgeBlobs` call; each one costs a storage delete. */
export const STORAGE_BATCH = 64;

/**
 * How far back up the parent chain the reviewer-node purge will walk before
 * giving up and keeping the nodes. Deep enough for any real document's history
 * and small enough that one pass stays well inside the 32k-document read limit;
 * a document past it keeps its reviewer nodes (de-attributed) rather than risk
 * breaking materialization.
 */
const ANCESTOR_WALK_CAP = 4096;
const ANCESTOR_BYTES_RESERVE = 2 * 1024 * 1024;
const REVIEWER_NODE_PAGE_BYTES = 4 * 1024 * 1024;
const REVIEWER_NODE_PAGE_ROWS = 4;
const ANCESTOR_QUERY_RESERVE =
	REVIEWER_NODE_PAGE_ROWS * MAX_BLOB_REFERENCES_PER_SOURCE + 64;

type Budget = { budget: number; deleted: number };

/**
 * One place rows can still be hiding. A thunk rather than a row array because
 * it is only run once the budget is known to have room, and `.take()` needs
 * that number.
 */
type RowSource = (limit: number) => Promise<{ _id: Id<TableNames> }[]>;

/** Delete from each source in order until the budget runs out. */
async function drainSources(
	ctx: MutationCtx,
	sources: RowSource[],
	state: Budget,
): Promise<void> {
	for (const source of sources) {
		if (state.budget <= 0) return;
		for (const row of await source(state.budget)) {
			await ctx.db.delete(row._id);
			state.deleted += 1;
			state.budget -= 1;
		}
	}
}

async function loadTombstone(
	ctx: MutationCtx,
	userId: string,
): Promise<Doc<"accountDeletions"> | null> {
	return await ctx.db
		.query("accountDeletions")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

/** The served-URL token for a stored file, plus its raw id. */
async function tokensFor(
	ctx: MutationCtx,
	storageId: Id<"_storage">,
): Promise<string[]> {
	return storageFileTokens(storageId, await ctx.storage.getUrl(storageId));
}

/**
 * Delete the stored blobs this user owns — uploaded images and generated
 * `.docx` exports alike — except any that somebody else's text points at.
 *
 * Ownership comes from the `blobs` table, not from scanning markdown for URLs.
 * The scan version of this deleted a file the moment another user's document
 * quoted its URL, missed every image referenced only from `docNodes` history,
 * missed generated exports entirely (nothing references those), and read every
 * document plus the whole `_storage` table on every pass — which is how a purge
 * blows the transaction limits and stops being resumable.
 *
 * A retained file keeps its bytes but loses its ownership row: this account no
 * longer exists to own it, and the daily orphan sweep collects it once the
 * other user stops referencing it.
 */
export const purgeBlobs = internalMutation({
	args: { userId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const tombstone = await loadTombstone(ctx, args.userId);
		if (!tombstone) throw new Error("No deletion in progress for this user");

		const limit = Math.max(
			1,
			Math.min(args.limit ?? STORAGE_BATCH, STORAGE_BATCH),
		);
		const owned = await ctx.db
			.query("blobs")
			.withIndex("by_owner", (q) => q.eq("ownerUserId", args.userId))
			.take(limit);

		let deleted = 0;
		let kept = 0;
		for (const blob of owned) {
			const file = await ctx.db.system.get(blob.storageId);
			if (file !== null) {
				const shared = await hasForeignBlobReference(
					ctx,
					await tokensFor(ctx, blob.storageId),
					args.userId,
				);
				if (shared) kept += 1;
				else {
					await ctx.storage.delete(blob.storageId);
					deleted += 1;
				}
			}
			// The row goes either way: a storage id with no file behind it, or one
			// deliberately kept, is exactly the state that would make the next pass
			// find work forever.
			await ctx.db.delete(blob._id);
		}

		return { deleted, kept, done: owned.length < limit };
	},
});

/**
 * Reclaim files this user uploaded before the server-mediated upload existed.
 *
 * The old protocol handed the client a signed URL and recorded ownership in a
 * separate call afterwards, so a crash — or a browser tab still running that
 * code — could leave a stored file that no `blobs` row claims. The only
 * remaining evidence of whose it was is that only this user's text mentions it.
 *
 * Deliberately conservative: a token anyone else also mentions is skipped, an
 * unindexed file is never attributed to the user, and files nothing mentions
 * are left to the daily orphan sweep.
 */
export const purgeUnattributedBlobs = internalMutation({
	args: { userId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const tombstone = await loadTombstone(ctx, args.userId);
		if (!tombstone) throw new Error("No deletion in progress for this user");
		const limit = Math.max(
			1,
			Math.min(args.limit ?? STORAGE_BATCH, STORAGE_BATCH),
		);
		const cursor = tombstone.blobSurveyStorageCursor ?? 0;
		const files = await ctx.db.system
			.query("_storage")
			.withIndex("by_creation_time", (q) => q.gt("_creationTime", cursor))
			.take(limit);

		let deleted = 0;
		for (const file of files) {
			const claimed = await ctx.db
				.query("blobs")
				.withIndex("by_storage", (q) => q.eq("storageId", file._id))
				.unique();
			if (claimed) continue; // attributed; purgeBlobs owns it
			const tokens = await tokensFor(ctx, file._id);
			if (!(await hasBlobReferenceFrom(ctx, tokens, args.userId))) continue;
			if (await hasForeignBlobReference(ctx, tokens, args.userId)) continue;
			await ctx.storage.delete(file._id);
			deleted += 1;
		}

		const last = files.at(-1);
		await ctx.db.patch(tombstone._id, {
			blobSurveyStorageCursor: last?._creationTime ?? cursor,
			updatedAt: Date.now(),
		});

		return { deleted, done: files.length < limit };
	},
});

// ---------------------------------------------------------------------------
// Suggestion nodes inside other people's documents
// ---------------------------------------------------------------------------

/**
 * The tag left on a kept suggestion node once its author's account is gone.
 * The node stays because it is part of the owner's document; the identifier
 * does not, so a deleted account's user id is not left sitting in someone
 * else's history.
 */
const DELETED_REVIEWER_ORIGIN = "review:deleted-user";

/**
 * Every node between `headNodeId` and the root. A reviewer's node that the
 * owner has navigated onto (or edited from) is an ancestor of the owner's head,
 * and deleting it would break every materialization that walks through it —
 * so those are kept whatever the branch status says.
 *
 * Returns null when the chain is longer than the cap or is broken: "cannot
 * prove this is safe" must read as "do not delete".
 */
async function collectAncestors(
	ctx: MutationCtx,
	documentId: Id<"documents">,
	headNodeId: string,
): Promise<Set<string> | null> {
	const seen = new Set<string>();
	let cursor: string | null = headNodeId;
	while (cursor !== null) {
		if (seen.has(cursor)) break; // a cycle cannot happen, but never loop on one
		if (seen.size >= ANCESTOR_WALK_CAP) return null;
		const metrics = await ctx.meta.getTransactionMetrics();
		if (
			metrics.bytesRead.remaining < ANCESTOR_BYTES_RESERVE ||
			metrics.databaseQueries.remaining < ANCESTOR_QUERY_RESERVE
		) {
			return null;
		}
		seen.add(cursor);
		const node = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", documentId).eq("nodeId", cursor as string),
			)
			.unique();
		if (!node) break; // dangling parent: stop, keep what we have
		cursor = node.parentNodeId;
	}
	return seen;
}

/**
 * Delete the suggestion nodes this user wrote on OTHER people's documents.
 *
 * These live in the document OWNER's `docNodes` rows, so nothing keyed to the
 * reviewer reaches them — hence `docNodes.authorUserId` and its index (ADR-21).
 *
 * What goes and what stays:
 *  - **Anything on the owner's current ancestor chain** stays. The
 *    owner may have navigated onto a suggestion in the history panel and typed
 *    from there, which makes the reviewer's node load-bearing.
 *  - Every other reviewer node is deleted. Full and partial acceptance both
 *    create a new owner-authored merge snapshot parented to the owner's prior
 *    head. The accepted text survives there; the suggestion branch itself is
 *    still reviewer content, and branch status cannot say which hunks won.
 *
 * Every node this decides to KEEP is de-attributed on the spot. That is not
 * cosmetic: the branch rows recording "accepted" are themselves deleted by a
 * later pass of this same purge, so a kept node left attributed would be
 * reconsidered by the next pass with no branch to justify keeping it, and
 * deleted after all. De-attributing is what makes the decision stick — and it
 * takes the departing user's id out of a row that is staying.
 *
 * **One document per pass.** The authored-node page is byte-bounded and the
 * ancestor walk stops with read/query headroom left. A stopped walk keeps and
 * de-attributes the page, so the next pass still makes progress.
 */
async function purgeReviewerNodes(
	ctx: MutationCtx,
	userId: string,
	state: Budget,
): Promise<void> {
	if (state.budget <= 0) return;

	const first = await ctx.db
		.query("docNodes")
		.withIndex("by_author_document", (q) => q.eq("authorUserId", userId))
		.first();
	if (!first) return;

	const documentId = first.documentId;
	const nodes = (
		await ctx.db
			.query("docNodes")
			.withIndex("by_author_document", (q) =>
				q.eq("authorUserId", userId).eq("documentId", documentId),
			)
			.paginate({
				numItems: Math.min(state.budget, REVIEWER_NODE_PAGE_ROWS),
				cursor: null,
				maximumRowsRead: Math.min(state.budget, REVIEWER_NODE_PAGE_ROWS),
				maximumBytesRead: REVIEWER_NODE_PAGE_BYTES,
			})
	).page;

	const doc = await ctx.db.get(documentId);
	// The owner's document is already gone, so its nodes went with it and the
	// only thing left to do is drop the stale attribution.
	const ancestors = doc
		? await collectAncestors(ctx, documentId, doc.currentNodeId)
		: new Set<string>();

	for (const node of nodes) {
		if (state.budget <= 0) return;
		// `ancestors === null` means the chain was too long to walk, so nothing
		// on this document can be shown safe to delete.
		if (ancestors === null || ancestors.has(node.nodeId)) {
			await ctx.db.patch(node._id, {
				authorUserId: undefined,
				branchId: undefined,
				origin: DELETED_REVIEWER_ORIGIN,
			});
			state.deleted += 1;
			state.budget -= 1;
			continue;
		}
		await removeBlobReferences(ctx, "node", node._id);
		await ctx.db.delete(node._id);
		state.deleted += 1;
		state.budget -= 1;
	}
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Delete a bounded slice of everything keyed to this user.
 *
 * `done` means this pass found nothing left to delete, so the caller stops.
 * That costs one extra confirming round trip and buys not having to track
 * progress anywhere: there is no cursor to resume from, only "what is still
 * there".
 *
 * `granteeEmail` is the caller's email from the verified JWT, needed for the
 * invites other people addressed to them by email but which were never claimed
 * (`documentShares.granteeUserId` is only filled in on first access).
 */
export const purgeData = internalMutation({
	args: {
		userId: v.string(),
		granteeEmail: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const state: Budget = {
			budget: Math.max(1, Math.min(args.limit ?? PURGE_BATCH, PURGE_BATCH)),
			deleted: 0,
		};

		const referenceRows = await removeBlobReferenceSourcesForOwner(
			ctx,
			args.userId,
			state.budget,
		);
		state.deleted += referenceRows;
		state.budget -= referenceRows;

		// Own documents, with their history, review rows and embeddings. A
		// document row is only removed once a pass finds all six dependent tables
		// empty — deleting it first would strand rows reachable only by_document.
		const documents = await ctx.db
			.query("documents")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.take(DOCUMENT_BATCH);

		for (const doc of documents) {
			if (state.budget <= 0) break;
			const before = state.deleted;

			await drainSources(
				ctx,
				[
					(n) =>
						ctx.db
							.query("docNodes")
							.withIndex("by_document", (q) => q.eq("documentId", doc._id))
							.take(n),
					(n) =>
						ctx.db
							.query("versions")
							.withIndex("by_document", (q) => q.eq("documentId", doc._id))
							.take(n),
					(n) =>
						ctx.db
							.query("documentShares")
							.withIndex("by_document", (q) => q.eq("documentId", doc._id))
							.take(n),
					(n) =>
						ctx.db
							.query("reviewBranches")
							.withIndex("by_document", (q) => q.eq("documentId", doc._id))
							.take(n),
					(n) =>
						ctx.db
							.query("comments")
							.withIndex("by_document", (q) => q.eq("documentId", doc._id))
							.take(n),
					(n) =>
						ctx.db
							.query("docChunks")
							.withIndex("by_document", (q) => q.eq("documentId", doc._id))
							.take(n),
				],
				state,
			);

			// Nothing was deleted for this document, so every dependent table is
			// empty and the document row itself can go.
			if (state.deleted === before && state.budget > 0) {
				await ctx.db.delete(doc._id);
				state.deleted += 1;
				state.budget -= 1;
			}
		}

		// Suggestion nodes this user wrote inside other people's documents.
		await purgeReviewerNodes(ctx, args.userId, state);

		const email = args.granteeEmail?.toLowerCase();

		await drainSources(
			ctx,
			[
				// Rows this user left on OTHER people's documents. Only reachable by
				// author/reviewer/grantee, which is why those indexes exist.
				(n) =>
					ctx.db
						.query("comments")
						.withIndex("by_author", (q) => q.eq("authorUserId", args.userId))
						.take(n),
				(n) =>
					ctx.db
						.query("reviewBranches")
						.withIndex("by_reviewer", (q) =>
							q.eq("reviewerUserId", args.userId),
						)
						.take(n),
				(n) =>
					ctx.db
						.query("documentShares")
						.withIndex("by_grantee_user", (q) =>
							q.eq("granteeUserId", args.userId),
						)
						.take(n),
				// An invite addressed to their email that they never claimed, so
				// `granteeUserId` was never filled in.
				...(email
					? [
							(n: number) =>
								ctx.db
									.query("documentShares")
									.withIndex("by_grantee_email", (q) =>
										q.eq("granteeEmail", email),
									)
									.take(n),
						]
					: []),
				// Rows keyed straight to the user.
				(n) =>
					ctx.db
						.query("writingStats")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
				(n) =>
					ctx.db
						.query("legacyUploadGrants")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
				(n) =>
					ctx.db
						.query("workspaces")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
				(n) =>
					ctx.db
						.query("settings")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
				(n) =>
					ctx.db
						.query("aiCredentials")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
				(n) =>
					ctx.db
						.query("aiOAuthSessions")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
				// Chunks whose document is already gone (a partial earlier pass can
				// leave these behind).
				(n) =>
					ctx.db
						.query("docChunks")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
			],
			state,
		);

		return { deleted: state.deleted, done: state.deleted === 0 };
	},
});

/**
 * Attribute a blob to a user. Exported for `migrations.backfillBlobOwners`,
 * which is the only caller that assigns ownership to a file uploaded before the
 * `blobs` table existed.
 */
export async function claimBlob(
	ctx: MutationCtx,
	storageId: Id<"_storage">,
	ownerUserId: string,
	kind: "upload" | "export",
): Promise<boolean> {
	const existing = await ctx.db
		.query("blobs")
		.withIndex("by_storage", (q) => q.eq("storageId", storageId))
		.unique();
	if (existing) return false;
	await ctx.db.insert("blobs", {
		storageId,
		ownerUserId,
		kind,
		createdAt: Date.now(),
	});
	return true;
}
