import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@/convex/_generated/api";
import { applyPatch, parsePatch } from "@/convex/history";
import schema from "@/convex/schema";

// Mirrors lib/review/access.test.ts — explicit module map so convex-test can
// locate the function-bundle root (keys split on "_generated").
const modules: Record<string, () => Promise<unknown>> = {
	"../../convex/schema.ts": () => import("@/convex/schema"),
	"../../convex/documents.ts": () => import("@/convex/documents"),
	"../../convex/docNodes.ts": () => import("@/convex/docNodes"),
	"../../convex/versions.ts": () => import("@/convex/versions"),
	"../../convex/history.ts": () => import("@/convex/history"),
	"../../convex/review.ts": () => import("@/convex/review"),
	"../../convex/embeddings.ts": () => import("@/convex/embeddings"),
	"../../convex/_generated/api.js": () => import("@/convex/_generated/api"),
	"../../convex/_generated/server.js": () =>
		import("@/convex/_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const REVIEWER = { subject: "reviewer-user", email: "reviewer@example.com" };

const fullReplacePatch = (from: string, to: string): string =>
	JSON.stringify({ from: 0, to: from.length, insert: to });

/** Owner doc with one typed node ("ownerText") + a suggester share for REVIEWER. */
async function sharedDocWithText(
	t: ReturnType<typeof convexTest>,
	text: string,
) {
	const owner = t.withIdentity(OWNER);
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
		patch: fullReplacePatch("", text),
		snapshot: text,
		selection: null,
		origin: "device-owner",
		createdAt: baseTime,
	});
	await owner.mutation(api.documents.updateCurrentNodeId, {
		documentId,
		currentNodeId: ownerNodeId,
		markdown: text,
		wordCount: text.split(/\s+/).length,
		updatedAt: baseTime,
	});
	await owner.mutation(api.review.addShare, {
		documentId,
		email: REVIEWER.email,
		role: "suggester",
	});
	return { documentId, rootNodeId, ownerNodeId, baseTime };
}

describe("history.parsePatch / applyPatch validation", () => {
	it("parsePatch accepts a well-formed in-bounds patch", () => {
		expect(
			parsePatch(JSON.stringify({ from: 0, to: 3, insert: "x" }), 5),
		).toEqual({ from: 0, to: 3, insert: "x" });
	});

	it("parsePatch rejects malformed JSON, bad shapes, and out-of-range bounds", () => {
		expect(parsePatch("{not json", 5)).toBeNull();
		expect(parsePatch(JSON.stringify({ from: 0, to: 1 }), 5)).toBeNull(); // no insert
		expect(
			parsePatch(JSON.stringify({ from: "0", to: 1, insert: "" }), 5),
		).toBeNull();
		expect(
			parsePatch(JSON.stringify({ from: 0.5, to: 1, insert: "" }), 5),
		).toBeNull();
		expect(
			parsePatch(JSON.stringify({ from: -1, to: 1, insert: "" }), 5),
		).toBeNull();
		expect(
			parsePatch(JSON.stringify({ from: 2, to: 1, insert: "" }), 5),
		).toBeNull(); // to < from
		expect(
			parsePatch(JSON.stringify({ from: 0, to: 6, insert: "" }), 5),
		).toBeNull(); // to > len
	});

	it("applyPatch throws a clean error on a malformed patch instead of a raw SyntaxError", () => {
		expect(() => applyPatch("hello", "{not json")).toThrow("Malformed patch");
		expect(() =>
			applyPatch("hi", JSON.stringify({ from: 0, to: 99, insert: "x" })),
		).toThrow("Malformed patch");
	});

	it("applyPatch applies a valid patch", () => {
		expect(applyPatch("hello", fullReplacePatch("hello", "world"))).toBe(
			"world",
		);
	});
});

