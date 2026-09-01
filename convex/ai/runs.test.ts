import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = {
	"./ai/runs.ts": () => import("./runs"),
	"./ai/limits.ts": () => import("./limits"),
	"./documents.ts": () => import("../documents"),
	"./review.ts": () => import("../review"),
	"./embeddings.ts": () => import("../embeddings"),
	"./blobReferences.ts": () => import("../blobReferences"),
	"./accountGuard.ts": () => import("../accountGuard"),
	"./_generated/api.js": () => import("../_generated/api"),
	"./_generated/server.js": () => import("../_generated/server"),
};

const USER = "owner-user";

async function seedRun(
	t: ReturnType<typeof convexTest>,
	status: "reserved" | "provider_started" = "provider_started",
) {
	return await t.run(async (ctx) => {
		const documentId = await ctx.db.insert("documents", {
			userId: USER,
			title: "Draft",
			markdown: "source",
			wordCount: 1,
			currentNodeId: "source",
			createdAt: 1,
			updatedAt: 1,
		});
		await ctx.db.insert("docNodes", {
			documentId,
			nodeId: "source",
			parentNodeId: null,
			patch: "",
			snapshot: "source",
			selection: null,
			origin: "edit",
			createdAt: 1,
		});
		await ctx.db.insert("aiConsents", {
			userId: USER,
			version: 1,
			acceptedAt: 1,
		});
		const runId = await ctx.db.insert("aiRuns", {
			userId: USER,
			requestId: crypto.randomUUID(),
			kind: "transform",
			documentId,
			sourceNodeId: "source",
			sourceHash: "a".repeat(64),
			requestHash: "b".repeat(64),
			model: "model",
			status,
			keySource: status === "provider_started" ? "house" : undefined,
			createdAt: 1,
			updatedAt: 1,
		});
		return { documentId, runId };
	});
}

