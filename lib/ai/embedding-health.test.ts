import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "@/convex/_generated/api";
import { scheduledEmbedRequestId } from "@/convex/embeddings";
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

function docRow(currentNodeId: string, markdown = "Some words.") {
	return {
		userId: USER.subject,
		title: "Draft",
		markdown,
		wordCount: markdown.trim() === "" ? 0 : 2,
		currentNodeId,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("plan 015 — embeddingHealth query", () => {
	it("keys scheduled batches by source, offset, and exact inputs", async () => {
		const request = (
			overrides: Partial<Parameters<typeof scheduledEmbedRequestId>[0]> = {},
		) =>
			scheduledEmbedRequestId({
				documentId: "doc",
				sourceNodeId: "node-1",
				sourceHash: "a".repeat(64),
				offset: 0,
				inputs: ["first"],
				...overrides,
			});
		const original = await request();
		expect(await request()).toBe(original);
		expect(await request({ sourceNodeId: "node-2" })).not.toBe(original);
		expect(await request({ offset: 16 })).not.toBe(original);
		expect(await request({ inputs: ["second"] })).not.toBe(original);
		expect(original.length).toBeLessThanOrEqual(128);
	});

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

	it("does not count an empty document with no chunks as stale", async () => {
		const t = convexTest(schema, modules);

		// Empty markdown chunks to nothing and there are no rows to purge — a
		// permanently-uncounted doc, NOT a permanently-stale one (the sweep can
		// never persist an embeddedNodeId without chunk rows).
		await t.run(async (ctx) => {
			await ctx.db.insert("documents", docRow("node-empty", ""));
		});

		const health = await t
			.withIdentity(USER)
			.query(api.embeddings.embeddingHealth, {});
		expect(health).toEqual({ staleCount: 0 });
	});

	it("counts a document with real markdown and no chunks as stale", async () => {
		const t = convexTest(schema, modules);

		// Regression guard: the zero-chunk skip must not swallow never-embedded
		// docs that DO have embeddable content.
		await t.run(async (ctx) => {
			await ctx.db.insert("documents", docRow("node-never-embedded"));
		});

		const health = await t
			.withIdentity(USER)
			.query(api.embeddings.embeddingHealth, {});
		expect(health).toEqual({ staleCount: 1 });
	});

	it("pages past 256 documents and publishes the full-corpus health count", async () => {
		const previousAllowlist = process.env.AI_UNMETERED_USER_IDS;
		process.env.AI_UNMETERED_USER_IDS = USER.subject;
		try {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				await ctx.db.insert("aiConsents", {
					userId: USER.subject,
					version: 1,
					acceptedAt: 1,
				});
				for (let index = 0; index < 300; index += 1) {
					const nodeId = `node-${index}`;
					const documentId = await ctx.db.insert(
						"documents",
						docRow(nodeId, `draft ${index}`),
					);
					await ctx.db.insert("docNodes", {
						documentId,
						nodeId,
						parentNodeId: null,
						patch: "",
						snapshot: `draft ${index}`,
						selection: null,
						origin: "test",
						createdAt: index + 1,
					});
				}
			});

			const first = await t.query(internal.embeddings.allStaleDocuments, {
				cursor: null,
			});
			const second = await t.query(internal.embeddings.allStaleDocuments, {
				cursor: first.continueCursor,
			});
			expect(first).toMatchObject({ scanned: 256, isDone: false });
			expect(second).toMatchObject({ scanned: 44, isDone: true });
			expect(first.staleCount + second.staleCount).toBe(300);
			const ids = [...first.stale, ...second.stale].map(
				(document) => document.documentId,
			);
			expect(ids).toHaveLength(300);
			expect(new Set(ids).size).toBe(300);
			await expect(
				t.withIdentity(USER).query(api.embeddings.embeddingHealth, {}),
			).resolves.toEqual({ staleCount: null });

			await t.mutation(internal.embeddings.recordEmbeddingHealth, {
				staleCount: ids.length,
				scannedCount: 300,
			});
			await expect(
				t.withIdentity(USER).query(api.embeddings.embeddingHealth, {}),
			).resolves.toEqual({ staleCount: 300 });
		} finally {
			if (previousAllowlist === undefined) {
				delete process.env.AI_UNMETERED_USER_IDS;
			} else {
				process.env.AI_UNMETERED_USER_IDS = previousAllowlist;
			}
		}
	});
});
