import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel, Doc } from "./_generated/dataModel";

type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;
type AnyCtx = QueryCtx | MutationCtx;

/**
 * The deletion tombstone (ADR-21).
 *
 * Account deletion cannot be one transaction — it is an action driving many
 * bounded mutations, and it deletes a Clerk user over HTTP in the middle. That
 * leaves a window in which the user's JWT is still valid and any client holding
 * one (a tab left open on another machine, a native app draining an offline
 * outbox) can write rows behind the purge. Those rows then belong to an account
 * that no longer exists and nobody can reach or delete.
 *
 * `accountDeletions` closes the window: a row is written BEFORE anything is
 * deleted, and while it exists every user-facing mutation for that user
 * refuses. It is deliberately kept for `TOMBSTONE_RETENTION_MS` after the
 * deletion finishes, because Clerk session tokens live up to a minute past the
 * user's deletion and a queued mutation can still arrive in that window.
 */

export const ACCOUNT_DELETION_IN_PROGRESS_MESSAGE =
	"This account is being deleted; no further changes can be saved.";

/**
 * How long the tombstone outlives the deletion. A Clerk session token is valid
 * for 60 seconds; 24 hours is far more than that and costs one tiny row, so the
 * margin is free.
 */
export const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this context can write. Convex hands a query a
 * `GenericDatabaseReader` and a mutation a `GenericDatabaseWriter`, and the
 * difference is visible at runtime.
 *
 * The check is done here, once, rather than by making every mutation call a
 * different helper from every query: there are 30 user-facing mutations across
 * eight modules, and the guarantee is only as good as the one someone forgets
 * to update. Reads stay allowed — the deleting client's own UI is still
 * rendering while its data disappears, and a read cannot resurrect anything.
 */
function canWrite(ctx: AnyCtx): ctx is MutationCtx {
	return (
		typeof (ctx.db as { insert?: unknown }).insert === "function" &&
		typeof (ctx.db as { patch?: unknown }).patch === "function"
	);
}

/** The user's deletion tombstone, or null. */
export async function findTombstone(
	ctx: AnyCtx,
	userId: string,
): Promise<Doc<"accountDeletions"> | null> {
	return await ctx.db
		.query("accountDeletions")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
}

/**
 * Refuse a write for a user whose account is being (or has just been) deleted.
 * A no-op in a query context.
 */
export async function assertNotDeleting(
	ctx: AnyCtx,
	userId: string,
): Promise<void> {
	if (!canWrite(ctx)) return;
	if ((await findTombstone(ctx, userId)) !== null) {
		throw new Error(ACCOUNT_DELETION_IN_PROGRESS_MESSAGE);
	}
}
