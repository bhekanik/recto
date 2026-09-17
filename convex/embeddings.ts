import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { findTombstone } from "./accountGuard";
import { AI_CONSENT_VERSION } from "./ai/consent";
import { aiError } from "./ai/errors";
import { sha256 } from "./ai/request";
import { requireOwnedDocument, requireUserId } from "./documents";

/**
 * RAG over the writer's own drafts via Convex vector search (plan 009, Phase C).
 *
 * Both interactive and scheduled generation use `ai.embed.run`'s durable run
 * protocol. The client or cron chunks text, embeds at most 16 chunks per run,
 * then persists only while the exact source and access fences still match.
 */

const CHUNK_LIMIT = 256; // safety cap on chunks per document
const VECTOR_RESULTS = 8;
// Vector search can filter by user but not exclude a document, and the active
// draft's own chunks match a query cut from it better than anything else. Fetch
// enough that eight survive once those, and overlapping neighbours, are removed.
const VECTOR_CANDIDATES = 48;
const MAX_PASSAGES_PER_DOCUMENT = 3;

/**
 * Embedding model + dimension, kept in sync with lib/ai/config.ts and the
 * `docChunks` vectorIndex in convex/schema.ts (1536). Inlined here rather than
 * imported because app `lib/` code isn't on the Convex bundle/path-alias graph
 * (the embedding request/server helpers pull in `server-only`/Clerk).
 */
const AI_EMBEDDING_DIM = 1536;

/** How many stale documents to embed per scheduled sweep (bounds action time). */
const SWEEP_DOC_LIMIT = 25;
const SWEEP_SCAN_LIMIT = SWEEP_DOC_LIMIT;
const EMBED_BATCH = 16;

/** Target chunk window in characters — mirrors CHUNK_TARGET_CHARS in lib/ai/chunk.ts. */
const CHUNK_TARGET_CHARS = 1500;

type CronChunk = { charStart: number; charEnd: number; text: string };
type StaleDocument = {
	documentId: Id<"documents">;
	userId: string;
	currentNodeId: string;
	markdown: string;
};

export async function scheduledEmbedRequestId(args: {
	documentId: string;
	sourceNodeId: string;
	sourceHash: string;
	offset: number;
	inputs: string[];
}): Promise<string> {
	return `embed:cron:${await sha256(JSON.stringify(args))}`;
}

/**
 * Paragraph-windowed chunking — a self-contained copy of lib/ai/chunk.ts's
 * `chunk` (same algorithm, so cron-side chunks match the client path). Splits on
 * blank lines, greedily packs paragraphs into ~CHUNK_TARGET_CHARS windows with
 * one-paragraph overlap, carrying exact source offsets.
 */
function chunkMarkdown(markdown: string): CronChunk[] {
	const paras: { start: number; end: number }[] = [];
	const len = markdown.length;
	let i = 0;
	while (i < len) {
		while (i < len && /\s/.test(markdown[i] as string)) i++;
		if (i >= len) break;
		const start = i;
		while (i < len) {
			if (markdown[i] === "\n") {
				let j = i + 1;
				while (
					j < len &&
					markdown[j] !== "\n" &&
					/\s/.test(markdown[j] as string)
				) {
					j++;
				}
				if (j >= len || markdown[j] === "\n") break;
			}
			i++;
		}
		const end = i;
		if (markdown.slice(start, end).trim().length > 0)
			paras.push({ start, end });
	}
	if (paras.length === 0) return [];

	const chunks: CronChunk[] = [];
	let p = 0;
	while (p < paras.length) {
		const windowStart = paras[p]?.start ?? 0;
		let windowEnd = paras[p]?.end ?? 0;
		let j = p + 1;
		while (j < paras.length) {
			const next = paras[j];
			if (!next) break;
			if (next.end - windowStart > CHUNK_TARGET_CHARS) break;
			windowEnd = next.end;
			j++;
		}
		chunks.push({
			charStart: windowStart,
			charEnd: windowEnd,
			text: markdown.slice(windowStart, windowEnd),
		});
		if (j >= paras.length) break;
		p = j - 1 > p ? j - 1 : j;
	}
	return chunks;
}

