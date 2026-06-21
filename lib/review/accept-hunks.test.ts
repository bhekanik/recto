import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import schema from "@/convex/schema";
import { applyAcceptedHunks, diffRuns, groupHunks } from "@/lib/history/diff";

// Explicit module map for convex-test (mirrors lib/review/access.test.ts). Keys
// must include a "_generated" path so convex-test can locate the bundle root.
const modules: Record<string, () => Promise<unknown>> = {
	"../../convex/schema.ts": () => import("@/convex/schema"),
	"../../convex/documents.ts": () => import("@/convex/documents"),
	"../../convex/docNodes.ts": () => import("@/convex/docNodes"),
	"../../convex/versions.ts": () => import("@/convex/versions"),
	"../../convex/history.ts": () => import("@/convex/history"),
	"../../convex/review.ts": () => import("@/convex/review"),
	"../../convex/_generated/api.js": () => import("@/convex/_generated/api"),
	"../../convex/_generated/server.js": () =>
		import("@/convex/_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const REVIEWER = { subject: "reviewer-user", email: "reviewer@example.com" };

const fullReplacePatch = (from: string, to: string): string =>
	JSON.stringify({ from: 0, to: from.length, insert: to });

/**
 * Owner doc with one typed node (`ownerText`) and a suggester share for REVIEWER,
 * then a reviewer branch whose head materializes to `branchText`. Returns the ids
 * needed to drive accept paths. Mirrors the setup in access.test.ts.
 */
async function docWithReviewerBranch(
	t: ReturnType<typeof convexTest>,
	ownerText: string,
	branchText: string,
) {
	const owner = t.withIdentity(OWNER);
	const reviewer = t.withIdentity(REVIEWER);

	const { documentId, rootNodeId } = await owner.mutation(
		api.documents.create,
		{ title: "Draft" },
	);
	const created = await t.run(async (ctx) => ctx.db.get(documentId));
	const baseTime = (created?.updatedAt ?? Date.now()) + 1000;

	const ownerNodeId = crypto.randomUUID();
	await owner.mutation(api.docNodes.append, {
		documentId,
		nodeId: ownerNodeId,
		parentNodeId: rootNodeId,
		patch: fullReplacePatch("", ownerText),
		snapshot: ownerText,
		selection: null,
		origin: "device-owner",
		createdAt: baseTime,
	});
	await owner.mutation(api.documents.updateCurrentNodeId, {
		documentId,
		currentNodeId: ownerNodeId,
		markdown: ownerText,
		wordCount: ownerText.split(/\s+/).length,
		updatedAt: baseTime,
	});

	await owner.mutation(api.review.addShare, {
		documentId,
		email: REVIEWER.email,
		role: "suggester",
	});

	const revNodeId = crypto.randomUUID();
	const r = await reviewer.mutation(api.review.reviewerAppend, {
		documentId,
		nodeId: revNodeId,
		parentNodeId: ownerNodeId,
		patch: fullReplacePatch(ownerText, branchText),
		snapshot: branchText,
		selection: null,
		createdAt: baseTime + 1000,
	});

	return {
		owner,
		reviewer,
		documentId,
		ownerNodeId,
		branchId: r.branchId as Id<"reviewBranches">,
	};
}

describe("review.acceptHunks — partial accept (per-hunk)", () => {
	it("applies ONLY the accepted hunk to the owner doc (additive merge forward)", async () => {
		const t = convexTest(schema, modules);
		const ownerText = "the quick brown fox jumps";
		const branchText = "the slow brown fox leaps";
		const { owner, documentId, ownerNodeId, branchId } =
			await docWithReviewerBranch(t, ownerText, branchText);

		// Two hunks: "quick"→"slow" (0) and "jumps"→"leaps" (1). Accept only hunk 0.
		const runs = diffRuns(ownerText, branchText, "word");
		const hunks = groupHunks(runs);
		expect(hunks).toHaveLength(2);
		const expected = applyAcceptedHunks(runs, [0]);
		expect(expected).toBe("the slow brown fox jumps");

		const res = await owner.mutation(api.review.acceptHunks, {
			documentId,
			branchId,
			granularity: "word",
			acceptedHunks: [0],
		});
		expect(res.markdown).toBe(expected);

		// Owner doc now reflects the partial merge; the new tip is additive (parented
		// at the owner's prior current node) and the old node survives.
		const doc = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc?.markdown).toBe(expected);
		expect(doc?.currentNodeId).toBe(res.newNodeId);
		const newNode = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.find((n) => n.nodeId === res.newNodeId);
		});
		expect(newNode?.parentNodeId).toBe(ownerNodeId);
		expect(newNode?.origin).toBe("review-accept");

		// Branch is resolved (accepted) — it leaves the review surface.
		const resolved = await t.run(async (ctx) => ctx.db.get(branchId));
		expect(resolved?.status).toBe("accepted");
	});

	it("rejecting a hunk excludes it: accepting the OTHER hunk keeps the rejected change out", async () => {
		const t = convexTest(schema, modules);
		const ownerText = "the quick brown fox jumps";
		const branchText = "the slow brown fox leaps";
		const { owner, documentId, branchId } = await docWithReviewerBranch(
			t,
			ownerText,
			branchText,
		);

		// Accept only hunk 1 ("jumps"→"leaps"); hunk 0 ("quick"→"slow") is rejected.
		const res = await owner.mutation(api.review.acceptHunks, {
			documentId,
			branchId,
			granularity: "word",
			acceptedHunks: [1],
		});
		expect(res.markdown).toBe("the quick brown fox leaps");
		const doc = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc?.markdown).toBe("the quick brown fox leaps");
	});

	it("accepting ALL hunks via acceptHunks equals the whole branch head", async () => {
		const t = convexTest(schema, modules);
		const ownerText = "the quick brown fox jumps";
		const branchText = "the slow brown fox leaps";
		const { owner, documentId, branchId } = await docWithReviewerBranch(
			t,
			ownerText,
			branchText,
		);

		const res = await owner.mutation(api.review.acceptHunks, {
			documentId,
			branchId,
			granularity: "word",
			acceptedHunks: [0, 1],
		});
		expect(res.markdown).toBe(branchText);
		const doc = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc?.markdown).toBe(branchText);
	});

	it("empty acceptedHunks resolves the branch as a no-op on data (like reject)", async () => {
		const t = convexTest(schema, modules);
		const ownerText = "the quick brown fox jumps";
		const branchText = "the slow brown fox leaps";
		const { owner, documentId, branchId } = await docWithReviewerBranch(
			t,
			ownerText,
			branchText,
		);
		const before = await t.run(async (ctx) => ctx.db.get(documentId));
		const nodeCountBefore = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.length;
		});

		const res = await owner.mutation(api.review.acceptHunks, {
			documentId,
			branchId,
			granularity: "word",
			acceptedHunks: [],
		});
		expect(res.newNodeId).toBeNull();
		expect(res.markdown).toBe(ownerText);

		// Owner doc untouched; no new node appended.
		const after = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(after?.markdown).toBe(before?.markdown);
		expect(after?.currentNodeId).toBe(before?.currentNodeId);
		const nodeCountAfter = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("docNodes")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect();
			return rows.length;
		});
		expect(nodeCountAfter).toBe(nodeCountBefore);

		// But the branch IS resolved.
		const resolved = await t.run(async (ctx) => ctx.db.get(branchId));
		expect(resolved?.status).toBe("accepted");
	});

	it("rejects an out-of-range hunk index (stale selection fails closed)", async () => {
		const t = convexTest(schema, modules);
		const { owner, documentId, branchId } = await docWithReviewerBranch(
			t,
			"the quick brown fox jumps",
			"the slow brown fox leaps",
		);
		await expect(
			owner.mutation(api.review.acceptHunks, {
				documentId,
				branchId,
				granularity: "word",
				acceptedHunks: [0, 99], // 99 is out of range → stale
			}),
		).rejects.toThrow("Stale hunk selection");
	});

	it("is owner-only (a reviewer cannot partial-accept)", async () => {
		const t = convexTest(schema, modules);
		const { reviewer, documentId, branchId } = await docWithReviewerBranch(
			t,
			"the quick brown fox jumps",
			"the slow brown fox leaps",
		);
		await expect(
			reviewer.mutation(api.review.acceptHunks, {
				documentId,
				branchId,
				granularity: "word",
				acceptedHunks: [0],
			}),
		).rejects.toThrow("Document not found");
	});
});

