"use client";

import { useAction, useMutation } from "convex/react";
import { useCallback } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { RelatedPassage } from "@/convex/embeddings";
import { chunk } from "./chunk";

/** Embed a batch of texts via the Next route (key stays server-side). */
async function embedTexts(
	inputs: string[],
	signal?: AbortSignal,
): Promise<number[][]> {
	const res = await fetch("/api/ai/embed", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ inputs }),
		signal,
	});
	if (!res.ok) {
		throw new Error(
			res.status === 401
				? "Sign in to use AI"
				: `Embedding failed (${res.status})`,
		);
	}
	const data = (await res.json()) as { embeddings: number[][] };
	return data.embeddings;
}

/**
 * Client orchestration for RAG over past drafts (plan 009, Phase C). Embedding
 * generation goes through the Next route (where the key lives); persistence and
 * vector search go through Convex.
 */
export function useRag() {
	const replaceChunks = useMutation(api.embeddings.replaceChunks);
	const searchByVector = useAction(api.embeddings.searchByVector);

	/** Re-index one document: chunk → embed → persist. Returns chunk count. */
	const reindexDocument = useCallback(
		async (input: {
			documentId: Id<"documents">;
			currentNodeId: string;
			markdown: string;
			signal?: AbortSignal;
		}): Promise<number> => {
			const chunks = chunk(input.markdown);
			if (chunks.length === 0) {
				// Clear stale chunks so an emptied doc stops surfacing.
				await replaceChunks({
					documentId: input.documentId,
					embeddedNodeId: input.currentNodeId,
					chunks: [],
				});
				return 0;
			}
			const embeddings = await embedTexts(
				chunks.map((c) => c.text),
				input.signal,
			);
			if (embeddings.length !== chunks.length) {
				throw new Error("Embedding count did not match chunk count");
			}
			await replaceChunks({
				documentId: input.documentId,
				embeddedNodeId: input.currentNodeId,
				chunks: chunks.map((c, i) => ({
					charStart: c.charStart,
					charEnd: c.charEnd,
					text: c.text,
					embedding: embeddings[i] as number[],
				})),
			});
			return chunks.length;
		},
		[replaceChunks],
	);

	/** Find related passages to a query text, excluding the current document. */
	const findRelated = useCallback(
		async (input: {
			queryText: string;
			excludeDocumentId?: Id<"documents">;
			signal?: AbortSignal;
		}): Promise<RelatedPassage[]> => {
			const trimmed = input.queryText.trim();
			if (!trimmed) return [];
			const [vector] = await embedTexts([trimmed.slice(0, 4000)], input.signal);
			if (!vector) return [];
			return await searchByVector({
				vector,
				excludeDocumentId: input.excludeDocumentId,
			});
		},
		[searchByVector],
	);

	return { reindexDocument, findRelated };
}
