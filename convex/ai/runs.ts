import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "../_generated/server";
import { findTombstone } from "../accountGuard";
import {
	cleanupDocumentBatch,
	startDocumentCleanup as enqueueDocumentCleanup,
} from "../documentCleanup";
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
type DurableRunKind = "transform" | "review";

function isDurableRunKind(
	kind: "transform" | "review" | "embed",
): kind is DurableRunKind {
	return kind !== "embed";
}

function isRecoverableRun(run: Doc<"aiRuns">): boolean {
	return (
		run.acknowledgedAt === undefined &&
		(run.status === "reserved" ||
			run.status === "provider_started" ||
			run.status === "outcome_unknown" ||
			(run.status === "succeeded" && run.applicable === true))
	);
}

async function activeRunRow(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: string;
		documentId: Id<"documents">;
		kind: DurableRunKind;
		sourceNodeId: string;
	},
) {
	return await ctx.db
		.query("aiActiveRuns")
		.withIndex("by_user_document_kind_source", (q) =>
			q
				.eq("userId", args.userId)
				.eq("documentId", args.documentId)
				.eq("kind", args.kind)
				.eq("sourceNodeId", args.sourceNodeId),
		)
		.unique();
}

async function clearActiveRun(
	ctx: MutationCtx,
	run: Pick<
		Doc<"aiRuns">,
		"_id" | "userId" | "documentId" | "kind" | "sourceNodeId"
	>,
): Promise<void> {
	const { kind } = run;
	if (!isDurableRunKind(kind)) return;
	const active = await activeRunRow(ctx, { ...run, kind });
	if (active?.runId === run._id) await ctx.db.delete(active._id);
}

async function reserveActiveRun(
	ctx: MutationCtx,
	run: Pick<
		Doc<"aiRuns">,
		"_id" | "userId" | "documentId" | "kind" | "sourceNodeId"
	>,
): Promise<void> {
	const { kind } = run;
	if (!isDurableRunKind(kind)) return;
	const active = await activeRunRow(ctx, { ...run, kind });
	if (active) await ctx.db.delete(active._id);
	await ctx.db.insert("aiActiveRuns", {
		userId: run.userId,
		documentId: run.documentId,
		kind,
		runId: run._id,
		sourceNodeId: run.sourceNodeId,
		updatedAt: Date.now(),
	});
}

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