/** One chunk in the client → Convex upsert payload. */
const chunkValidator = v.object({
	charStart: v.number(),
	charEnd: v.number(),
	text: v.string(),
	embedding: v.array(v.float64()),
});

/**
 * Replace all chunks for a document in one shot (delete prior, insert new).
 * Scoped by ownership. `embeddedNodeId` records the pointer at embed time so the
 * cron can skip unchanged documents.
 */
export const replaceChunks = mutation({
	args: {
		documentId: v.id("documents"),
		embeddedNodeId: v.string(),
		expectedMarkdown: v.string(),
		chunks: v.array(chunkValidator),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		if (doc.currentNodeId !== args.embeddedNodeId) {
			aiError("document_changed", "The document changed before indexing.");
		}
		if (doc.markdown !== args.expectedMarkdown) {
			aiError("document_changed", "The draft changed before indexing.");
		}
		if (await findTombstone(ctx, doc.userId)) {
			aiError(
				"account_deletion_in_progress",
				"Account deletion is in progress.",
			);
		}
		const deletion = await ctx.db
			.query("aiDocumentDeletions")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.unique();
		if (deletion) aiError("document_not_found", "Document not found");
		const consent = await ctx.db
			.query("aiConsents")
			.withIndex("by_user", (q) => q.eq("userId", doc.userId))
			.unique();
		if (consent?.version !== AI_CONSENT_VERSION) {
			aiError(
				"ai_consent_required",
				"Accept the current AI consent notice first.",
			);
		}
		const share = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.first();
		if (share) aiError("document_shared", "AI is disabled on shared documents");
		const existing = await ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.take(CHUNK_LIMIT + 1);
		if (existing.length > CHUNK_LIMIT) {
			throw new Error(
				"Document has too many stored embedding chunks to replace safely.",
			);
		}
		for (const row of existing) await ctx.db.delete(row._id);

		const now = Date.now();
		const chunks = args.chunks.slice(0, CHUNK_LIMIT);
		for (const c of chunks) {
			await ctx.db.insert("docChunks", {
				userId: doc.userId,
				documentId: args.documentId,
				charStart: c.charStart,
				charEnd: c.charEnd,
				text: c.text,
				embedding: c.embedding,
				embeddedNodeId: args.embeddedNodeId,
				updatedAt: now,
			});
		}
		return { count: chunks.length };
	},
});

/** Internal: load chunk rows by id for an action (actions have no ctx.db). */
export const chunkRowsByIds = internalQuery({
	args: { ids: v.array(v.id("docChunks")), userId: v.string() },
	handler: async (ctx, args) => {
		if (await findTombstone(ctx, args.userId)) {
			aiError(
				"account_deletion_in_progress",
				"Account deletion is in progress.",
			);
		}
		const consent = await ctx.db
			.query("aiConsents")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		if (consent?.version !== AI_CONSENT_VERSION) {
			aiError(
				"ai_consent_required",
				"Accept the current AI consent notice first.",
			);
		}
		const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
		const safe = [];
		for (const row of rows) {
			if (!row || row.userId !== args.userId) continue;
			const document = await ctx.db.get(row.documentId);
			if (!document || document.userId !== args.userId) continue;
			const deletion = await ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", row.documentId))
				.unique();
			if (deletion) continue;
			const share = await ctx.db
				.query("documentShares")
				.withIndex("by_document", (q) => q.eq("documentId", row.documentId))
				.first();
			if (!share) safe.push({ ...row, title: document.title });
		}
		return safe;
	},
});

export type RelatedPassage = {
	documentId: Id<"documents">;
	title: string;
	text: string;
	charStart: number;
	charEnd: number;
	score: number;
};

/**
 * Pick the passages to show from scored candidates: not the active draft, no two
 * overlapping windows of one document (chunks share a paragraph, so neighbours
 * repeat text), and a per-document cap so one long draft cannot fill the panel.
 */
