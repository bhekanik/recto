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
 * The scheduled cron path (`reindexSweep`) is scaffolded but cannot generate
 * embeddings from inside Convex without the key — see the BLOCKED note there.
 */

const CHUNK_LIMIT = 256; // safety cap on chunks per document
const VECTOR_RESULTS = 8;

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

/** Documents whose currentNodeId differs from their stored embeddedNodeId. */
export const staleDocuments = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const docs = await ctx.db
			.query("documents")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();
		const out: { documentId: Id<"documents">; currentNodeId: string }[] = [];
		for (const doc of docs) {
			const first = await ctx.db
				.query("docChunks")
				.withIndex("by_document", (q) => q.eq("documentId", doc._id))
				.first();
			if (!first || first.embeddedNodeId !== doc.currentNodeId) {
				out.push({ documentId: doc._id, currentNodeId: doc.currentNodeId });
			}
		}
		return out;
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
 * Internal: list stale documents for the cron (action context). Mirrors
 * `staleDocuments` but scoped across all users since the cron has no caller
 * identity.
 */
export const allStaleDocuments = internalQuery({
	args: {},
	handler: async (ctx) => {
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
 * ⚠️ BLOCKED — embedding generation: this scheduled action runs inside Convex,
 * which does NOT have the embedding provider key. Per the provider override the
 * key (`OPENROUTER_API_KEY`) lives only in the Next server env, and a Convex cron
 * cannot call the Clerk-protected Next route. So the cron path can identify stale
 * documents but cannot generate embeddings on its own.
 *
 * To unblock: set an embedding key in CONVEX env (e.g.
 * `npx convex env set OPENROUTER_API_KEY <value>`) and replace the marked block
 * below with a fetch to the OpenRouter embeddings endpoint (the chunking +
 * request shapes already exist in lib/ai/chunk.ts and lib/ai/embed-request.ts).
 * Until then, re-indexing runs through the client "Re-index drafts" command,
 * which uses the Next route.
 */
export const reindexSweep = internalAction({
	args: {},
	handler: async (ctx): Promise<{ scanned: number; embedded: number }> => {
		const stale = await ctx.runQuery(internal.embeddings.allStaleDocuments, {});
		// BLOCKED: cannot generate embeddings here without a Convex-side key.
		// When unblocked, for each `stale` doc: chunk(markdown) → embed via
		// OpenRouter → ctx.runMutation(internal.embeddings.replaceChunksInternal,
		// { documentId, embeddedNodeId: currentNodeId, chunks }).
		return { scanned: stale.length, embedded: 0 };
	},
});

/** Client-callable: clear a document's chunks (used by "Re-index" before re-embed if needed). */
export const clearChunks = mutation({
	args: { documentId: v.id("documents") },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const rows = await ctx.db
			.query("docChunks")
			.withIndex("by_document", (q) => q.eq("documentId", args.documentId))
			.collect();
		for (const row of rows) await ctx.db.delete(row._id);
		return { cleared: rows.length };
	},
});