async function runApplicableNow(
	ctx: QueryCtx | MutationCtx,
	run: Doc<"aiRuns">,
): Promise<boolean> {
	if (run.applicable !== true || run.sourceMarkdown === undefined) return false;
	const [deletion, tombstone, consent, document, share, sourceNode] =
		await Promise.all([
			ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", run.documentId))
				.unique(),
			findTombstone(ctx, run.userId),
			ctx.db
				.query("aiConsents")
				.withIndex("by_user", (q) => q.eq("userId", run.userId))
				.unique(),
			ctx.db.get(run.documentId),
			ctx.db
				.query("documentShares")
				.withIndex("by_document", (q) => q.eq("documentId", run.documentId))
				.first(),
			ctx.db
				.query("docNodes")
				.withIndex("by_document_node", (q) =>
					q.eq("documentId", run.documentId).eq("nodeId", run.sourceNodeId),
				)
				.unique(),
		]);
	return (
		!deletion &&
		!tombstone &&
		consent?.version === AI_CONSENT_VERSION &&
		consent.acceptedAt <= run.createdAt &&
		!share &&
		document?.userId === run.userId &&
		document.currentNodeId === run.sourceNodeId &&
		document.markdown === run.sourceMarkdown &&
		sourceNode !== null
	);
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
				.first();
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
				acknowledgedAt: undefined,
				applicable: undefined,
				langsmithRunId: undefined,
				sourceMarkdown: args.expectedSourceMarkdown,
				updatedAt: now,
			});
			const retried = await ctx.db.get(existing._id);
			if (!retried) throw new Error("AI run retry disappeared");
			await reserveActiveRun(ctx, retried);
			return {
				replay: false as const,
				run: retried,
			};
		}
		if (isDurableRunKind(args.kind)) {
			const kind = args.kind;
			const active = await activeRunRow(ctx, { ...args, kind });
			const activeRun = active ? await ctx.db.get(active.runId) : null;
			const validActiveRun =
				activeRun &&
				isRecoverableRun(activeRun) &&
				(activeRun.status !== "succeeded" ||
					(await runApplicableNow(ctx, activeRun)))
					? activeRun
					: null;
			if (active && !validActiveRun) {
				await ctx.db.delete(active._id);
			}
			const recent = validActiveRun
				? []
				: await ctx.db
						.query("aiRuns")
						.withIndex("by_user_document_kind_source_updated", (q) =>
							q
								.eq("userId", args.userId)
								.eq("documentId", args.documentId)
								.eq("kind", kind)
								.eq("sourceNodeId", args.sourceNodeId),
						)
						.order("desc")
						.take(32);
			let recoverable = validActiveRun;
			for (const run of recent) {
				if (
					isRecoverableRun(run) &&
					(run.status !== "succeeded" || (await runApplicableNow(ctx, run)))
				) {
					recoverable = run;
					break;
				}
			}
			if (recoverable) {
				aiError(
					"request_in_progress",
					"Resolve the earlier AI request before starting another.",
				);
			}
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
		const { expectedSourceMarkdown, ...runInput } = args;
		const runId = await ctx.db.insert("aiRuns", {
			...runInput,
			sourceMarkdown: expectedSourceMarkdown,
			status: "reserved",
			createdAt: now,
			updatedAt: now,
		});
		const run = await ctx.db.get(runId);
		if (!run) throw new Error("AI run reservation disappeared");
		await reserveActiveRun(ctx, run);
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
		callIndex: v.number(),
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
		if (!Number.isInteger(args.callIndex) || args.callIndex < 0) {
			return { recorded: false as const };
		}
		const existing = (
			await ctx.db
				.query("aiUsage")
				.withIndex("by_run", (q) => q.eq("runId", run._id))
				.take(16)
		).find((row) => (row.callIndex ?? 0) === args.callIndex);
		if (!existing) {
			await ctx.db.insert("aiUsage", {
				userId: run.userId,
				runId: run._id,
				callIndex: args.callIndex,
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
			return {
				committed: true as const,
				replay: true as const,
				applicable: run.applicable === true,
			};
		if (run.status !== "provider_started" || !run.keySource) {
			return { committed: false as const };
		}
		const existingUsage = await ctx.db
			.query("aiUsage")
			.withIndex("by_run", (q) => q.eq("runId", run._id))
			.first();
		const now = Date.now();
		if (!existingUsage) {
			await ctx.db.insert("aiUsage", {
				userId: run.userId,
				runId: run._id,
				callIndex: 0,
				kind: run.kind,
				model: run.model,
				...args.usage,
				keySource: run.keySource,
				documentId: run.documentId,
				createdAt: now,
			});
		}
		const [deletion, tombstone, consentCurrent, document, share, sourceNode] =
			await Promise.all([
				ctx.db
					.query("aiDocumentDeletions")
					.withIndex("by_document", (q) => q.eq("documentId", run.documentId))
					.unique(),
				findTombstone(ctx, run.userId),
				hasCurrentConsent(ctx, run.userId),
				ctx.db.get(run.documentId),
				ctx.db
					.query("documentShares")
					.withIndex("by_document", (q) => q.eq("documentId", run.documentId))
					.first(),
				ctx.db
					.query("docNodes")
					.withIndex("by_document_node", (q) =>
						q.eq("documentId", run.documentId).eq("nodeId", run.sourceNodeId),
					)
					.unique(),
			]);
		const applicable =
			!deletion &&
			!tombstone &&
			consentCurrent &&
			!share &&
			document?.userId === run.userId &&
			document.currentNodeId === run.sourceNodeId &&
			document.markdown === args.expectedSourceMarkdown &&
			sourceNode !== null;
		await ctx.db.patch(run._id, {
			status: "succeeded",
			output: args.output,
			applicable,
			langsmithRunId: args.usage.langsmithRunId,
			completedAt: now,
			updatedAt: now,
		});
		if (!applicable) await clearActiveRun(ctx, run);
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
		const recordedUsage = await ctx.db
			.query("aiUsage")
			.withIndex("by_run", (q) => q.eq("runId", run._id))
			.first();
		// Once the provider may have accepted work, aborts, timeouts and network
		// failures cannot be converted into a retry-safe terminal state.
		const status =
			run.status === "provider_started" &&
			(args.outcomeUnknown || recordedUsage !== null)
				? "outcome_unknown"
				: "failed";
		const now = Date.now();
		await ctx.db.patch(run._id, {
			status,
			errorCode: args.errorCode,
			completedAt: now,
			updatedAt: now,
		});
		if (status === "failed") await clearActiveRun(ctx, run);
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
		if (run.status === "succeeded" && !(await runApplicableNow(ctx, run))) {
			return { ...run, output: undefined, applicable: false as const };
		}
		return run;
	},
});

export const latestRecoverable = query({
	args: {
		documentId: v.id("documents"),
		kind: v.union(v.literal("transform"), v.literal("review")),
	},
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const document = await requireOwnedDocument(ctx, args.documentId);
		const active = await activeRunRow(ctx, {
			userId,
			...args,
			sourceNodeId: document.currentNodeId,
		});
		const activeRun = active ? await ctx.db.get(active.runId) : null;
		if (
			activeRun &&
			activeRun.sourceNodeId === document.currentNodeId &&
			isRecoverableRun(activeRun) &&
			(activeRun.status !== "succeeded" ||
				(await runApplicableNow(ctx, activeRun)))
		) {
			return activeRun;
		}
		const recent = await ctx.db
			.query("aiRuns")
			.withIndex("by_user_document_kind_source_updated", (q) =>
				q
					.eq("userId", userId)
					.eq("documentId", args.documentId)
					.eq("kind", args.kind)
					.eq("sourceNodeId", document.currentNodeId),
			)
			.order("desc")
			.take(32);
		for (const run of recent) {
			if (
				isRecoverableRun(run) &&
				(run.status !== "succeeded" || (await runApplicableNow(ctx, run)))
			) {
				return run;
			}
		}
		return null;
	},
});