export function selectPassages(
	candidates: RelatedPassage[],
	excludeDocumentId: Id<"documents"> | undefined,
): RelatedPassage[] {
	const kept: RelatedPassage[] = [];
	const perDocument = new Map<Id<"documents">, number>();
	for (const candidate of candidates.toSorted((a, b) => b.score - a.score)) {
		if (kept.length === VECTOR_RESULTS) break;
		if (candidate.documentId === excludeDocumentId) continue;
		const count = perDocument.get(candidate.documentId) ?? 0;
		if (count === MAX_PASSAGES_PER_DOCUMENT) continue;
		const overlapsKept = kept.some(
			(other) =>
				other.documentId === candidate.documentId &&
				candidate.charStart < other.charEnd &&
				other.charStart < candidate.charEnd,
		);
		if (overlapsKept) continue;
		kept.push(candidate);
		perDocument.set(candidate.documentId, count + 1);
	}
	return kept;
}

/**
 * Search past drafts by a pre-computed query embedding (the client embeds the
 * query text via the Next route first). Runs ctx.vectorSearch filtered to the
 * caller, loads the matched rows, and returns cited passages. Actions can't touch
 * ctx.db, so it loads rows + titles via internal queries.
 */
export const searchByVector = action({
	args: {
		vector: v.array(v.float64()),
		excludeDocumentId: v.optional(v.id("documents")),
	},
	handler: async (ctx, args): Promise<RelatedPassage[]> => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) throw new Error("Unauthenticated");
		const userId = identity.subject;

		// The query vector must match the index dimension (the generation path
		// already enforces AI_EMBEDDING_DIM); reject a wrong-dim vector rather than
		// let ctx.vectorSearch reject it opaquely.
		if (args.vector.length !== AI_EMBEDDING_DIM) {
			throw new Error(
				`Query vector has dim ${args.vector.length}, expected ${AI_EMBEDDING_DIM}`,
			);
		}

		const results = await ctx.vectorSearch("docChunks", "by_embedding", {
			vector: args.vector,
			limit: VECTOR_CANDIDATES,
			filter: (q) => q.eq("userId", userId),
		});
		if (results.length === 0) return [];

		const rows = await ctx.runQuery(internal.embeddings.chunkRowsByIds, {
			ids: results.map((r) => r._id),
			userId,
		});
		const scoreById = new Map(results.map((r) => [r._id, r._score]));

		return selectPassages(
			rows.map((r) => ({
				documentId: r.documentId,
				title: r.title,
				text: r.text,
				charStart: r.charStart,
				charEnd: r.charEnd,
				score: scoreById.get(r._id) ?? 0,
			})),
			args.excludeDocumentId,
		);
	},
});

/**
 * Scan for stale documents (currentNodeId ≠ stored embeddedNodeId). Scoped
 * across all users since the sweep is deployment-wide. Shared by the cron's
 * `allStaleDocuments` and the `embeddingHealth` query.
 *
 * A document with NO chunk rows whose markdown chunks to nothing (e.g. empty)
 * is NOT stale: there is nothing to embed, and with zero rows there is nowhere
 * to persist an embeddedNodeId, so counting it would keep staleCount
 * permanently >= 1 and make the sweep "re-embed" it daily forever. A doc WITH
 * rows but zero-chunk markdown stays stale so the sweep can purge the
 * lingering rows (see reindexSweep's zero-chunk guard).
 */
