"use client";

import { useAction, useMutation } from "convex/react";
import { useCallback, useRef } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { RelatedPassage } from "@/convex/embeddings";
import { type Chunk, chunk } from "./chunk";
import { AiRequestOwner, sha256Text } from "./request-owner";

const EMBED_BATCH = 16;
export const MAX_DOCUMENT_CHUNKS = 256;

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export function chunksForIndex(markdown: string): Chunk[] {
	return chunk(markdown).slice(0, MAX_DOCUMENT_CHUNKS);
}

export async function embedBatchRequestId(input: {
	purpose: "query" | "reindex";
	documentId: string;
	sourceNodeId: string;
	sourceHash: string;
	offset: number;
	texts: string[];
}): Promise<string> {
	const digest = await sha256Text(JSON.stringify(input));
	return `embed:${input.purpose}:${digest}`;
}

export function useRag() {
	const replaceChunks = useMutation(api.embeddings.replaceChunks);
	const searchByVector = useAction(api.embeddings.searchByVector);
	const embed = useAction(api.ai.embed.run);
	const ownerRef = useRef(new AiRequestOwner());

	const embedTexts = useCallback(
		async (input: {
			purpose: "query" | "reindex";
			documentId: Id<"documents">;
			sourceNodeId: string;
			sourceMarkdown: string;
			texts: string[];
			signal?: AbortSignal;
		}): Promise<number[][]> => {
			throwIfAborted(input.signal);
			const ticket = ownerRef.current.begin(input.documentId);
			const onAbort = () => ownerRef.current.supersedeIfCurrent(ticket);
			input.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const sourceHash = await sha256Text(input.sourceMarkdown);
				if (!ownerRef.current.isCurrent(ticket, input.documentId)) {
					throw new DOMException("Aborted", "AbortError");
				}
				const vectors: number[][] = [];
				for (
					let offset = 0;
					offset < input.texts.length;
					offset += EMBED_BATCH
				) {
					if (!ownerRef.current.markSent(ticket)) {
						throw new DOMException("Aborted", "AbortError");
					}
					const texts = input.texts.slice(offset, offset + EMBED_BATCH);
					const requestId = await embedBatchRequestId({
						purpose: input.purpose,
						documentId: input.documentId,
						sourceNodeId: input.sourceNodeId,
						sourceHash,
						offset,
						texts,
					});
					if (!ownerRef.current.isCurrent(ticket, input.documentId)) {
						throw new DOMException("Aborted", "AbortError");
					}
					const batch = await embed({
						requestId,
						documentId: input.documentId,
						sourceNodeId: input.sourceNodeId,
						sourceHash,
						inputs: texts,
						platform: "web",
						traceContent: true,
					});
					if (!ownerRef.current.isCurrent(ticket, input.documentId)) {
						throw new DOMException("Aborted", "AbortError");
					}
					vectors.push(...batch);
				}
				ownerRef.current.finish(ticket);
				return vectors;
			} finally {
				input.signal?.removeEventListener("abort", onAbort);
			}
		},
		[embed],
	);

	const reindexDocument = useCallback(
		async (input: {
			documentId: Id<"documents">;
			currentNodeId: string;
			markdown: string;
			signal?: AbortSignal;
		}): Promise<number> => {
			throwIfAborted(input.signal);
			const chunks = chunksForIndex(input.markdown);
			if (chunks.length === 0) {
				await replaceChunks({
					documentId: input.documentId,
					embeddedNodeId: input.currentNodeId,
					expectedMarkdown: input.markdown,
					chunks: [],
				});
				return 0;
			}
			const embeddings = await embedTexts({
				purpose: "reindex",
				documentId: input.documentId,
				sourceNodeId: input.currentNodeId,
				sourceMarkdown: input.markdown,
				texts: chunks.map((entry) => entry.text),
				signal: input.signal,
			});
			if (embeddings.length !== chunks.length) {
				throw new Error("Embedding count did not match chunk count");
			}
			await replaceChunks({
				documentId: input.documentId,
				embeddedNodeId: input.currentNodeId,
				expectedMarkdown: input.markdown,
				chunks: chunks.map((entry, index) => ({
					...entry,
					embedding: embeddings[index] ?? [],
				})),
			});
			return chunks.length;
		},
		[embedTexts, replaceChunks],
	);

	const findRelated = useCallback(
		async (input: {
			documentId: Id<"documents"> | null;
			sourceNodeId: string | null;
			sourceMarkdown: string;
			queryText: string;
			signal?: AbortSignal;
		}): Promise<RelatedPassage[]> => {
			throwIfAborted(input.signal);
			const queryText = input.queryText.trim();
			if (!queryText) return [];
			if (!input.documentId || !input.sourceNodeId) {
				throw new Error("No active document");
			}
			const [vector] = await embedTexts({
				purpose: "query",
				documentId: input.documentId,
				sourceNodeId: input.sourceNodeId,
				sourceMarkdown: input.sourceMarkdown,
				texts: [queryText.slice(0, 4_000)],
				signal: input.signal,
			});
			if (!vector) return [];
			return await searchByVector({
				vector,
				excludeDocumentId: input.documentId,
			});
		},
		[embedTexts, searchByVector],
	);

	return { reindexDocument, findRelated };
}
