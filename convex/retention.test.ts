import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// Explicit module map for convex-test (mirrors convex/files.gc.test.ts).
// Keys must include a "_generated" path so convex-test can locate the
// function-bundle root (it splits a key on "_generated"). Relative imports —
// this file lives inside convex/, and the convex tsconfig (used by
// `convex codegen`) has no "@/*" path alias.
const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./retention.ts": () => import("./retention"),
	"./review.ts": () => import("./review"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Well past the 30-day retention window (convex/retention.ts). */
const OLD = Date.now() - 40 * DAY_MS;

type TestCtx = TestConvex<typeof schema>;

/** Insert a docNodes row directly (retention only reads, never validates). */
function insertNode(
	t: TestCtx,
	row: {
		documentId: import("./_generated/dataModel").Id<"documents">;
		nodeId: string;
		parentNodeId: string | null;
		patch: { from: number; to: number; insert: string };
		snapshot?: string;
		origin: string;
		createdAt: number;
	},
) {
	return t.run(async (ctx) => {
		await ctx.db.insert("docNodes", {
			documentId: row.documentId,
			nodeId: row.nodeId,
			parentNodeId: row.parentNodeId,
			patch: JSON.stringify(row.patch),
			snapshot: row.snapshot,
			selection: null,
			origin: row.origin,
			createdAt: row.createdAt,
		});
	});
}

function listNodeIds(
	t: TestCtx,
	documentId: import("./_generated/dataModel").Id<"documents">,
) {
	return t.run(async (ctx) => {
		const rows = await ctx.db
			.query("docNodes")
			.withIndex("by_document", (q) => q.eq("documentId", documentId))
			.collect();
		return rows.map((r) => r.nodeId).sort();
	});
}

describe("plan 014 — retention × review-branch integrity", () => {
	it("keeps an open review branch idle past the window; it still materializes", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Shared draft" },
		);

		// Reviewer branch off the root: root → branch-mid → branch-head, all aged
		// past the window, off the owner's spine, untagged. Pre-plan-014 the sweep
		// destroyed exactly this shape.
		await insertNode(t, {
			documentId,
			nodeId: "branch-mid",
			parentNodeId: rootNodeId,
			patch: { from: 0, to: 0, insert: "reviewer draft" },
			origin: "review:reviewer-1",
			createdAt: OLD,
		});
		await insertNode(t, {
			documentId,
			nodeId: "branch-head",
			parentNodeId: "branch-mid",
			patch: { from: 14, to: 14, insert: " refined" },
			origin: "review:reviewer-1",
			createdAt: OLD,
		});
		// Control: an equally old abandoned node with no protection must still be
		// pruned — the fix protects branches, it doesn't disable the sweep.
		await insertNode(t, {
			documentId,
			nodeId: "abandoned-old",
			parentNodeId: rootNodeId,
			patch: { from: 0, to: 0, insert: "dead end" },
			origin: "owner-device",
			createdAt: OLD,
		});
		const branchId = await t.run(async (ctx) =>
			ctx.db.insert("reviewBranches", {
				documentId,
				reviewerUserId: "reviewer-1",
				baseNodeId: rootNodeId,
				headNodeId: "branch-head",
				status: "open",
				createdAt: OLD,
				updatedAt: OLD,
			}),
		);

		const result = await t.mutation(internal.retention.sweep, {});

		expect(result).toEqual({ pruned: 1, prunedBranchRows: 0 });
		expect(await listNodeIds(t, documentId)).toEqual(
			["branch-head", "branch-mid", rootNodeId].sort(),
		);
		const row = await t.run(async (ctx) => ctx.db.get(branchId));
		expect(row?.status).toBe("open");

		// The review surface can still materialize the branch head.
		const diff = await owner.query(api.review.getBranchDiff, {
			documentId,
			branchId,
		});
		expect(diff.branchMarkdown).toBe("reviewer draft refined");
	});

	it("prunes a rejected branch past the window: nodes AND row", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Rejected review" },
		);
		await insertNode(t, {
			documentId,
			nodeId: "rej-head",
			parentNodeId: rootNodeId,
			patch: { from: 0, to: 0, insert: "unwanted suggestion" },
			origin: "review:reviewer-1",
			createdAt: OLD,
		});
		const branchId = await t.run(async (ctx) =>
			ctx.db.insert("reviewBranches", {
				documentId,
				reviewerUserId: "reviewer-1",
				baseNodeId: rootNodeId,
				headNodeId: "rej-head",
				status: "rejected",
				createdAt: OLD,
				updatedAt: OLD,
			}),
		);

		const result = await t.mutation(internal.retention.sweep, {});

		expect(result).toEqual({ pruned: 1, prunedBranchRows: 1 });
		expect(await listNodeIds(t, documentId)).toEqual([rootNodeId]);
		expect(await t.run(async (ctx) => ctx.db.get(branchId))).toBeNull();
	});

	it("keeps a closed branch row still within the window", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Freshly rejected" },
		);
		const branchId = await t.run(async (ctx) =>
			ctx.db.insert("reviewBranches", {
				documentId,
				reviewerUserId: "reviewer-1",
				baseNodeId: rootNodeId,
				headNodeId: rootNodeId,
				status: "rejected",
				createdAt: OLD,
				updatedAt: Date.now(), // rejected just now — row must survive
			}),
		);

		const result = await t.mutation(internal.retention.sweep, {});

		expect(result).toEqual({ pruned: 0, prunedBranchRows: 0 });
		expect(await t.run(async (ctx) => ctx.db.get(branchId))).not.toBeNull();
	});

	it("GCs an accepted branch row past the window; spine incl. merge node untouched", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Accepted review" },
		);
		// The branch head the owner accepted (off-spine once status != open) …
		await insertNode(t, {
			documentId,
			nodeId: "acc-head",
			parentNodeId: rootNodeId,
			patch: { from: 0, to: 0, insert: "merged content" },
			origin: "review:reviewer-1",
			createdAt: OLD,
		});
		// … and the merge node acceptBranch appended to the owner's spine. Aged
		// past the window so only spine membership protects it.
		await insertNode(t, {
			documentId,
			nodeId: "merge-node",
			parentNodeId: rootNodeId,
			patch: { from: 0, to: 0, insert: "merged content" },
			snapshot: "merged content",
			origin: "review-accept",
			createdAt: OLD,
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(documentId, {
				currentNodeId: "merge-node",
				markdown: "merged content",
			});
		});
		const branchId = await t.run(async (ctx) =>
			ctx.db.insert("reviewBranches", {
				documentId,
				reviewerUserId: "reviewer-1",
				baseNodeId: rootNodeId,
				headNodeId: "acc-head",
				status: "accepted",
				createdAt: OLD,
				updatedAt: OLD,
			}),
		);

		const result = await t.mutation(internal.retention.sweep, {});

		expect(result).toEqual({ pruned: 1, prunedBranchRows: 1 });
		expect(await listNodeIds(t, documentId)).toEqual(
			["merge-node", rootNodeId].sort(),
		);
		expect(await t.run(async (ctx) => ctx.db.get(branchId))).toBeNull();
	});

	it("regression: pre-existing keep-set behavior — a tagged old node survives", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Tagged history" },
		);
		await insertNode(t, {
			documentId,
			nodeId: "tagged-old",
			parentNodeId: rootNodeId,
			patch: { from: 0, to: 0, insert: "milestone" },
			origin: "owner-device",
			createdAt: OLD,
		});
		await insertNode(t, {
			documentId,
			nodeId: "untagged-old",
			parentNodeId: rootNodeId,
			patch: { from: 0, to: 0, insert: "scrap" },
			origin: "owner-device",
			createdAt: OLD,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("versions", {
				documentId,
				nodeId: "tagged-old",
				label: "v1",
				kind: "manual",
				createdAt: OLD,
			});
		});

		const result = await t.mutation(internal.retention.sweep, {});

		expect(result).toEqual({ pruned: 1, prunedBranchRows: 0 });
		expect(await listNodeIds(t, documentId)).toEqual(
			["tagged-old", rootNodeId].sort(),
		);
	});
});