async function findStaleDocuments(
	ctx: QueryCtx,
	docs: Doc<"documents">[],
	cronSafe = false,
): Promise<StaleDocument[]> {
	const allowlisted = new Set(
		(process.env.AI_UNMETERED_USER_IDS ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	);
	const out: StaleDocument[] = [];
	for (const doc of docs) {
		if (cronSafe) {
			if (!allowlisted.has(doc.userId)) continue;
			if (await findTombstone(ctx, doc.userId)) continue;
			const deletion = await ctx.db
				.query("aiDocumentDeletions")
				.withIndex("by_document", (q) => q.eq("documentId", doc._id))
				.unique();
			if (deletion) continue;
			const consent = await ctx.db
				.query("aiConsents")
				.withIndex("by_user", (q) => q.eq("userId", doc.userId))
				.unique();
			if (consent?.version !== AI_CONSENT_VERSION) continue;
			const share = await ctx.db
				.query("documentShares")
				.withIndex("by_document", (q) => q.eq("documentId", doc._id))
				.first();
			if (share) continue;
		}
		const first = await ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", doc._id))
			.first();
		if (first) {
			if (first.embeddedNodeId === doc.currentNodeId) continue; // fresh
		} else if (chunkMarkdown(doc.markdown).length === 0) {
			continue; // nothing to embed, no rows to purge — not stale
		}
		out.push({
			documentId: doc._id,
			userId: doc.userId,
			currentNodeId: doc.currentNodeId,
			markdown: doc.markdown,
		});
	}
	return out;
}

/**
 * Internal: list stale documents for the cron (action context). Scoped across
 * all users since the cron has no caller identity.
 */
export const allStaleDocuments = internalQuery({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query("embeddingHealthState")
			.withIndex("by_name", (q) => q.eq("name", "global"))
			.unique();
		const cursor =
			args.cursor === undefined ? (state?.sweepCursor ?? null) : args.cursor;
		const result = await ctx.db.query("documents").order("asc").paginate({
			cursor,
			numItems: SWEEP_SCAN_LIMIT,
			maximumRowsRead: SWEEP_SCAN_LIMIT,
		});
		const [cronStale, allStale] = await Promise.all([
			findStaleDocuments(ctx, result.page, true),
			findStaleDocuments(ctx, result.page),
		]);
		return {
			startedAtBeginning: cursor === null,
			stale: cronStale,
			staleCount: allStale.length,
			continueCursor: result.continueCursor,
			isDone: result.isDone,
			scanned: result.page.length,
		};
	},
});

/**
 * Health signal for the re-embed pipeline (plan 015). Reports how many
 * documents are stale (edited since last embed). A staleCount that only ever
 * grows across daily sweeps means the sweep is degraded — most likely
 * `OPENROUTER_API_KEY` missing from the Convex deployment env (the sweep
 * deliberately skips without throwing in that case; see `reindexSweep`).
 * Auth-gated: any signed-in user may read the count (it's a scalar ops signal,
 * no document content). A future status-bar indicator can consume this.
 */
export const embeddingHealth = query({
	args: {},
	handler: async (ctx): Promise<{ staleCount: number | null }> => {
		await requireUserId(ctx);
		const state = await ctx.db
			.query("embeddingHealthState")
			.withIndex("by_name", (q) => q.eq("name", "global"))
			.unique();
		if (state)
			return {
				staleCount: state.hasCompletedSweep === false ? null : state.staleCount,
			};
		const firstPage = await ctx.db
			.query("documents")
			.order("asc")
			.take(SWEEP_SCAN_LIMIT + 1);
		if (firstPage.length > SWEEP_SCAN_LIMIT) return { staleCount: null };
		const stale = await findStaleDocuments(ctx, firstPage);
		return { staleCount: stale.length };
	},
});

export type EmbeddingSweepProgress = {
	staleCount: number;
	scannedCount: number;
	pendingStaleCount?: number;
	pendingScannedCount?: number;
	sweepCursor?: string;
	hasCompletedSweep?: boolean;
};

