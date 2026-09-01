import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "../_generated/server";
import { findTombstone } from "../accountGuard";
import { requireOwnedDocument, requireUserId } from "../documents";
import { AI_CONSENT_VERSION } from "./consent";
import { aiError } from "./errors";
import { aiRateLimiter } from "./limits";

type MutationCtx = GenericMutationCtx<DataModel>;
type QueryCtx = GenericQueryCtx<DataModel>;

const kindValidator = v.union(
	v.literal("transform"),
	v.literal("review"),
	v.literal("embed"),
);
const keySourceValidator = v.union(v.literal("byok"), v.literal("house"));
const CLEANUP_BATCH = 128;

async function hasCurrentConsent(
	ctx: QueryCtx | MutationCtx,
	userId: string,
): Promise<boolean> {
	const consent = await ctx.db
		.query("aiConsents")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	return consent?.version === AI_CONSENT_VERSION;
}

async function assertRunBoundary(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: string;
		documentId: Id<"documents">;
		sourceNodeId: string;
		expectedSourceMarkdown?: string;
	},
): Promise<Doc<"documents">> {
	if (await findTombstone(ctx, args.userId)) {
		aiError("account_deletion_in_progress", "Account deletion is in progress.");
	}
	const deletion = await ctx.db
		.query("aiDocumentDeletions")
		.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
		.unique();
	if (deletion) aiError("document_not_found", "Document not found");
	const document = await ctx.db.get(args.documentId);
	if (!document || document.userId !== args.userId) {
		aiError("document_not_found", "Document not found");
	}
	const share = await ctx.db
		.query("documentShares")
		.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
		.first();
	if (share) {
		aiError("document_shared", "AI is disabled on shared documents");
	}
	if (!(await hasCurrentConsent(ctx, args.userId))) {
		aiError(
			"ai_consent_required",
			"Accept the current AI consent notice first.",
		);
	}
	if (document.currentNodeId !== args.sourceNodeId) {
		aiError(
			"document_changed",
			"The document changed before the AI request started.",
		);
	}
	if (
		args.expectedSourceMarkdown !== undefined &&
		document.markdown !== args.expectedSourceMarkdown
	) {
		aiError(
			"document_changed",
			"The draft changed before the AI request started.",
		);
	}
	const sourceNode = await ctx.db
		.query("docNodes")
		.withIndex("by_document_node", (q) =>
			q.eq("documentId", args.documentId).eq("nodeId", args.sourceNodeId),
		)
		.unique();
	if (!sourceNode)
		aiError("document_changed", "The source history node no longer exists.");
	return document;
}

export const begin = internalMutation({
	args: {
		userId: v.string(),
		requestId: v.string(),
		kind: kindValidator,
		documentId: v.id("documents"),
		sourceNodeId: v.string(),
		sourceHash: v.string(),
		expectedSourceMarkdown: v.string(),
		requestHash: v.string(),
		model: v.string(),
	},
	handler: async (ctx, args) => {
		await assertRunBoundary(ctx, args);
		const existing = await ctx.db
			.query("aiRuns")
			.withIndex("by_user_request", (q) =>
				q.eq("userId", args.userId).eq("requestId", args.requestId),
			)
			.unique();
		if (existing) {
			if (
				existing.requestHash !== args.requestHash ||
				existing.documentId !== args.documentId ||
				existing.kind !== args.kind
			) {
				aiError(
					"request_conflict",
					"This request id was already used for different input.",
				);
			}
			const existingUsage = await ctx.db
				.query("aiUsage")
				.withIndex("by_run", (q) => q.eq("runId", existing._id))
				.unique();
			if (
				existingUsage ||
				(existing.status !== "failed" && existing.status !== "cancelled")
			) {
				return { replay: true as const, run: existing };
			}
			const retryLimit = await aiRateLimiter.limit(ctx, "aiRequests", {
				key: args.userId,
			});
			if (!retryLimit.ok) {
				throw new ConvexError({
					code: "ai_rate_limited",
					message: "Too many AI requests. Try again shortly.",
					retryAfter: retryLimit.retryAfter,
				});
			}
			const now = Date.now();
			await ctx.db.patch(existing._id, {
				status: "reserved",
				keySource: undefined,
				output: undefined,
				errorCode: undefined,
				providerStartedAt: undefined,
				completedAt: undefined,
				updatedAt: now,
			});
			return {
				replay: false as const,
				run: { ...existing, status: "reserved" as const, updatedAt: now },
			};
		}

		const limited = await aiRateLimiter.limit(ctx, "aiRequests", {
			key: args.userId,
		});
		if (!limited.ok) {
			throw new ConvexError({
				code: "ai_rate_limited",
				message: "Too many AI requests. Try again shortly.",
				retryAfter: limited.retryAfter,
			});
		}
		const now = Date.now();
		const { expectedSourceMarkdown: _, ...runInput } = args;
		const runId = await ctx.db.insert("aiRuns", {
			...runInput,
			status: "reserved",
			createdAt: now,
			updatedAt: now,
		});
		const run = await ctx.db.get(runId);
		if (!run) throw new Error("AI run reservation disappeared");
		return { replay: false as const, run };
	},
});

