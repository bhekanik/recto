import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { extractStorageTokens, storageFileTokens } from "./storageTokens";

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

/** Rows read per survey pass, per table. */
export const SURVEY_BATCH = 128;

/**
 * Sentinel for `blobSurveyCursor` once the documents phase is finished.
 * `_creationTime` is always positive, so a negative value cannot collide.
 */
const DOCUMENTS_EXHAUSTED = -1;

/**
 * Cap on each token bucket. Overflow is not a failure — it means the survey
 * cannot claim to be complete, so the purge takes the conservative branch and
 * keeps the files (their ownership rows still go, and the daily orphan sweep
 * collects whatever nothing references).
 */
export const MAX_SURVEY_TOKENS = 4096;

/**
 * How far back up the parent chain the reviewer-node purge will walk before
 * giving up and keeping the nodes. Deep enough for any real document's history
 * and small enough that one pass stays well inside the 32k-document read limit;
 * a document past it keeps its reviewer nodes (de-attributed) rather than risk
 * breaking materialization.
 */
const ANCESTOR_WALK_CAP = 4096;

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
// Blobs: who else is pointing at them
// ---------------------------------------------------------------------------

/**
 * Scan the corpus once, bucketing every storage token by whether the text
 * mentioning it belongs to this user or to somebody else.
 *
 * This exists because a file this user owns may still be referenced by ANOTHER
 * user's document or history — a URL pasted across a shared review — and
 * deleting it would break their document. Ownership alone cannot answer that;
 * only the other direction can, and that is a scan of everyone's text.
 *
 * So it is paged. Documents first (`blobSurveyCursor`), then history nodes
 * (`blobSurveyNodeCursor`), both by `_creationTime`, `SURVEY_BATCH` rows at a
 * time. Nothing is deleted here; the survey only records what it saw.
 *
 * The `ownTokens` bucket is the other half of the job: a file uploaded by a
 * browser tab still running the pre-`/upload-image` protocol can have completed
 * without ever recording ownership, and the only remaining evidence that it was
 * this user's is that only their text mentions it.
 */
