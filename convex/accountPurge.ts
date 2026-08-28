import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel, Id, TableNames } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

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
 * reports done. Nothing here reads or writes an unbounded amount: the
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
 * giving up and keeping the nodes. Deep enough for any real document's history;
 * a document past it keeps its reviewer nodes rather than risk breaking
 * materialization, and the daily retention sweep prunes them later.
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
 * The tag left on a kept suggestion node once its author's account is gone.
 * The node stays because it is part of the owner's document; the identifier
 * does not, so a deleted account's user id is not left sitting in someone
 * else's history.
 */
const DELETED_REVIEWER_ORIGIN = "review:deleted-user";

/**
 * Delete the suggestion nodes this user wrote on OTHER people's documents.
 *
 * These live in the document OWNER's `docNodes` rows, so nothing keyed to the
 * reviewer reaches them — hence `docNodes.authorUserId` and its index (ADR-21).
 *
 * What goes and what stays:
 *  - **Open or rejected branches**: the reviewer's nodes are deleted. Nobody
 *    accepted them, so they are the reviewer's content sitting in someone
 *    else's table.
 *  - **Accepted branches**: the nodes STAY. `review.acceptBranch` merges a
 *    branch forward by writing a NEW owner-authored node carrying the merged
 *    markdown, and the suggestion the owner accepted is now part of the
 *    document's record of how it got here. It is the owner's content.
 *  - **Anything on the owner's current ancestor chain**: stays regardless. The
 *    owner may have navigated onto a suggestion in the history panel and typed
 *    from there, which makes the reviewer's node load-bearing.
 *
 * Every node this decides to KEEP is de-attributed on the spot. That is not
 * cosmetic: the branch rows that record "accepted" are themselves deleted by a
 * later pass of this same purge, so a kept node left attributed would be
 * reconsidered by the next pass with no branch to justify keeping it, and
 * deleted after all. De-attributing is what makes the decision stick — and it
 * takes the departing user's id out of a row that is staying.
 */
async function purgeReviewerNodes(
	ctx: MutationCtx,
	userId: string,
	state: Budget,
): Promise<void> {
	if (state.budget <= 0) return;

	const authored = await ctx.db
		.query("docNodes")
		.withIndex("by_author_document", (q) => q.eq("authorUserId", userId))
		.take(state.budget);
	if (authored.length === 0) return;

	/** Keep the node, but stop it being this user's. */
	const keep = async (node: (typeof authored)[number]) => {
		await ctx.db.patch(node._id, {
			authorUserId: undefined,
			origin: DELETED_REVIEWER_ORIGIN,
		});
		state.deleted += 1;
		state.budget -= 1;
	};

	// Group by document so the branch statuses and the ancestor chain are
	// resolved once per document rather than once per node. Not `Map.groupBy`:
	// the Convex tsconfig's lib is ES2023 and that is ES2024.
	const byDocument = new Map<Id<"documents">, typeof authored>();
	for (const node of authored) {
		const bucket = byDocument.get(node.documentId);
		if (bucket) bucket.push(node);
		else byDocument.set(node.documentId, [node]);
	}

	for (const [documentId, nodes] of byDocument) {
		if (state.budget <= 0) return;

		const branches = await ctx.db
			.query("reviewBranches")
			.withIndex("by_document_reviewer", (q) =>
				q.eq("documentId", documentId).eq("reviewerUserId", userId),
			)
			.collect();
		// One accepted branch is enough: acceptance copies the branch head's text
		// into the owner's document, and the nodes behind it become the record of
		// that. Distinguishing per-branch would need per-node branch membership,
		// which is not stored — and keeping too much is the safe direction.
		const accepted = branches.some((branch) => branch.status === "accepted");

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
			if (accepted || ancestors === null || ancestors.has(node.nodeId)) {
				await keep(node);
				continue;
			}
			await ctx.db.delete(node._id);
			state.deleted += 1;
			state.budget -= 1;
		}
	}
}

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

		// Suggestion nodes this user wrote inside other people's documents. Before
		// the branch rows below, because it reads those branches' statuses.
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
 * Delete the stored blobs this user owns — uploaded images and generated
 * `.docx` exports alike.
 *
 * Ownership comes from the `blobs` table, not from scanning markdown for URLs.
 * The scan version of this deleted a file the moment another user's document
 * quoted its URL, missed every image referenced only from `docNodes` history,
 * missed generated exports entirely (nothing references those), and read every
 * document plus the whole `_storage` table on every pass — which is how a
 * purge blows the 16 MiB / 32k-document transaction limits and stops being
 * resumable.
 *
 * Paged through `by_owner`, so the read is bounded by `limit` regardless of how
 * many files exist on the deployment.
 */
export const purgeBlobs = internalMutation({
	args: { userId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = Math.max(
			1,
			Math.min(args.limit ?? STORAGE_BATCH, STORAGE_BATCH),
		);

		const owned = await ctx.db
			.query("blobs")
			.withIndex("by_owner", (q) => q.eq("ownerUserId", args.userId))
			.take(limit);

		for (const blob of owned) {
			// The blobs row goes either way: a storage id with no file behind it is
			// exactly the state that would make the next pass find work forever.
			const file = await ctx.db.system.get(blob.storageId);
			if (file !== null) await ctx.storage.delete(blob.storageId);
			await ctx.db.delete(blob._id);
		}

		return { deleted: owned.length, done: owned.length < limit };
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
