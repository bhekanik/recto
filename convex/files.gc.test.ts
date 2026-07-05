import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Explicit module map for convex-test (mirrors lib/review/access.test.ts).
// Keys must include a "_generated" path so convex-test can locate the
// function-bundle root (it splits a key on "_generated"). Relative imports —
// this file lives inside convex/, and the convex tsconfig (used by
// `convex codegen`) has no "@/*" path alias.
const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./files.ts": () => import("./files"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };

describe("plan 013 — document delete GC", () => {
	it("documents.remove cascades docChunks", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		const { documentId } = await owner.mutation(api.documents.create, {
			title: "Draft",
		});

		await t.run(async (ctx) => {
			await ctx.db.insert("docChunks", {
				userId: OWNER.subject,
				documentId,
				charStart: 0,
				charEnd: 5,
				text: "alpha",
				embedding: new Array(1536).fill(0),
				embeddedNodeId: "node-1",
				updatedAt: Date.now(),
			});
			await ctx.db.insert("docChunks", {
				userId: OWNER.subject,
				documentId,
				charStart: 5,
				charEnd: 10,
				text: "bravo",
				embedding: new Array(1536).fill(0.5),
				embeddedNodeId: "node-1",
				updatedAt: Date.now(),
			});
		});

		await owner.mutation(api.documents.remove, { documentId });

		const remaining = await t.run(async (ctx) =>
			ctx.db
				.query("docChunks")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
		);
		expect(remaining).toHaveLength(0);
	});
});