export const markProviderStarted = internalMutation({
	args: {
		runId: v.id("aiRuns"),
		userId: v.string(),
		keySource: keySourceValidator,
		expectedSourceMarkdown: v.string(),
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (!run || run.userId !== args.userId) return { started: false as const };
		if (run.status !== "reserved")
			return { started: false as const, status: run.status };
		await assertRunBoundary(ctx, {
			userId: run.userId,
			documentId: run.documentId,
			sourceNodeId: run.sourceNodeId,
			expectedSourceMarkdown: args.expectedSourceMarkdown,
		});
		const now = Date.now();
		await ctx.db.patch(run._id, {
			status: "provider_started",
			keySource: args.keySource,
			providerStartedAt: now,
			updatedAt: now,
		});
		return { started: true as const };
	},
});

const usageValidator = v.object({
	promptTokens: v.number(),
	completionTokens: v.number(),
	reasoningTokens: v.number(),
	costMicros: v.number(),
	latencyMs: v.number(),
	langsmithRunId: v.optional(v.string()),
});

export const recordUsage = internalMutation({
	args: {
		runId: v.id("aiRuns"),
		userId: v.string(),
		usage: usageValidator,
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (
			!run ||
			run.userId !== args.userId ||
			run.status !== "provider_started" ||
			!run.keySource
		)
			return { recorded: false as const };
		const existing = await ctx.db
			.query("aiUsage")
			.withIndex("by_run", (q) => q.eq("runId", run._id))
			.unique();
		if (!existing) {
			await ctx.db.insert("aiUsage", {
				userId: run.userId,
				runId: run._id,
				kind: run.kind,
				model: run.model,
				...args.usage,
				keySource: run.keySource,
				documentId: run.documentId,
				createdAt: Date.now(),
			});
		}
		return { recorded: true as const };
	},
});

export const succeed = internalMutation({
	args: {
		runId: v.id("aiRuns"),
		userId: v.string(),
		output: v.string(),
		expectedSourceMarkdown: v.string(),
		usage: usageValidator,
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (!run || run.userId !== args.userId)
			return { committed: false as const };
		if (run.status === "succeeded")
			return { committed: true as const, replay: true as const };
		if (run.status !== "provider_started" || !run.keySource) {
			return { committed: false as const };
		}
		const existingUsage = await ctx.db
			.query("aiUsage")
			.withIndex("by_run", (q) => q.eq("runId", run._id))
			.unique();
		const now = Date.now();
		if (!existingUsage) {
			await ctx.db.insert("aiUsage", {
				userId: run.userId,
				runId: run._id,
				kind: run.kind,
				model: run.model,
				...args.usage,
				keySource: run.keySource,
				documentId: run.documentId,
				createdAt: now,
			});
		}
		await ctx.db.patch(run._id, {
			status: "succeeded",
			output: args.output,
			langsmithRunId: args.usage.langsmithRunId,
			completedAt: now,
			updatedAt: now,
		});
		const deletion = await ctx.db
			.query("aiDocumentDeletions")
			.withIndex("by_document", (q) => q.eq("documentId", run.documentId))
			.unique();
		const document = await ctx.db.get(run.documentId);
		const share = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", run.documentId))
			.first();
		const sourceNode = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", run.documentId).eq("nodeId", run.sourceNodeId),
			)
			.unique();
		const applicable =
			!deletion &&
			!share &&
			document?.userId === run.userId &&
			document.currentNodeId === run.sourceNodeId &&
			document.markdown === args.expectedSourceMarkdown &&
			sourceNode !== null;
		return {
			committed: true as const,
			replay: false as const,
			applicable,
		};
	},
});

export const finishError = internalMutation({
	args: {
		runId: v.id("aiRuns"),
		userId: v.string(),
		errorCode: v.string(),
		outcomeUnknown: v.boolean(),
	},
	handler: async (ctx, args) => {
		const run = await ctx.db.get(args.runId);
		if (!run || run.userId !== args.userId) return;
		if (run.status === "succeeded" || run.status === "outcome_unknown") return;
		// Once the provider may have accepted work, aborts, timeouts and network
		// failures cannot be converted into a retry-safe terminal state.
		const status =
			run.status === "provider_started" && args.outcomeUnknown
				? "outcome_unknown"
				: "failed";
		const now = Date.now();
		await ctx.db.patch(run._id, {
			status,
			errorCode: args.errorCode,
			completedAt: now,
			updatedAt: now,
		});
	},
});

