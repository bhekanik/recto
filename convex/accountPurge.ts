import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import type { Id, TableNames } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

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
 * reports done.
 */

/** Rows deleted per `purgeData` call. Well under the Convex per-mutation write ceiling. */
export const PURGE_BATCH = 256;

/** Documents inspected per `purgeData` call (each fans out into six dependent tables). */
const DOCUMENT_BATCH = 16;

/** Stored blobs deleted per `purgeStorage` call; each one costs a `getUrl`. */
export const STORAGE_BATCH = 64;

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
 * Delete the stored blobs (uploaded images) this user's live documents refer
 * to. Runs BEFORE the documents themselves: `_storage` rows carry no owner, so
 * the only way to attribute a blob to a user is that their markdown names it,
 * and that evidence disappears with the documents.
 *
 * References are resolved the same way `files.orphanSweep` resolves them — the
 * last path segment of the SERVED url, which is a different id from the
 * `_storage` document id (see the comment there) — but only against live
 * `documents.markdown`, not the whole history. Reading every `docNodes` row for
 * a large account would blow the per-mutation read limit, and anything missed
 * is not lost: once the documents are gone the blob is unreferenced, and the
 * daily orphan sweep collects it after its 24h grace window.
 */
export const purgeStorage = internalMutation({
	args: { userId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = Math.max(
			1,
			Math.min(args.limit ?? STORAGE_BATCH, STORAGE_BATCH),
		);

		const texts = (
			await ctx.db
				.query("documents")
				.withIndex("by_user", (q) => q.eq("userId", args.userId))
				.collect()
		).map((doc) => doc.markdown);

		if (texts.length === 0) return { deleted: 0, done: true };

		const files = await ctx.db.system.query("_storage").collect();
		let deleted = 0;
		for (const file of files) {
			if (deleted >= limit) return { deleted, done: false };
			const url = await ctx.storage.getUrl(file._id);
			if (url === null) continue; // unresolvable — never delete blind
			const segment = new URL(url).pathname.split("/").pop();
			const id: string = file._id;
			const referenced = texts.some(
				(text) => (!!segment && text.includes(segment)) || text.includes(id),
			);
			if (referenced) {
				await ctx.storage.delete(file._id);
				deleted += 1;
			}
		}

		return { deleted, done: true };
	},
});