export function nextEmbeddingSweepProgress(args: {
	previous?: EmbeddingSweepProgress;
	startedAtBeginning: boolean;
	isDone: boolean;
	continueCursor: string;
	pageStaleCount: number;
	pageScannedCount: number;
	resolvedCount: number;
}): EmbeddingSweepProgress {
	const pendingStaleCount =
		(args.startedAtBeginning ? 0 : (args.previous?.pendingStaleCount ?? 0)) +
		args.pageStaleCount -
		args.resolvedCount;
	const pendingScannedCount =
		(args.startedAtBeginning ? 0 : (args.previous?.pendingScannedCount ?? 0)) +
		args.pageScannedCount;
	if (args.isDone) {
		return {
			staleCount: Math.max(0, pendingStaleCount),
			scannedCount: pendingScannedCount,
			pendingStaleCount: undefined,
			pendingScannedCount: undefined,
			sweepCursor: undefined,
			hasCompletedSweep: true,
		};
	}
	return {
		staleCount: args.previous?.staleCount ?? 0,
		scannedCount: args.previous?.scannedCount ?? 0,
		pendingStaleCount,
		pendingScannedCount,
		sweepCursor: args.continueCursor,
		hasCompletedSweep: args.previous?.hasCompletedSweep ?? false,
	};
}

export const recordEmbeddingSweepPage = internalMutation({
	args: {
		startedAtBeginning: v.boolean(),
		isDone: v.boolean(),
		continueCursor: v.string(),
		pageStaleCount: v.number(),
		pageScannedCount: v.number(),
		resolvedCount: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("embeddingHealthState")
			.withIndex("by_name", (q) => q.eq("name", "global"))
			.unique();
		const value = {
			...nextEmbeddingSweepProgress({
				previous: existing ?? undefined,
				...args,
			}),
			updatedAt: Date.now(),
		};
		if (existing) await ctx.db.patch(existing._id, value);
		else
			await ctx.db.insert("embeddingHealthState", { name: "global", ...value });
	},
});

/**
 * Internal: persist chunks from the cron (no caller identity — trusts the
 * internalAction). Looks up the owning userId from the document.
 */
export const replaceChunksInternal = internalMutation({
	args: {
		documentId: v.id("documents"),
		embeddedNodeId: v.string(),
		expectedMarkdown: v.string(),
		chunks: v.array(chunkValidator),
	},
	handler: async (ctx, args) => {
		const doc = await ctx.db.get(args.documentId);
		if (!doc) return { applied: false as const, count: 0 };
		if (doc.currentNodeId !== args.embeddedNodeId)
			return { applied: false as const, count: 0 };
		if (doc.markdown !== args.expectedMarkdown)
			return { applied: false as const, count: 0 };
		if (await findTombstone(ctx, doc.userId))
			return { applied: false as const, count: 0 };
		const deletion = await ctx.db
			.query("aiDocumentDeletions")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.unique();
		if (deletion) return { applied: false as const, count: 0 };
		const consent = await ctx.db
			.query("aiConsents")
			.withIndex("by_user", (q) => q.eq("userId", doc.userId))
			.unique();
		if (consent?.version !== AI_CONSENT_VERSION)
			return { applied: false as const, count: 0 };
		const share = await ctx.db
			.query("documentShares")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.first();
		if (share) return { applied: false as const, count: 0 };
		const existing = await ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.take(CHUNK_LIMIT + 1);
		if (existing.length > CHUNK_LIMIT)
			return { applied: false as const, count: 0 };
		for (const row of existing) await ctx.db.delete(row._id);
		const now = Date.now();
		const chunks = args.chunks.slice(0, CHUNK_LIMIT);
		for (const c of chunks) {
			await ctx.db.insert("docChunks", {
				userId: doc.userId,
				documentId: args.documentId,
				charStart: c.charStart,
				charEnd: c.charEnd,
				text: c.text,
				embedding: c.embedding,
				embeddedNodeId: args.embeddedNodeId,
				updatedAt: now,
			});
		}
		return { applied: true as const, count: chunks.length };
	},
});

/**
 * Scheduled re-embed sweep (cron entry, plan 009 Phase C).
 *
 * For each stale document (currentNodeId ≠ stored embeddedNodeId): chunk its
 * markdown, embed the chunks via OpenRouter's `/embeddings` endpoint using the
 * Convex-side `OPENROUTER_API_KEY`, then persist via `replaceChunksInternal` and
 * advance `embeddedNodeId` to the current node so it isn't re-embedded next sweep.
 *
 * Each run advances one persisted `SWEEP_DOC_LIMIT` page, even when every provider
 * call fails, so bad early documents cannot starve the rest of the corpus. If the key is missing
 * the sweep logs and returns gracefully (it does NOT throw — a cron failure would
 * just retry forever). Per-document errors are logged and skipped so one bad doc
 * doesn't abort the whole sweep.
 */
