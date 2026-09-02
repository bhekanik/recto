import type { GenericMutationCtx } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel, Id, TableNames } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { removeBlobReferences } from "./blobReferences";

type MutationCtx = GenericMutationCtx<DataModel>;

const CLEANUP_BATCH = 64;

export async function startDocumentCleanup(
	ctx: MutationCtx,
	args: { documentId: Id<"documents">; userId: string },
): Promise<void> {
	const existing = await ctx.db
		.query("aiDocumentDeletions")
		.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
		.unique();
	const now = Date.now();
	if (existing) await ctx.db.patch(existing._id, { updatedAt: now });
	else {
		await ctx.db.insert("aiDocumentDeletions", {
			...args,
			createdAt: now,
			updatedAt: now,
		});
	}
	await ctx.scheduler.runAfter(0, internal.documentCleanup.run, {
		documentId: args.documentId,
	});
}

async function deleteRows(
	ctx: MutationCtx,
	rows: { _id: Id<TableNames> }[],
): Promise<void> {
	for (const row of rows) await ctx.db.delete(row._id);
}

export async function cleanupDocumentBatch(
	ctx: MutationCtx,
	documentId: Id<"documents">,
): Promise<{ done: boolean; deleted: number }> {
	const job = await ctx.db
		.query("aiDocumentDeletions")
		.withIndex("by_document", (q) => q.eq("documentId", documentId))
		.unique();
	if (!job) return { done: true, deleted: 0 };

	// A node can reference 512 blobs, and each aggregate decrement is a query.
	// Drain one node per pass so the cleanup stays below Convex transaction limits.
	const node = await ctx.db
		.query("docNodes")
		.withIndex("by_document", (q) => q.eq("documentId", documentId))
		.first();
	if (node) {
		await removeBlobReferences(ctx, "node", node._id);
		await ctx.db.delete(node._id);
		await ctx.db.patch(job._id, { updatedAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.documentCleanup.run, {
			documentId,
		});
		return { done: false, deleted: 1 };
	}

	let remaining = CLEANUP_BATCH;
	let deleted = 0;
	const drain = async <Name extends TableNames>(
		load: (limit: number) => Promise<DataModel[Name]["document"][]>,
	): Promise<void> => {
		if (remaining === 0) return;
		const rows = await load(remaining);
		await deleteRows(ctx, rows);
		deleted += rows.length;
		remaining -= rows.length;
	};

	await drain((n) =>
		ctx.db
			.query("versions")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("reviewBranches")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("commentReports")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("comments")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("aiUsage")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("aiActiveRuns")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);
	await drain((n) =>
		ctx.db
			.query("aiRuns")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.take(n),
	);

	if (deleted === 0) {
		await ctx.db.delete(job._id);
		return { done: true, deleted: 0 };
	}
	await ctx.db.patch(job._id, { updatedAt: Date.now() });
	await ctx.scheduler.runAfter(0, internal.documentCleanup.run, { documentId });
	return { done: false, deleted };
}

export const run = internalMutation({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) =>
		await cleanupDocumentBatch(ctx, args.documentId),
});
