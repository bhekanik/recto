import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type QueryCtx,
} from "./_generated/server";
import { requireOwnedDocument, requireUserId } from "./documents";

/**
 * RAG over the writer's own drafts via Convex vector search (plan 009, Phase C).
 *
 * Embedding GENERATION lives in the Next route `app/api/ai/embed` because the
 * provider key (`OPENROUTER_API_KEY`) is in the Next server env per the provider
 * override — NOT in Convex env. So the *client* orchestrates re-indexing:
 *   1. read the doc markdown + chunk it (lib/ai/chunk.ts),
 *   2. POST the chunk texts to /api/ai/embed → vectors,
 *   3. call `embeddings.replaceChunks` (mutation) to persist them.
 * Query-time search mirrors that: the client embeds the query text via the Next
 * route, then calls `embeddings.searchByVector` (action) with the vector.
 *
 * The scheduled cron path (`reindexSweep`) now generates embeddings directly from
 * inside the Convex action via a `fetch` to OpenRouter, using the
 * `OPENROUTER_API_KEY` that lives in the Convex deployment env. It mirrors the
 * request/response shape of the Next route.
 */

const CHUNK_LIMIT = 256; // safety cap on chunks per document
const VECTOR_RESULTS = 8;

/**
 * Embedding model + dimension, kept in sync with lib/ai/config.ts and the
 * `docChunks` vectorIndex in convex/schema.ts (1536). Inlined here rather than
 * imported because app `lib/` code isn't on the Convex bundle/path-alias graph
 * (the embedding request/server helpers pull in `server-only`/Clerk).
 */
const AI_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const AI_EMBEDDING_DIM = 1536;
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

/** How many stale documents to embed per scheduled sweep (bounds action time). */
const SWEEP_DOC_LIMIT = 25;

/** Target chunk window in characters — mirrors CHUNK_TARGET_CHARS in lib/ai/chunk.ts. */
const CHUNK_TARGET_CHARS = 1500;

type CronChunk = { charStart: number; charEnd: number; text: string };

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

/** OpenRouter embeddings response shape (OpenAI-compatible). */
type EmbeddingsResponse = { data?: { embedding: number[] }[] };

/**
 * Embed a batch of texts via OpenRouter's OpenAI-compatible `/embeddings`
 * endpoint. Mirrors the Next route's request (`{ model, input }`) and response
 * (`{ data: [{ embedding }] }`) handling. Empty strings are dropped (the API
 * rejects them); order is preserved so callers can zip vectors back to chunks.
 */
async function embedTexts(
	apiKey: string,
	texts: string[],
): Promise<number[][]> {
	const input = texts.map((s) => s.trim()).filter((s) => s.length > 0);
	if (input.length === 0) return [];
	const res = await fetch(OPENROUTER_EMBEDDINGS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"X-Title": "Recto",
		},
		body: JSON.stringify({ model: AI_EMBEDDING_MODEL, input }),
	});
	if (!res.ok) {
		throw new Error(`OpenRouter embeddings failed: ${res.status}`);
	}
	const json = (await res.json()) as EmbeddingsResponse;
	const vectors = (json.data ?? []).map((d) => d.embedding);
	for (const vec of vectors) {
		if (vec.length !== AI_EMBEDDING_DIM) {
			throw new Error(
				`OpenRouter embeddings returned dim ${vec.length}, expected ${AI_EMBEDDING_DIM}`,
			);
		}
	}
	return vectors;
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
		chunks: v.array(chunkValidator),
	},
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		const existing = await ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
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
	args: { ids: v.array(v.id("docChunks")) },
	handler: async (ctx, args) => {
		const rows = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
		return rows.filter((r) => r !== null);
	},
});

/** Internal: document titles for citations. */
export const titlesByIds = internalQuery({
	args: { ids: v.array(v.id("documents")) },
	handler: async (ctx, args) => {
		const map: Record<string, string> = {};
		for (const id of args.ids) {
			const doc = await ctx.db.get(id);
			if (doc) map[id] = doc.title;
		}
		return map;
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
			limit: VECTOR_RESULTS,
			filter: (q) => q.eq("userId", userId),
		});
		if (results.length === 0) return [];

		const rows = await ctx.runQuery(internal.embeddings.chunkRowsByIds, {
			ids: results.map((r) => r._id),
		});
		const scoreById = new Map(results.map((r) => [r._id, r._score]));

		const docIds = Array.from(new Set(rows.map((r) => r.documentId)));
		const titles = await ctx.runQuery(internal.embeddings.titlesByIds, {
			ids: docIds,
		});

		return rows
			.filter((r) => r.documentId !== args.excludeDocumentId)
			.map((r) => ({
				documentId: r.documentId,
				title: titles[r.documentId] ?? "Untitled",
				text: r.text,
				charStart: r.charStart,
				charEnd: r.charEnd,
				score: scoreById.get(r._id) ?? 0,
			}));
	},
});