export const getInternal = internalQuery({
	args: { runId: v.id("aiRuns") },
	handler: async (ctx, args) => await ctx.db.get(args.runId),
});

export const sourceForRequest = internalQuery({
	args: {
		userId: v.string(),
		documentId: v.id("documents"),
		sourceNodeId: v.string(),
	},
	handler: async (ctx, args) => (await assertRunBoundary(ctx, args)).markdown,
});

export const normalizeDocumentId = internalQuery({
	args: { value: v.string() },
	handler: async (ctx, args) => ctx.db.normalizeId("documents", args.value),
});

export const normalizeReviewBranchId = internalQuery({
	args: { value: v.string() },
	handler: async (ctx, args) =>
		ctx.db.normalizeId("reviewBranches", args.value),
});

export const get = query({
	args: { requestId: v.string() },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const run = await ctx.db
			.query("aiRuns")
			.withIndex("by_user_request", (q) =>
				q.eq("userId", userId).eq("requestId", args.requestId),
			)
			.unique();
		if (!run) return null;
		await requireOwnedDocument(ctx, run.documentId);
		const share = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", run.documentId))
			.first();
		if (share) aiError("document_shared", "AI is disabled on shared documents");
		return run;
	},
});

export const cancel = mutation({
	args: { requestId: v.string() },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const run = await ctx.db
			.query("aiRuns")
			.withIndex("by_user_request", (q) =>
				q.eq("userId", userId).eq("requestId", args.requestId),
			)
			.unique();
		if (!run)
			return { cancelled: false as const, reason: "not_found" as const };
		await requireOwnedDocument(ctx, run.documentId);
		if (run.status === "provider_started" || run.status === "outcome_unknown") {
			return { cancelled: false as const, reason: "outcome_unknown" as const };
		}
		if (run.status !== "reserved") {
			return { cancelled: false as const, reason: "terminal" as const };
		}
		const now = Date.now();
		await ctx.db.patch(run._id, {
			status: "cancelled",
			completedAt: now,
			updatedAt: now,
		});
		return { cancelled: true as const };
	},
});

export const usageSummary = query({
	args: { since: v.number() },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		if (!Number.isFinite(args.since) || args.since < 0) {
			aiError("invalid_argument", "Invalid usage range.");
		}
		const rows = await ctx.db
			.query("aiUsage")
			.withIndex("by_user_created", (q) =>
				q.eq("userId", userId).gte("createdAt", args.since),
			)
			.take(2_000);
		const byKind = {
			transform: { requests: 0, costMicros: 0 },
			review: { requests: 0, costMicros: 0 },
			embed: { requests: 0, costMicros: 0 },
		};
		let costMicros = 0;
		for (const row of rows) {
			byKind[row.kind].requests += 1;
			byKind[row.kind].costMicros += row.costMicros;
			costMicros += row.costMicros;
		}
		return {
			requests: rows.length,
			costMicros,
			byKind,
			truncated: rows.length === 2_000,
		};
	},
});

export const startDocumentCleanup = internalMutation({
	args: { documentId: v.id("documents"), userId: v.string() },
	handler: async (ctx, args) => await markDocumentForAiCleanup(ctx, args),
});

export async function markDocumentForAiCleanup(
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
	await ctx.scheduler.runAfter(0, internal.ai.runs.cleanupDeletedDocument, {
		documentId: args.documentId,
	});
}

export const cleanupDeletedDocument = internalMutation({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args): Promise<{ done: boolean; deleted: number }> => {
		const job = await ctx.db
			.query("aiDocumentDeletions")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.unique();
		if (!job) return { done: true, deleted: 0 };
		const usage = await ctx.db
			.query("aiUsage")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.take(CLEANUP_BATCH);
		for (const row of usage) await ctx.db.delete(row._id);
		let deleted = usage.length;
		if (deleted < CLEANUP_BATCH) {
			const runs = await ctx.db
				.query("aiRuns")
				.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
				.take(CLEANUP_BATCH - deleted);
			for (const row of runs) await ctx.db.delete(row._id);
			deleted += runs.length;
		}
		if (deleted === 0) {
			await ctx.db.delete(job._id);
			return { done: true, deleted: 0 };
		}
		await ctx.db.patch(job._id, { updatedAt: Date.now() });
		await ctx.scheduler.runAfter(
			0,
			internal.ai.runs.cleanupDeletedDocument,
			args,
		);
		return { done: false, deleted };
	},
});
