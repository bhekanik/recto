import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { getDocumentSize } from "convex/values";
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
	"./documentCleanup.ts": () => import("../documentCleanup"),
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
			sourceMarkdown: "source",
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

async function settleRun(
	t: ReturnType<typeof convexTest>,
	runId: Awaited<ReturnType<typeof seedRun>>["runId"],
) {
	return await t.mutation(internal.ai.runs.succeed, {
		runId,
		userId: USER,
		output: "result",
		expectedSourceMarkdown: "source",
		usage: {
			promptTokens: 1,
			completionTokens: 1,
			reasoningTokens: 0,
			costMicros: 2,
			latencyMs: 1,
		},
	});
}

describe("AI run durability", () => {
	it.each([
		"failed",
		"cancelled",
	] as const)("fully resets an acknowledged %s run before retry", async (status) => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const { documentId, runId } = await seedRun(t);
		const original = await t.run(async (ctx) => {
			await ctx.db.patch(runId, {
				status,
				keySource: undefined,
				output: "stale output",
				errorCode: "stale_error",
				langsmithRunId: "stale-trace",
				providerStartedAt: 2,
				completedAt: 3,
				acknowledgedAt: 4,
				applicable: true,
			});
			return await ctx.db.get(runId);
		});
		if (!original) throw new Error("missing seeded run");
		const retried = await t.mutation(internal.ai.runs.begin, {
			userId: USER,
			requestId: original.requestId,
			kind: "transform",
			documentId,
			sourceNodeId: "source",
			sourceHash: "a".repeat(64),
			expectedSourceMarkdown: "source",
			requestHash: "b".repeat(64),
			model: "model",
		});
		expect(retried).toMatchObject({
			replay: false,
			run: { status: "reserved" },
		});
		expect(retried.run).not.toHaveProperty("acknowledgedAt");
		expect(retried.run).not.toHaveProperty("applicable");
		expect(retried.run).not.toHaveProperty("output");
		expect(retried.run).not.toHaveProperty("errorCode");
		expect(retried.run).not.toHaveProperty("langsmithRunId");
		const owner = t.withIdentity({ subject: USER });
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toMatchObject({ _id: runId, status: "reserved" });
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: `concurrent-${status}`,
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: status.padEnd(64, "x"),
				model: "model",
			}),
		).rejects.toThrow("earlier AI request");
		await expect(
			t.mutation(internal.ai.runs.markProviderStarted, {
				runId,
				userId: USER,
				keySource: "house",
				expectedSourceMarkdown: "source",
			}),
		).resolves.toMatchObject({ started: true });
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toMatchObject({ _id: runId, status: "provider_started" });
	});

	it.each([
		"reserved",
		"provider_started",
		"outcome_unknown",
		"succeeded",
	] as const)("does not let a terminal same-id retry displace an active %s run", async (activeStatus) => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const { documentId, runId } = await seedRun(t);
		const { activeId, requestId, requestHash } = await t.run(async (ctx) => {
			await ctx.db.patch(runId, {
				status: "failed",
				keySource: undefined,
				completedAt: 2,
				acknowledgedAt: 3,
			});
			const requestId = `active-${activeStatus}`;
			const requestHash = activeStatus.padEnd(64, "x");
			const activeId = await ctx.db.insert("aiRuns", {
				userId: USER,
				requestId,
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				sourceMarkdown: "source",
				requestHash,
				model: "model",
				status: activeStatus,
				keySource: activeStatus === "reserved" ? undefined : ("house" as const),
				output: activeStatus === "succeeded" ? "active output" : undefined,
				applicable: activeStatus === "succeeded" ? true : undefined,
				providerStartedAt: activeStatus === "reserved" ? undefined : 1,
				consentAcceptedAt: activeStatus === "reserved" ? undefined : 1,
				createdAt: 1,
				updatedAt: 4,
			});
			await ctx.db.insert("aiActiveRuns", {
				userId: USER,
				documentId,
				kind: "transform",
				runId: activeId,
				sourceNodeId: "source",
				updatedAt: 4,
			});
			return { activeId, requestId, requestHash };
		});
		const original = await t.run(async (ctx) => await ctx.db.get(runId));
		if (!original) throw new Error("missing seeded run");
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: original.requestId,
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: original.requestHash,
				model: "model",
			}),
		).rejects.toThrow("earlier AI request");
		await expect(
			t.run(async (ctx) => ({
				active: await ctx.db.query("aiActiveRuns").unique(),
				original: await ctx.db.get(runId),
				competitor: await ctx.db.get(activeId),
			})),
		).resolves.toMatchObject({
			active: { runId: activeId },
			original: { status: "failed", acknowledgedAt: 3 },
			competitor: { requestId, requestHash, status: activeStatus },
		});
	});

	it("cleans an invalid active row before retrying a terminal request", async () => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const { documentId, runId } = await seedRun(t);
		const original = await t.run(async (ctx) => {
			await ctx.db.patch(runId, {
				status: "failed",
				keySource: undefined,
				completedAt: 2,
			});
			const staleId = await ctx.db.insert("aiRuns", {
				userId: USER,
				requestId: "stale-active",
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				sourceMarkdown: "source",
				requestHash: "s".repeat(64),
				model: "model",
				status: "failed",
				createdAt: 1,
				updatedAt: 2,
			});
			await ctx.db.insert("aiActiveRuns", {
				userId: USER,
				documentId,
				kind: "transform",
				runId: staleId,
				sourceNodeId: "source",
				updatedAt: 2,
			});
			return await ctx.db.get(runId);
		});
		if (!original) throw new Error("missing seeded run");
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: original.requestId,
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: original.requestHash,
				model: "model",
			}),
		).resolves.toMatchObject({ replay: false, run: { status: "reserved" } });
		await expect(
			t.run(async (ctx) => await ctx.db.query("aiActiveRuns").unique()),
		).resolves.toMatchObject({ runId });
	});

	it("uses one active row despite a large acknowledged history", async () => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const { documentId, runId } = await seedRun(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("aiActiveRuns", {
				userId: USER,
				documentId,
				kind: "transform",
				runId,
				sourceNodeId: "source",
				updatedAt: 1,
			});
			for (let index = 0; index < 1_000; index += 1) {
				await ctx.db.insert("aiRuns", {
					userId: USER,
					requestId: `history-${index}`,
					kind: "transform",
					documentId,
					sourceNodeId: "source",
					sourceHash: "a".repeat(64),
					sourceMarkdown: "source",
					requestHash: `${index}`.padEnd(64, "h"),
					model: "model",
					status: "succeeded",
					output: "old",
					applicable: true,
					acknowledgedAt: index + 2,
					createdAt: index + 2,
					updatedAt: index + 2,
				});
			}
		});
		const owner = t.withIdentity({ subject: USER });
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toMatchObject({ _id: runId });
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: "blocked-by-active",
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: "b".repeat(64),
				model: "model",
			}),
		).rejects.toThrow("earlier AI request");
		await t.run(async (ctx) => {
			const active = await ctx.db.query("aiActiveRuns").unique();
			if (active) await ctx.db.delete(active._id);
			await ctx.db.patch(runId, {
				status: "failed",
				acknowledgedAt: 2_000,
			});
		});
		const begun = await t.mutation(internal.ai.runs.begin, {
			userId: USER,
			requestId: "after-large-history",
			kind: "transform",
			documentId,
			sourceNodeId: "source",
			sourceHash: "a".repeat(64),
			expectedSourceMarkdown: "source",
			requestHash: "c".repeat(64),
			model: "model",
		});
		expect(begun.replay).toBe(false);
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toMatchObject({ requestId: "after-large-history" });
	});

	it("never recovers outputs refused by access or source fences", async () => {
		for (const fence of ["consent", "share", "delete", "source"] as const) {
			const t = convexTest(schema, modules);
			const { documentId, runId } = await seedRun(t);
			await t.run(async (ctx) => {
				if (fence === "consent") {
					const consent = await ctx.db.query("aiConsents").unique();
					if (consent) await ctx.db.delete(consent._id);
				} else if (fence === "share") {
					await ctx.db.insert("documentShares", {
						documentId,
						ownerUserId: USER,
						granteeEmail: "reader@example.com",
						role: "commenter",
						createdAt: 2,
					});
				} else if (fence === "delete") {
					await ctx.db.insert("aiDocumentDeletions", {
						documentId,
						userId: USER,
						createdAt: 2,
						updatedAt: 2,
					});
				} else {
					await ctx.db.patch(documentId, { currentNodeId: "changed" });
				}
			});
			const result = await settleRun(t, runId);
			expect(result.applicable).toBe(false);
			expect(
				await t.run(async (ctx) => (await ctx.db.get(runId))?.applicable),
			).toBe(false);
			const owner = t.withIdentity({ subject: USER });
			await expect(
				owner.query(api.ai.runs.latestRecoverable, {
					documentId,
					kind: "transform",
				}),
			).resolves.toBeNull();
		}
	});

	it("does not revive a succeeded output after consent is revoked and reaccepted", async () => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const { documentId, runId } = await seedRun(t);
		await expect(settleRun(t, runId)).resolves.toMatchObject({
			applicable: true,
		});
		await t.run(async (ctx) => {
			const consent = await ctx.db.query("aiConsents").unique();
			if (consent) await ctx.db.delete(consent._id);
			await ctx.db.insert("aiConsents", {
				userId: USER,
				version: 1,
				acceptedAt: Date.now() + 1,
			});
		});
		const owner = t.withIdentity({ subject: USER });
		const recovered = await owner.query(api.ai.runs.get, {
			requestId:
				(await t.run(async (ctx) => await ctx.db.get(runId)))?.requestId ??
				"missing",
		});
		expect(recovered).toMatchObject({ applicable: false });
		expect(recovered && "output" in recovered).toBe(false);
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toBeNull();
		const original = await t.run(async (ctx) => await ctx.db.get(runId));
		if (!original) throw new Error("missing seeded run");
		const replay = await t.mutation(internal.ai.runs.begin, {
			userId: USER,
			requestId: original.requestId,
			kind: "transform",
			documentId,
			sourceNodeId: "source",
			sourceHash: "a".repeat(64),
			expectedSourceMarkdown: "source",
			requestHash: original.requestHash,
			model: "model",
		});
		expect(replay).toMatchObject({
			replay: true,
			run: { applicable: false },
		});
		expect(replay.run).not.toHaveProperty("output");
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: "after-reconsent",
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: "r".repeat(64),
				model: "model",
			}),
		).resolves.toMatchObject({ replay: false });
	});

	it("refuses an in-flight result after consent is revoked and reaccepted", async () => {
		const t = convexTest(schema, modules);
		const { documentId, runId } = await seedRun(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(runId, {
				providerStartedAt: 2,
				consentAcceptedAt: 1,
			});
			const consent = await ctx.db.query("aiConsents").unique();
			if (consent) await ctx.db.delete(consent._id);
			await ctx.db.insert("aiConsents", {
				userId: USER,
				version: 1,
				acceptedAt: 10,
			});
		});
		await expect(settleRun(t, runId)).resolves.toMatchObject({
			applicable: false,
		});
		const owner = t.withIdentity({ subject: USER });
		await expect(
			owner.query(api.ai.runs.get, {
				requestId:
					(await t.run(async (ctx) => await ctx.db.get(runId)))?.requestId ??
					"missing",
			}),
		).resolves.toMatchObject({ applicable: false });
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toBeNull();
	});

	it("binds a retried provider attempt to the reaccepted consent epoch", async () => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const { documentId, runId } = await seedRun(t);
		const original = await t.run(async (ctx) => {
			await ctx.db.patch(runId, {
				status: "failed",
				keySource: undefined,
				completedAt: 2,
				acknowledgedAt: 3,
			});
			const consent = await ctx.db.query("aiConsents").unique();
			if (consent) await ctx.db.delete(consent._id);
			await ctx.db.insert("aiConsents", {
				userId: USER,
				version: 1,
				acceptedAt: 10,
			});
			return await ctx.db.get(runId);
		});
		if (!original) throw new Error("missing seeded run");
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: original.requestId,
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: original.requestHash,
				model: "model",
			}),
		).resolves.toMatchObject({ replay: false, run: { status: "reserved" } });
		await expect(
			t.mutation(internal.ai.runs.markProviderStarted, {
				runId,
				userId: USER,
				keySource: "house",
				expectedSourceMarkdown: "source",
			}),
		).resolves.toMatchObject({ started: true });
		await expect(settleRun(t, runId)).resolves.toMatchObject({
			applicable: true,
		});
		const owner = t.withIdentity({ subject: USER });
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toMatchObject({
			_id: runId,
			status: "succeeded",
			consentAcceptedAt: 10,
		});
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: "duplicate-after-retry",
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: "d".repeat(64),
				model: "model",
			}),
		).rejects.toThrow("earlier AI request");
	});

	it("keeps maximum embedding rows below the Convex document limit", async () => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const source = "x".repeat(950_000);
		const { documentId } = await t.run(async (ctx) => {
			const documentId = await ctx.db.insert("documents", {
				userId: USER,
				title: "Large draft",
				markdown: source,
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
				snapshot: source,
				selection: null,
				origin: "edit",
				createdAt: 1,
			});
			await ctx.db.insert("aiConsents", {
				userId: USER,
				version: 1,
				acceptedAt: 1,
			});
			return { documentId };
		});
		const request = {
			userId: USER,
			requestId: "maximum-embedding",
			kind: "embed" as const,
			documentId,
			sourceNodeId: "source",
			sourceHash: "a".repeat(64),
			expectedSourceMarkdown: source,
			requestHash: "b".repeat(64),
			model: "model",
		};
		const begun = await t.mutation(internal.ai.runs.begin, request);
		expect(begun.run).not.toHaveProperty("sourceMarkdown");
		await t.mutation(internal.ai.runs.markProviderStarted, {
			runId: begun.run._id,
			userId: USER,
			keySource: "house",
			expectedSourceMarkdown: source,
		});
		const output = JSON.stringify(
			Array.from({ length: 16 }, () => Array(1_536).fill(0.123456789)),
		);
		await expect(
			t.mutation(internal.ai.runs.succeed, {
				runId: begun.run._id,
				userId: USER,
				output,
				expectedSourceMarkdown: source,
				usage: {
					promptTokens: 1,
					completionTokens: 1,
					reasoningTokens: 0,
					costMicros: 1,
					latencyMs: 1,
				},
			}),
		).resolves.toMatchObject({ applicable: true });
		const stored = await t.run(async (ctx) => await ctx.db.get(begun.run._id));
		if (!stored) throw new Error("missing embedding run");
		expect(stored.sourceMarkdown).toBeUndefined();
		expect(getDocumentSize(stored)).toBeLessThan(1_048_576);
		for (const [kind, durableOutput] of [
			["transform", "😀".repeat(4_096)],
			[
				"review",
				JSON.stringify({
					commentsPlaced: 100,
					commentsTotal: 100,
					commentsDropped: 0,
					editsPlaced: 100,
					editsTotal: 100,
					editsDropped: 0,
					branchId: "b".repeat(32),
				}),
			],
		] as const) {
			const durable = await t.mutation(internal.ai.runs.begin, {
				...request,
				requestId: `maximum-${kind}`,
				kind,
				requestHash: kind.padEnd(64, "x"),
			});
			await t.mutation(internal.ai.runs.markProviderStarted, {
				runId: durable.run._id,
				userId: USER,
				keySource: "house",
				expectedSourceMarkdown: source,
			});
			await t.mutation(internal.ai.runs.succeed, {
				runId: durable.run._id,
				userId: USER,
				output: durableOutput,
				expectedSourceMarkdown: source,
				usage: {
					promptTokens: 1,
					completionTokens: 1,
					reasoningTokens: 0,
					costMicros: 1,
					latencyMs: 1,
				},
			});
			const durableStored = await t.run(
				async (ctx) => await ctx.db.get(durable.run._id),
			);
			if (!durableStored) throw new Error(`missing ${kind} run`);
			expect(durableStored.sourceMarkdown).toBe(source);
			expect(getDocumentSize(durableStored)).toBeLessThan(1_048_576);
		}
		await expect(
			t.mutation(internal.ai.runs.begin, request),
		).resolves.toMatchObject({ replay: true, run: { output } });
		await t.run(async (ctx) => {
			await ctx.db.patch(documentId, { markdown: `${source}y` });
		});
		await expect(t.mutation(internal.ai.runs.begin, request)).rejects.toThrow(
			"draft changed",
		);
	});

	it("serializes random ids across tabs and keeps failed acknowledgement locked", async () => {
		const t = convexTest(schema, modules);
		registerRateLimiter(t);
		const { documentId, runId } = await seedRun(t, "reserved");
		const run = await t.run(async (ctx) => await ctx.db.get(runId));
		if (!run) throw new Error("missing seeded run");
		const owner = t.withIdentity({ subject: USER });
		await expect(
			owner.mutation(api.ai.runs.acknowledge, { requestId: run.requestId }),
		).resolves.toEqual({ acknowledged: false });
		const begin = (requestId: string) =>
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId,
				kind: "transform" as const,
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: requestId.padEnd(64, "x"),
				model: "model",
			});
		await expect(begin("other-tab-before-cancel")).rejects.toThrow(
			"earlier AI request",
		);

		await owner.mutation(api.ai.runs.cancel, { requestId: run.requestId });
		const outcomes = await Promise.allSettled([
			begin("tab-one"),
			begin("tab-two"),
		]);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
	});

	it("recovers reloadable runs and rejects stale-source recovery", async () => {
		const t = convexTest(schema, modules);
		const { documentId, runId } = await seedRun(t, "reserved");
		const owner = t.withIdentity({ subject: USER });
		for (const status of [
			"reserved",
			"provider_started",
			"outcome_unknown",
			"succeeded",
		] as const) {
			await t.run(async (ctx) => {
				await ctx.db.patch(runId, {
					status,
					output: status === "succeeded" ? "result" : undefined,
					applicable: status === "succeeded" ? true : undefined,
					updatedAt: Date.now(),
				});
			});
			await expect(
				owner.query(api.ai.runs.latestRecoverable, {
					documentId,
					kind: "transform",
				}),
			).resolves.toMatchObject({ status });
		}

		await t.run(async (ctx) => {
			await ctx.db.patch(documentId, { currentNodeId: "changed" });
		});
		await expect(
			owner.query(api.ai.runs.latestRecoverable, {
				documentId,
				kind: "transform",
			}),
		).resolves.toBeNull();
	});

	it("hides blocked shares before bounded cleanup finishes", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seedRun(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("userBlocks", {
				blockerUserId: USER,
				blockedUserId: "reviewer",
				createdAt: 1,
			});
			for (let index = 0; index < 130; index += 1) {
				await ctx.db.insert("documentShares", {
					documentId,
					ownerUserId: USER,
					granteeEmail: "reviewer@example.com",
					granteeUserId: "reviewer",
					role: "commenter",
					createdAt: index + 1,
				});
			}
		});
		const reviewer = t.withIdentity({
			subject: "reviewer",
			email: "reviewer@example.com",
		});
		await expect(
			reviewer.query(api.review.listSharedWithMe, {}),
		).resolves.toEqual([]);
		await expect(
			reviewer.query(api.review.documentShareState, { documentId }),
		).resolves.toBeNull();
		const first = await t.mutation(internal.review.cleanupBlockedShares, {
			blockerUserId: USER,
			blockedUserId: "reviewer",
		});
		expect(first).toEqual({ revoked: 128, complete: false });
	});

	it("refuses same-head draft drift at reservation and provider start", async () => {
		const t = convexTest(schema, modules);
		const { documentId, runId } = await seedRun(t, "reserved");
		await t.run(async (ctx) => {
			await ctx.db.patch(documentId, { markdown: "changed draft" });
		});
		await expect(
			t.mutation(internal.ai.runs.begin, {
				userId: USER,
				requestId: crypto.randomUUID(),
				kind: "transform",
				documentId,
				sourceNodeId: "source",
				sourceHash: "a".repeat(64),
				expectedSourceMarkdown: "source",
				requestHash: "c".repeat(64),
				model: "model",
			}),
		).rejects.toThrow("draft changed");
		await expect(
			t.mutation(internal.ai.runs.markProviderStarted, {
				runId,
				userId: USER,
				keySource: "house",
				expectedSourceMarkdown: "source",
			}),
		).rejects.toThrow("draft changed");
		const run = await t.run(async (ctx) => await ctx.db.get(runId));
		expect(run?.status).toBe("reserved");
	});

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

	it("rejects an AI review branch above the UTF-8 byte ceiling", async () => {
		const t = convexTest(schema, modules);
		const { documentId } = await seedRun(t);
		await expect(
			t.mutation(internal.review.applyAiReview, {
				userId: USER,
				documentId,
				sourceNodeId: "source",
				sourceText: "source",
				comments: [],
				branchMarkdown: "😀".repeat(240_000),
			}),
		).rejects.toThrow("~1 MiB size limit");
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

	it("makes a partially billed multi-call run non-retryable", async () => {
		const t = convexTest(schema, modules);
		const { runId } = await seedRun(t);
		for (const callIndex of [0, 1]) {
			await t.mutation(internal.ai.runs.recordUsage, {
				runId,
				userId: USER,
				callIndex,
				usage: {
					promptTokens: 10 + callIndex,
					completionTokens: 2,
					reasoningTokens: 0,
					costMicros: 20 + callIndex,
					latencyMs: 5,
				},
			});
		}
		await t.mutation(internal.ai.runs.finishError, {
			runId,
			userId: USER,
			errorCode: "ai_provider_rejected",
			outcomeUnknown: false,
		});
		const snapshot = await t.run(async (ctx) => ({
			run: await ctx.db.get(runId),
			usage: await ctx.db
				.query("aiUsage")
				.withIndex("by_run", (q) => q.eq("runId", runId))
				.collect(),
		}));
		expect(snapshot.run?.status).toBe("outcome_unknown");
		expect(snapshot.usage.map((row) => row.callIndex)).toEqual([0, 1]);
		expect(snapshot.usage.map((row) => row.costMicros)).toEqual([20, 21]);
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

	it("settles charged work but refuses application after account deletion starts", async () => {
		const t = convexTest(schema, modules);
		const { runId } = await seedRun(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("accountDeletions", {
				userId: USER,
				startedAt: 2,
				updatedAt: 2,
				phase: "rows",
			});
		});
		const result = await settleRun(t, runId);
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

	it("settles charged work but refuses application after consent revocation", async () => {
		const t = convexTest(schema, modules);
		const { runId } = await seedRun(t);
		await t.run(async (ctx) => {
			const consent = await ctx.db
				.query("aiConsents")
				.withIndex("by_user", (q) => q.eq("userId", USER))
				.unique();
			if (consent) await ctx.db.delete(consent._id);
		});
		const result = await settleRun(t, runId);
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
		expect(first).toEqual({ done: false, deleted: 1 });
		let result = first;
		for (let attempt = 0; attempt < 10 && !result.done; attempt += 1) {
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
