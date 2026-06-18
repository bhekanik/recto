/**
 * Single source of truth for the AI provider wiring (plan 009, provider
 * override). The LLM is reached through OpenRouter's OpenAI-compatible API; the
 * key lives only on the server (`OPENROUTER_API_KEY`) and is read in the Next.js
 * route handlers, never shipped to the client.
 *
 * Model ids are kept here as single configurable constants so a model swap is a
 * one-line change. Verified against OpenRouter at build time of this feature.
 */

/** OpenRouter base URL for the OpenAI-compatible SDK. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Chat model for transforms + critique. A current Anthropic Claude Sonnet-class
 * id on OpenRouter (verified streaming end-to-end). Keep modest; transforms are
 * short edits, not long generations.
 */
export const AI_CHAT_MODEL = "anthropic/claude-sonnet-4.6";

/** Cap output for selection transforms — they rewrite a span, not a document. */
export const AI_TRANSFORM_MAX_TOKENS = 1024;

/** Cap output for the critique pass — a short structured list, not an essay. */
export const AI_CRITIQUE_MAX_TOKENS = 1500;

/**
 * Embedding model + dimension for Phase C RAG. The `vectorIndex.dimensions` in
 * `convex/schema.ts` MUST equal `AI_EMBEDDING_DIM` exactly — changing the model
 * means a new index + a full re-embed. Verified on OpenRouter
 * (`openai/text-embedding-3-small` → 1536-dim).
 */
export const AI_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const AI_EMBEDDING_DIM = 1536;