export const reindexSweep = internalAction({
	args: {},
	handler: async (ctx): Promise<{ scanned: number; embedded: number }> => {
		const page: {
			stale: StaleDocument[];
			continueCursor: string;
			staleCount: number;
			isDone: boolean;
			scanned: number;
			startedAtBeginning: boolean;
		} = await ctx.runQuery(internal.embeddings.allStaleDocuments, {});

		if (!process.env.OPENROUTER_API_KEY?.trim()) {
			console.warn(
				"reindexSweep: OPENROUTER_API_KEY not set in Convex env — skipping embedding generation",
			);
			await ctx.runMutation(internal.embeddings.recordEmbeddingSweepPage, {
				...page,
				pageStaleCount: page.staleCount,
				pageScannedCount: page.scanned,
				resolvedCount: 0,
			});
			return { scanned: page.scanned, embedded: 0 };
		}

		let embedded = 0;
		let purged = 0;
		for (const doc of page.stale) {
			try {
				const chunks = chunkMarkdown(doc.markdown).slice(0, CHUNK_LIMIT);
				if (chunks.length === 0) {
					// Guard, reachable only for a doc that HAS lingering chunk rows but
					// whose markdown now chunks to nothing — i.e. it was emptied and the
					// client-side purge (lib/ai/use-rag.ts) never ran. findStaleDocuments
					// excludes zero-chunk docs with no rows, so this can't loop: purge
					// the rows here and the next scan skips the doc. Nothing is embedded,
					// so the counter is untouched.
					const result = await ctx.runMutation(
						internal.embeddings.replaceChunksInternal,
						{
							documentId: doc.documentId,
							embeddedNodeId: doc.currentNodeId,
							expectedMarkdown: doc.markdown,
							chunks: [],
						},
					);
					if (result.applied) purged += 1;
					continue;
				}

				const sourceHash = await sha256(doc.markdown);
				const vectors: number[][] = [];
				for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
					const inputs = chunks
						.slice(offset, offset + EMBED_BATCH)
						.map((chunk) => chunk.text);
					const requestId = await scheduledEmbedRequestId({
						documentId: doc.documentId,
						sourceNodeId: doc.currentNodeId,
						sourceHash,
						offset,
						inputs,
					});
					vectors.push(
						...(await ctx.runAction(internal.ai.embed.runScheduled, {
							userId: doc.userId,
							requestId,
							documentId: doc.documentId,
							sourceNodeId: doc.currentNodeId,
							sourceHash,
							inputs,
						})),
					);
				}
				if (vectors.length !== chunks.length) {
					console.warn(
						`reindexSweep: vector/chunk count mismatch for ${doc.documentId} (${vectors.length} vs ${chunks.length}) — skipping`,
					);
					continue;
				}

				const persistedChunks = chunks.map((chunk, index) => {
					const embedding = vectors[index];
					if (!embedding) throw new Error("Missing embedding vector.");
					return {
						charStart: chunk.charStart,
						charEnd: chunk.charEnd,
						text: chunk.text,
						embedding,
					};
				});
				const replaced = await ctx.runMutation(
					internal.embeddings.replaceChunksInternal,
					{
						documentId: doc.documentId,
						embeddedNodeId: doc.currentNodeId,
						expectedMarkdown: doc.markdown,
						chunks: persistedChunks,
					},
				);
				if (replaced.applied && replaced.count === chunks.length) embedded += 1;
			} catch (err) {
				console.error(
					`reindexSweep: failed to re-embed ${doc.documentId}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		await ctx.runMutation(internal.embeddings.recordEmbeddingSweepPage, {
			...page,
			pageStaleCount: page.staleCount,
			pageScannedCount: page.scanned,
			resolvedCount: embedded + purged,
		});
		return { scanned: page.scanned, embedded };
	},
});
