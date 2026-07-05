import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@/convex/_generated/api";
import schema from "@/convex/schema";

// Explicit module map for convex-test (keys must include a "_generated" path so
// convex-test can locate the function-bundle root). Mirrors
// lib/review/access.test.ts.
const modules: Record<string, () => Promise<unknown>> = {
	"../../convex/schema.ts": () => import("@/convex/schema"),
	"../../convex/documents.ts": () => import("@/convex/documents"),
	"../../convex/embeddings.ts": () => import("@/convex/embeddings"),
	"../../convex/_generated/api.js": () => import("@/convex/_generated/api"),
	"../../convex/_generated/server.js": () =>
		import("@/convex/_generated/server"),
};

const USER = { subject: "user-1", email: "user@example.com" };

/** Must match AI_EMBEDDING_DIM / the docChunks vectorIndex (1536). */
const DIM = 1536;

function docRow(currentNodeId: string) {
	return {
		userId: USER.subject,
		title: "Draft",
		markdown: "Some words.",
		wordCount: 2,
		currentNodeId,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("plan 015 — embeddingHealth query", () => {
	it("rejects unauthenticated callers", async () => {
		const t = convexTest(schema, modules);
		await expect(t.query(api.embeddings.embeddingHealth, {})).rejects.toThrow(
			"Unauthenticated",
		);
	});

	it("returns 0 stale on an empty deployment", async () => {
		const t = convexTest(schema, modules);
		const health = await t
			.withIdentity(USER)
			.query(api.embeddings.embeddingHealth, {});
		expect(health).toEqual({ staleCount: 0 });
	});

	it("counts never-embedded and out-of-date docs, not freshly embedded ones", async () => {
		const t = convexTest(schema, modules);

		// Doc A: no chunks at all → stale.
		// Doc B: chunk embedded at the current node → fresh.
		// Doc C: chunk embedded at a prior node → stale.
		const { docB, docC } = await t.run(async (ctx) => {
			await ctx.db.insert("documents", docRow("node-a1"));
			const docB = await ctx.db.insert("documents", docRow("node-b1"));
			const docC = await ctx.db.insert("documents", docRow("node-c2"));
			return { docB, docC };
		});

		await t.run(async (ctx) => {
			await ctx.db.insert("docChunks", {
				userId: USER.subject,
				documentId: docB,
				charStart: 0,
				charEnd: 11,
				text: "Some words.",
				embedding: new Array(DIM).fill(0),
				embeddedNodeId: "node-b1", // matches currentNodeId → fresh
				updatedAt: 2,
			});
			await ctx.db.insert("docChunks", {
				userId: USER.subject,
				documentId: docC,
				charStart: 0,
				charEnd: 11,
				text: "Some words.",
				embedding: new Array(DIM).fill(0),
				embeddedNodeId: "node-c1", // behind currentNodeId → stale
				updatedAt: 2,
			});
		});

		const health = await t
			.withIdentity(USER)
			.query(api.embeddings.embeddingHealth, {});
		expect(health).toEqual({ staleCount: 2 });
	});
});