/**
 * Scan for stale documents (currentNodeId ≠ stored embeddedNodeId). Scoped
 * across all users since the sweep is deployment-wide. Shared by the cron's
 * `allStaleDocuments` and the `embeddingHealth` query.
 */
async function findStaleDocuments(ctx: QueryCtx): Promise<
	{
		documentId: Id<"documents">;
		currentNodeId: string;
		markdown: string;
	}[]
> {
	const docs = await ctx.db.query("documents").collect();
	const out: {
		documentId: Id<"documents">;
		currentNodeId: string;
		markdown: string;
	}[] = [];
	for (const doc of docs) {
		const first = await ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", doc._id))
			.first();
		if (!first || first.embeddedNodeId !== doc.currentNodeId) {
			out.push({
				documentId: doc._id,
				currentNodeId: doc.currentNodeId,
				markdown: doc.markdown,
			});
		}
	}
	return out;
}

/**
 * Internal: list stale documents for the cron (action context). Scoped across
 * all users since the cron has no caller identity.
 */
export const allStaleDocuments = internalQuery({
	args: {},
	handler: async (ctx) => findStaleDocuments(ctx),
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
	handler: async (ctx): Promise<{ staleCount: number }> => {
		await requireUserId(ctx);
		const stale = await findStaleDocuments(ctx);
		return { staleCount: stale.length };
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
		chunks: v.array(chunkValidator),
	},
	handler: async (ctx, args) => {
		const doc = await ctx.db.get(args.documentId);
		if (!doc) return { count: 0 };
		const existing = await ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
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

/**
 * Scheduled re-embed sweep (cron entry, plan 009 Phase C).
 *
 * For each stale document (currentNodeId ≠ stored embeddedNodeId): chunk its
 * markdown, embed the chunks via OpenRouter's `/embeddings` endpoint using the
 * Convex-side `OPENROUTER_API_KEY`, then persist via `replaceChunksInternal` and
 * advance `embeddedNodeId` to the current node so it isn't re-embedded next sweep.
 *
 * Bounded to `SWEEP_DOC_LIMIT` documents per run to respect Convex action limits;
 * remaining stale docs are picked up on the next daily run. If the key is missing
 * the sweep logs and returns gracefully (it does NOT throw — a cron failure would
 * just retry forever). Per-document errors are logged and skipped so one bad doc
 * doesn't abort the whole sweep.
 */
export const reindexSweep = internalAction({
	args: {},
	handler: async (ctx): Promise<{ scanned: number; embedded: number }> => {
		const stale = await ctx.runQuery(internal.embeddings.allStaleDocuments, {});

		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			console.warn(
				"reindexSweep: OPENROUTER_API_KEY not set in Convex env — skipping embedding generation",
			);
			return { scanned: stale.length, embedded: 0 };
		}

		let embedded = 0;
		for (const doc of stale.slice(0, SWEEP_DOC_LIMIT)) {
			try {
				const chunks = chunkMarkdown(doc.markdown).slice(0, CHUNK_LIMIT);
				if (chunks.length === 0) {
					// No content to embed — still advance the pointer so an empty doc
					// isn't rescanned every sweep.
					await ctx.runMutation(internal.embeddings.replaceChunksInternal, {
						documentId: doc.documentId,
						embeddedNodeId: doc.currentNodeId,
						chunks: [],
					});
					embedded++;
					continue;
				}

				const vectors = await embedTexts(
					apiKey,
					chunks.map((c) => c.text),
				);
				if (vectors.length !== chunks.length) {
					console.warn(
						`reindexSweep: vector/chunk count mismatch for ${doc.documentId} (${vectors.length} vs ${chunks.length}) — skipping`,
					);
					continue;
				}

				await ctx.runMutation(internal.embeddings.replaceChunksInternal, {
					documentId: doc.documentId,
					embeddedNodeId: doc.currentNodeId,
					chunks: chunks.map((c, idx) => ({
						charStart: c.charStart,
						charEnd: c.charEnd,
						text: c.text,
						embedding: vectors[idx] as number[],
					})),
				});
				embedded++;
			} catch (err) {
				console.error(
					`reindexSweep: failed to re-embed ${doc.documentId}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		return { scanned: stale.length, embedded };
	},
});
