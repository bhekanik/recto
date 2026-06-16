import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

type QueryCtx = GenericQueryCtx<import("./_generated/dataModel").DataModel>;
type MutationCtx = GenericMutationCtx<
	import("./_generated/dataModel").DataModel
>;

/** Resolve the authenticated Clerk user id (JWT subject) or throw. */
async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error("Unauthenticated");
	}
	return identity.subject;
}

/** Return the single workspace row for the authenticated user, or null. */
export const get = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const row = await ctx.db
			.query("workspaces")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();

		if (!row) return null;

		return {
			_id: row._id,
			paneTree: row.paneTree,
			openDocumentIds: row.openDocumentIds,
			activePaneId: row.activePaneId,
			perPaneViewState: row.perPaneViewState,
			updatedAt: row.updatedAt,
		};
	},
});

/** Upsert the user's workspace row (last-write-wins on the whole row). */
export const save = mutation({
	args: {
		paneTree: v.string(),
		openDocumentIds: v.array(v.id("documents")),
		activePaneId: v.string(),
		perPaneViewState: v.string(),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const updatedAt = Date.now();

		const existing = await ctx.db
			.query("workspaces")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				paneTree: args.paneTree,
				openDocumentIds: args.openDocumentIds,
				activePaneId: args.activePaneId,
				perPaneViewState: args.perPaneViewState,
				updatedAt,
			});
			return { updatedAt };
		}

		await ctx.db.insert("workspaces", {
			userId,
			paneTree: args.paneTree,
			openDocumentIds: args.openDocumentIds,
			activePaneId: args.activePaneId,
			perPaneViewState: args.perPaneViewState,
			updatedAt,
		});

		return { updatedAt };
	},
});

/** Internal helper for tests — find workspace by userId. */
export async function getWorkspaceForUser(
	ctx: QueryCtx,
	userId: string,
): Promise<Doc<"workspaces"> | null> {
	return await ctx.db
		.query("workspaces")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
}

/** Internal helper for tests — count workspace rows. */
export async function countWorkspaces(ctx: QueryCtx): Promise<number> {
	const rows = await ctx.db.query("workspaces").collect();
	return rows.length;
}

export type WorkspaceSaveArgs = {
	paneTree: string;
	openDocumentIds: Id<"documents">[];
	activePaneId: string;
	perPaneViewState: string;
};
