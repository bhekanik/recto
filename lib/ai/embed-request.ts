/**
 * Pure builder for the embedding API request payload (plan 009, Phase C). Kept
 * separate from the network call so the request shape is unit-testable. The
 * OpenRouter embeddings endpoint is OpenAI-compatible: `{ model, input }`.
 */

import { AI_EMBEDDING_DIM, AI_EMBEDDING_MODEL } from "./config";

export type EmbedRequest = {
	model: string;
	input: string[];
};

/**
 * Build the embeddings request for a batch of chunk texts. Empty inputs are
 * filtered out (the API rejects empty strings); order is preserved for the
 * surviving entries so the caller can zip results back to chunks.
 */
export function buildEmbedRequest(inputs: string[]): EmbedRequest {
	const cleaned = inputs.map((s) => s.trim()).filter((s) => s.length > 0);
	return {
		model: AI_EMBEDDING_MODEL,
		input: cleaned,
	};
}

/** The configured embedding dimension — must match the Convex vectorIndex. */
export function embeddingDimensions(): number {
	return AI_EMBEDDING_DIM;
}