describe("AI run durability", () => {
	it("applies review comments and a branch atomically at the reserved head", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seedRun(t);
		const result = await t.mutation(internal.review.applyAiReview, {
			userId: USER,
			documentId,
			sourceNodeId: "source",
			sourceText: "source",
			comments: [
				{
					anchor: { quote: "source", prefix: "", suffix: "", offsetHint: 0 },
					body: "Clarify this.",
				},
			],
			branchMarkdown: "clear source",
		});
		expect(result.commentsPlaced).toBe(1);
		expect(result.branchId).not.toBeNull();
		const rows = await t.run(async (ctx) => ({
			comments: await ctx.db
				.query("comments")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
			branches: await ctx.db
				.query("reviewBranches")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
		}));
		expect(rows.comments).toHaveLength(1);
		expect(rows.branches).toHaveLength(1);
	});

	it("refuses all review writes after source movement or sharing", async () => {
		for (const boundary of ["head", "share"] as const) {
			const t = convexTest(schema, modules);
			const { documentId } = await seedRun(t);
			await t.run(async (ctx) => {
				if (boundary === "head") {
					await ctx.db.patch(documentId, { currentNodeId: "later" });
				} else {
					await ctx.db.insert("documentShares", {
						documentId,
						ownerUserId: USER,
						granteeEmail: "reviewer@example.com",
						role: "commenter",
						createdAt: 1,
					});
				}
			});
			await expect(
				t.mutation(internal.review.applyAiReview, {
					userId: USER,
					documentId,
					sourceNodeId: "source",
					sourceText: "source",
					comments: [
						{
							anchor: {
								quote: "source",
								prefix: "",
								suffix: "",
								offsetHint: 0,
							},
							body: "No write",
						},
					],
					branchMarkdown: "changed",
				}),
			).rejects.toThrow();
			const counts = await t.run(async (ctx) => ({
				comments: (await ctx.db.query("comments").collect()).length,
				branches: (await ctx.db.query("reviewBranches").collect()).length,
			}));
			expect(counts).toEqual({ comments: 0, branches: 0 });
		}
	});

	it("keeps provider network uncertainty non-terminal and non-cancellable", async () => {
		const t = convexTest(schema, modules);
		const { runId } = await seedRun(t);
		await t.mutation(internal.ai.runs.finishError, {
			runId,
			userId: USER,
			errorCode: "network_error",
			outcomeUnknown: true,
		});
		const run = await t.run(async (ctx) => await ctx.db.get(runId));
		expect(run?.status).toBe("outcome_unknown");
		const cancelled = await t
			.withIdentity({ subject: USER })
			.mutation(api.ai.runs.cancel, { requestId: run?.requestId ?? "" });
		expect(cancelled).toEqual({ cancelled: false, reason: "outcome_unknown" });
	});

	it("settles known setup failure while still reserved", async () => {
		const t = convexTest(schema, modules);
		const { runId } = await seedRun(t, "reserved");
		await t.mutation(internal.ai.runs.finishError, {
			runId,
			userId: USER,
			errorCode: "ai_credential_required",
			outcomeUnknown: false,
		});
		const run = await t.run(async (ctx) => await ctx.db.get(runId));
		expect(run?.status).toBe("failed");
	});

	it("records charged usage before refusing a stale result", async () => {
		const t = convexTest(schema, modules);
		const { documentId, runId } = await seedRun(t);
		await t.run(
			async (ctx) => await ctx.db.patch(documentId, { currentNodeId: "later" }),
		);
		const result = await t.mutation(internal.ai.runs.succeed, {
			runId,
			userId: USER,
			output: "result",
			expectedSourceMarkdown: "source",
			usage: {
				promptTokens: 10,
				completionTokens: 2,
				reasoningTokens: 1,
				costMicros: 42,
				latencyMs: 100,
			},
		});
		expect(result.applicable).toBe(false);
		const snapshot = await t.run(async (ctx) => ({
			run: await ctx.db.get(runId),
			usage: await ctx.db
				.query("aiUsage")
				.withIndex("by_run", (q) => q.eq("runId", runId))
				.collect(),
		}));
		expect(snapshot.run?.status).toBe("succeeded");
		expect(snapshot.usage).toHaveLength(1);
		expect(snapshot.usage[0]?.costMicros).toBe(42);
	});

	it("refuses same-head draft drift after recording provider usage", async () => {
		const t = convexTest(schema, modules);
		const { documentId, runId } = await seedRun(t);
		await t.run(
			async (ctx) =>
				await ctx.db.patch(documentId, { markdown: "draft changed" }),
		);
		const result = await t.mutation(internal.ai.runs.succeed, {
			runId,
			userId: USER,
			output: "result",
			expectedSourceMarkdown: "source",
			usage: {
				promptTokens: 1,
				completionTokens: 1,
				reasoningTokens: 0,
				costMicros: 3,
				latencyMs: 1,
			},
		});
		expect(result.applicable).toBe(false);
		expect(
			await t.run(
				async (ctx) =>
					await ctx.db
						.query("aiUsage")
						.withIndex("by_run", (q) => q.eq("runId", runId))
						.unique(),
			),
		).not.toBeNull();
	});

	it("refuses same-head draft drift for review and vector persistence", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seedRun(t);
		await t.run(
			async (ctx) =>
				await ctx.db.patch(documentId, { markdown: "draft changed" }),
		);
		await expect(
			t.mutation(internal.review.applyAiReview, {
				userId: USER,
				documentId,
				sourceNodeId: "source",
				sourceText: "source",
				comments: [
					{
						anchor: { quote: "source", prefix: "", suffix: "", offsetHint: 0 },
						body: "No",
					},
				],
			}),
		).rejects.toThrow("draft changed");
		await expect(
			t.withIdentity({ subject: USER }).mutation(api.embeddings.replaceChunks, {
				documentId,
				embeddedNodeId: "source",
				expectedMarkdown: "source",
				chunks: [],
			}),
		).rejects.toThrow("draft changed");
	});

	it("drains deletion ledgers in bounded idempotent batches", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seedRun(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("aiDocumentDeletions", {
				documentId,
				userId: USER,
				createdAt: 1,
				updatedAt: 1,
			});
			for (let index = 0; index < 130; index += 1) {
				const runId = await ctx.db.insert("aiRuns", {
					userId: USER,
					requestId: `cleanup-${index}`,
					kind: "embed",
					documentId,
					sourceNodeId: "source",
					sourceHash: "a".repeat(64),
					requestHash: `hash-${index}`,
					model: "model",
					status: "succeeded",
					keySource: "house",
					createdAt: index + 2,
					updatedAt: index + 2,
				});
				await ctx.db.insert("aiUsage", {
					userId: USER,
					runId,
					kind: "embed",
					model: "model",
					promptTokens: 1,
					completionTokens: 0,
					reasoningTokens: 0,
					costMicros: 1,
					keySource: "house",
					latencyMs: 1,
					documentId,
					createdAt: index + 2,
				});
			}
		});
		const first = await t.mutation(internal.ai.runs.cleanupDeletedDocument, {
			documentId,
		});
		expect(first).toEqual({ done: false, deleted: 128 });
		let result = first;
		for (let attempt = 0; attempt < 5 && !result.done; attempt += 1) {
			result = await t.mutation(internal.ai.runs.cleanupDeletedDocument, {
				documentId,
			});
		}
		expect(result.done).toBe(true);
		const remaining = await t.run(async (ctx) => ({
			usage: await ctx.db
				.query("aiUsage")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
			runs: await ctx.db
				.query("aiRuns")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.collect(),
			job: await ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", documentId))
				.unique(),
		}));
		expect(remaining).toEqual({ usage: [], runs: [], job: null });
		await expect(
			t.mutation(internal.ai.runs.cleanupDeletedDocument, { documentId }),
		).resolves.toEqual({ done: true, deleted: 0 });
	});
});