export const surveyBlobRefs = internalMutation({
	args: { userId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const tombstone = await loadTombstone(ctx, args.userId);
		if (!tombstone) throw new Error("No deletion in progress for this user");
		if (tombstone.blobSurveyDone) return { scanned: 0, done: true };

		const limit = Math.max(
			1,
			Math.min(args.limit ?? SURVEY_BATCH, SURVEY_BATCH),
		);
		const retained = new Set(tombstone.retainedTokens ?? []);
		const own = new Set(tombstone.ownTokens ?? []);
		let overflow = tombstone.blobSurveyOverflow ?? false;

		const record = (tokens: string[], mine: boolean) => {
			for (const token of tokens) {
				const bucket = mine ? own : retained;
				if (bucket.has(token)) continue;
				if (bucket.size >= MAX_SURVEY_TOKENS) {
					overflow = true;
					continue;
				}
				bucket.add(token);
			}
		};

		let documentCursor = tombstone.blobSurveyCursor ?? 0;
		let nodeCursor = tombstone.blobSurveyNodeCursor ?? 0;
		let scanned = 0;
		let done = false;

		// One phase per pass. Splitting a budget across two tables makes the
		// "did this phase run out of rows?" test depend on how much the other
		// phase used, which is exactly the kind of arithmetic that silently
		// declares a survey complete while rows remain.
		if (documentCursor !== DOCUMENTS_EXHAUSTED) {
			const documents = await ctx.db
				.query("documents")
				.withIndex("by_creation_time", (q) =>
					q.gt("_creationTime", documentCursor),
				)
				.take(limit);
			scanned = documents.length;
			for (const doc of documents) {
				record(extractStorageTokens(doc.markdown), doc.userId === args.userId);
			}
			const last = documents.at(-1);
			documentCursor =
				documents.length < limit
					? DOCUMENTS_EXHAUSTED
					: (last?._creationTime ?? documentCursor);
		} else {
			const nodes = await ctx.db
				.query("docNodes")
				.withIndex("by_creation_time", (q) => q.gt("_creationTime", nodeCursor))
				.take(limit);
			scanned = nodes.length;
			// A node's owner is its document's owner, cached per pass so a document
			// with many nodes in one batch costs one read.
			const ownerCache = new Map<string, string | null>();
			for (const node of nodes) {
				let owner = ownerCache.get(node.documentId);
				if (owner === undefined) {
					owner = (await ctx.db.get(node.documentId))?.userId ?? null;
					ownerCache.set(node.documentId, owner);
				}
				const mine = owner === args.userId;
				record(extractStorageTokens(node.patch), mine);
				if (node.snapshot !== undefined) {
					record(extractStorageTokens(node.snapshot), mine);
				}
			}
			const last = nodes.at(-1);
			if (last) nodeCursor = last._creationTime;
			done = nodes.length < limit;
		}

		await ctx.db.patch(tombstone._id, {
			blobSurveyCursor: documentCursor,
			blobSurveyNodeCursor: nodeCursor,
			blobSurveyDone: done,
			blobSurveyOverflow: overflow,
			retainedTokens: [...retained],
			ownTokens: [...own],
			updatedAt: Date.now(),
		});

		return { scanned, done };
	},
});

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
		if (!tombstone.blobSurveyDone) {
			throw new Error(
				"Blob purge ran before the foreign-reference survey finished",
			);
		}

		const limit = Math.max(
			1,
			Math.min(args.limit ?? STORAGE_BATCH, STORAGE_BATCH),
		);
		// An incomplete survey cannot rule out a foreign reference, so nothing is
		// deleted on the strength of it.
		const overflow = tombstone.blobSurveyOverflow ?? false;
		const retained = new Set(tombstone.retainedTokens ?? []);

		const owned = await ctx.db
			.query("blobs")
			.withIndex("by_owner", (q) => q.eq("ownerUserId", args.userId))
			.take(limit);

		let deleted = 0;
		let kept = 0;
		for (const blob of owned) {
			const file = await ctx.db.system.get(blob.storageId);
			if (file !== null) {
				const shared =
					overflow ||
					(await tokensFor(ctx, blob.storageId)).some((token) =>
						retained.has(token),
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
 * remaining evidence of whose it was is that only this user's text mentions it,
 * which is what the survey's `ownTokens` bucket holds.
 *
 * Deliberately conservative: a token anyone else also mentions is skipped, an
 * incomplete survey deletes nothing, and files nothing mentions are left to the
 * daily orphan sweep.
 */
export const purgeUnattributedBlobs = internalMutation({
	args: { userId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const tombstone = await loadTombstone(ctx, args.userId);
		if (!tombstone) throw new Error("No deletion in progress for this user");
		if (!tombstone.blobSurveyDone || tombstone.blobSurveyOverflow) {
			return { deleted: 0, done: true };
		}

		const limit = Math.max(
			1,
			Math.min(args.limit ?? STORAGE_BATCH, STORAGE_BATCH),
		);
		const own = new Set(tombstone.ownTokens ?? []);
		const retained = new Set(tombstone.retainedTokens ?? []);
		if (own.size === 0) return { deleted: 0, done: true };

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
			if (tokens.some((token) => retained.has(token))) continue;
			if (!tokens.some((token) => own.has(token))) continue;
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
 * What goes and what stays, decided PER BRANCH (`docNodes.branchId`):
 *  - **Open or rejected branch**: the reviewer's nodes are deleted. Nobody
 *    accepted them, so they are the reviewer's content sitting in someone
 *    else's table.
 *  - **Accepted branch**: the nodes STAY. `review.acceptBranch` merges a branch
 *    forward by writing a NEW owner-authored node carrying the merged markdown,
 *    and the suggestion the owner accepted is now part of the document's record
 *    of how it got here. It is the owner's content.
 *  - **Anything on the owner's current ancestor chain**: stays regardless. The
 *    owner may have navigated onto a suggestion in the history panel and typed
 *    from there, which makes the reviewer's node load-bearing.
 *  - **A node with no `branchId`** (written before that field, and not
 *    derivable by `migrations.backfillNodeBranches`): falls back to the older,
 *    coarser rule — kept if this reviewer has ANY accepted branch on the
 *    document. Keeping too much is the safe direction.
 *
 * Every node this decides to KEEP is de-attributed on the spot. That is not
 * cosmetic: the branch rows recording "accepted" are themselves deleted by a
 * later pass of this same purge, so a kept node left attributed would be
 * reconsidered by the next pass with no branch to justify keeping it, and
 * deleted after all. De-attributing is what makes the decision stick — and it
 * takes the departing user's id out of a row that is staying.
 *
 * **One document per pass.** Every document costs an ancestor walk of up to
 * `ANCESTOR_WALK_CAP` reads; doing several in one transaction is how this
 * reaches the 32k-document limit. There is no cursor to persist — each pass
 * either deletes or de-attributes, so the next pass sees strictly less work.
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
	const nodes = await ctx.db
		.query("docNodes")
		.withIndex("by_author_document", (q) =>
			q.eq("authorUserId", userId).eq("documentId", documentId),
		)
		.take(state.budget);

	const branches = await ctx.db
		.query("reviewBranches")
		.withIndex("by_document_reviewer", (q) =>
			q.eq("documentId", documentId).eq("reviewerUserId", userId),
		)
		.collect();
	const acceptedBranchIds = new Set(
		branches
			.filter((branch) => branch.status === "accepted")
			.map((branch) => branch._id as string),
	);
	const anyAccepted = acceptedBranchIds.size > 0;

	const doc = await ctx.db.get(documentId);
	// The owner's document is already gone, so its nodes went with it and the
	// only thing left to do is drop the stale attribution.
	const ancestors = doc
		? await collectAncestors(ctx, documentId, doc.currentNodeId)
		: new Set<string>();

	for (const node of nodes) {
		if (state.budget <= 0) return;
		const onAcceptedBranch =
			node.branchId !== undefined
				? acceptedBranchIds.has(node.branchId)
				: anyAccepted; // legacy node: fall back to the coarser rule
		// `ancestors === null` means the chain was too long to walk, so nothing
		// on this document can be shown safe to delete.
		if (onAcceptedBranch || ancestors === null || ancestors.has(node.nodeId)) {
			await ctx.db.patch(node._id, {
				authorUserId: undefined,
				branchId: undefined,
				origin: DELETED_REVIEWER_ORIGIN,
			});
			state.deleted += 1;
			state.budget -= 1;
			continue;
		}
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

		// Those nodes are decided by their branch's status, and `purgeReviewerNodes`
		// only gets through one document per pass — so the branch rows have to
		// outlive every attributed node. Deleting them on the first pass is how an
		// accepted branch's nodes came to be deleted three passes later, with
		// nothing left to say they had been accepted.
		const attributedRemain =
			(await ctx.db
				.query("docNodes")
				.withIndex("by_author_document", (q) =>
					q.eq("authorUserId", args.userId),
				)
				.first()) !== null;

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
				...(attributedRemain
					? []
					: [
							(n: number) =>
								ctx.db
									.query("reviewBranches")
									.withIndex("by_reviewer", (q) =>
										q.eq("reviewerUserId", args.userId),
									)
									.take(n),
						]),
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
						.query("workspaces")
						.withIndex("by_user", (q) => q.eq("userId", args.userId))
						.take(n),
				(n) =>
					ctx.db
						.query("settings")
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