describe("review — per-edit AI suggestions are independently acceptable (Phase B)", () => {
	it("two AI edits at distinct locations become two hunks, each accept/rejectable", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		// Owner doc with two distinct sentences the AI will each touch.
		const ownerText = "The cat sat. The dog ran.";
		const { documentId, rootNodeId } = await owner.mutation(
			api.documents.create,
			{ title: "Draft" },
		);
		const created = await t.run(async (ctx) => ctx.db.get(documentId));
		const baseTime = (created?.updatedAt ?? Date.now()) + 1000;
		const ownerNodeId = crypto.randomUUID();
		await owner.mutation(api.docNodes.append, {
			documentId,
			nodeId: ownerNodeId,
			parentNodeId: rootNodeId,
			patch: fullReplacePatch("", ownerText),
			snapshot: ownerText,
			selection: null,
			origin: "device-owner",
			createdAt: baseTime,
		});
		await owner.mutation(api.documents.updateCurrentNodeId, {
			documentId,
			currentNodeId: ownerNodeId,
			markdown: ownerText,
			wordCount: ownerText.split(/\s+/).length,
			updatedAt: baseTime,
		});

		// The AI merges BOTH edits into one branch markdown (mirrors applyEdits).
		const aiBranchMarkdown = "The cat napped. The dog sprinted.";
		const { branchId } = await owner.mutation(api.review.aiSuggestBranch, {
			documentId,
			branchMarkdown: aiBranchMarkdown,
		});

		// The branch diff surfaces the two AI edits as two independent hunks.
		const runs = diffRuns(ownerText, aiBranchMarkdown, "word");
		const hunks = groupHunks(runs);
		expect(hunks.length).toBe(2);

		// Owner accepts only the FIRST AI edit; the second is rejected.
		const res = await owner.mutation(api.review.acceptHunks, {
			documentId,
			branchId: branchId as Id<"reviewBranches">,
			granularity: "word",
			acceptedHunks: [0],
		});
		// First edit applied ("sat"→"napped"); second edit discarded ("ran" kept).
		expect(res.markdown).toBe("The cat napped. The dog ran.");
		const doc = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc?.markdown).toBe("The cat napped. The dog ran.");
	});
});

describe("review.acceptBranch — whole-branch accept still works (back-compat regression)", () => {
	it("accepts the entire branch head verbatim (unchanged path)", async () => {
		const t = convexTest(schema, modules);
		const ownerText = "the quick brown fox jumps";
		const branchText = "the slow brown fox leaps";
		const { owner, documentId, branchId } = await docWithReviewerBranch(
			t,
			ownerText,
			branchText,
		);

		const res = await owner.mutation(api.review.acceptBranch, {
			documentId,
			branchId,
		});
		expect(res.markdown).toBe(branchText);
		const doc = await t.run(async (ctx) => ctx.db.get(documentId));
		expect(doc?.markdown).toBe(branchText);
		const resolved = await t.run(async (ctx) => ctx.db.get(branchId));
		expect(resolved?.status).toBe("accepted");
	});
});