describe("review.reviewerAppend — suggester input validation", () => {
	it("rejects a patch whose parentNodeId is not a node in the document", async () => {
		const t = convexTest(schema, modules);
		const reviewer = t.withIdentity(REVIEWER);
		const { documentId } = await sharedDocWithText(t, "Base text.");

		await expect(
			reviewer.mutation(api.review.reviewerAppend, {
				documentId,
				nodeId: crypto.randomUUID(),
				parentNodeId: "does-not-exist",
				patch: fullReplacePatch("Base text.", "Edited."),
				selection: null,
				createdAt: 3000,
			}),
		).rejects.toThrow("Parent node not found");
	});

	it("rejects an out-of-range patch (from/to beyond the parent markdown bounds)", async () => {
		const t = convexTest(schema, modules);
		const reviewer = t.withIdentity(REVIEWER);
		const ownerText = "Base text.";
		const { documentId, ownerNodeId } = await sharedDocWithText(t, ownerText);

		// Parent materializes to ownerText (length 10); `to` 9999 is out of range.
		await expect(
			reviewer.mutation(api.review.reviewerAppend, {
				documentId,
				nodeId: crypto.randomUUID(),
				parentNodeId: ownerNodeId,
				patch: JSON.stringify({ from: 0, to: 9999, insert: "x" }),
				selection: null,
				createdAt: 3000,
			}),
		).rejects.toThrow("Malformed patch");
	});

	it("rejects a malformed (non-JSON) patch", async () => {
		const t = convexTest(schema, modules);
		const reviewer = t.withIdentity(REVIEWER);
		const { documentId, ownerNodeId } = await sharedDocWithText(t, "Base.");

		await expect(
			reviewer.mutation(api.review.reviewerAppend, {
				documentId,
				nodeId: crypto.randomUUID(),
				parentNodeId: ownerNodeId,
				patch: "{not valid json",
				selection: null,
				createdAt: 3000,
			}),
		).rejects.toThrow("Malformed patch");
	});

	it("rejects an oversized snapshot (over the ~1 MiB cap)", async () => {
		const t = convexTest(schema, modules);
		const reviewer = t.withIdentity(REVIEWER);
		const { documentId, ownerNodeId } = await sharedDocWithText(t, "Base.");
		const huge = "x".repeat(950_001);

		await expect(
			reviewer.mutation(api.review.reviewerAppend, {
				documentId,
				nodeId: crypto.randomUUID(),
				parentNodeId: ownerNodeId,
				patch: fullReplacePatch("Base.", "ok"),
				snapshot: huge,
				selection: null,
				createdAt: 3000,
			}),
		).rejects.toThrow("size limit");
	});

	it("accepts a valid suggester append (regression guard)", async () => {
		const t = convexTest(schema, modules);
		const reviewer = t.withIdentity(REVIEWER);
		const ownerText = "Base text.";
		const { documentId, ownerNodeId } = await sharedDocWithText(t, ownerText);
		const newText = `${ownerText} A suggestion.`;

		const res = await reviewer.mutation(api.review.reviewerAppend, {
			documentId,
			nodeId: crypto.randomUUID(),
			parentNodeId: ownerNodeId,
			patch: fullReplacePatch(ownerText, newText),
			snapshot: newText,
			selection: null,
			createdAt: 3000,
		});
		expect(res.branchId).toBeDefined();
	});
});

describe("review.aiSuggestBranch — branch markdown size cap", () => {
	it("rejects branchMarkdown over the ~1 MiB cap", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId } = await sharedDocWithText(t, "Owner draft.");

		await expect(
			owner.mutation(api.review.aiSuggestBranch, {
				documentId,
				branchMarkdown: "x".repeat(950_001),
			}),
		).rejects.toThrow("size limit");
	});
});

describe("versions.create — node existence", () => {
	it("rejects tagging a nodeId that does not exist in the document", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId } = await sharedDocWithText(t, "Owner draft.");

		await expect(
			owner.mutation(api.versions.create, {
				documentId,
				nodeId: "phantom-node",
				label: "v1",
				kind: "manual",
			}),
		).rejects.toThrow("Node not found");
	});

	it("accepts tagging an existing node", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId, ownerNodeId } = await sharedDocWithText(
			t,
			"Owner draft.",
		);

		const res = await owner.mutation(api.versions.create, {
			documentId,
			nodeId: ownerNodeId,
			label: "v1",
			kind: "manual",
		});
		expect(res.versionId).toBeDefined();
	});
});

describe("documents.updateCurrentNodeId — markdown size cap", () => {
	it("rejects markdown over the ~1 MiB cap", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const { documentId, ownerNodeId, baseTime } = await sharedDocWithText(
			t,
			"Owner draft.",
		);

		await expect(
			owner.mutation(api.documents.updateCurrentNodeId, {
				documentId,
				currentNodeId: ownerNodeId,
				markdown: "x".repeat(950_001),
				wordCount: 1,
				updatedAt: baseTime + 1000,
			}),
		).rejects.toThrow("size limit");
	});
});

describe("embeddings.searchByVector — query vector dimension", () => {
	it("rejects a wrong-dimension query vector", async () => {
		const t = convexTest(schema, modules);
		const caller = t.withIdentity(OWNER);
		// 3 ≠ AI_EMBEDDING_DIM (1536) — rejected before ctx.vectorSearch runs.
		await expect(
			caller.action(api.embeddings.searchByVector, {
				vector: [0.1, 0.2, 0.3],
			}),
		).rejects.toThrow("expected 1536");
	});

	it("accepts a correctly-dimensioned vector (returns empty with no chunks)", async () => {
		const t = convexTest(schema, modules);
		const caller = t.withIdentity(OWNER);
		const vector = Array.from({ length: 1536 }, () => 0);
		const res = await caller.action(api.embeddings.searchByVector, { vector });
		expect(res).toEqual([]);
	});
});