export const acknowledge = mutation({
	args: { requestId: v.string() },
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const run = await ctx.db
			.query("aiRuns")
			.withIndex("by_user_request", (q) =>
				q.eq("userId", userId).eq("requestId", args.requestId),
			)
			.unique();
		if (!run) return { acknowledged: false as const };
		if (
			run.status === "reserved" ||
			run.status === "provider_started" ||
			run.status === "outcome_unknown"
		) {
			return { acknowledged: false as const };
		}
		await ctx.db.patch(run._id, { acknowledgedAt: Date.now() });
		await clearActiveRun(ctx, run);
		return { acknowledged: true as const };
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
		await clearActiveRun(ctx, run);
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
		const requestIds = new Set<string>();
		const requestIdsByKind = {
			transform: new Set<string>(),
			review: new Set<string>(),
			embed: new Set<string>(),
		};
		for (const row of rows) {
			requestIds.add(row.runId);
			requestIdsByKind[row.kind].add(row.runId);
			byKind[row.kind].costMicros += row.costMicros;
			costMicros += row.costMicros;
		}
		for (const kind of ["transform", "review", "embed"] as const) {
			byKind[kind].requests = requestIdsByKind[kind].size;
		}
		return {
			requests: requestIds.size,
			costMicros,
			byKind,
			truncated: rows.length === 2_000,
		};
	},
});

export const startDocumentCleanup = internalMutation({
	args: { documentId: v.id("documents"), userId: v.string() },
	handler: async (ctx, args) => await enqueueDocumentCleanup(ctx, args),
});

export const cleanupDeletedDocument = internalMutation({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) =>
		await cleanupDocumentBatch(ctx, args.documentId),
});
