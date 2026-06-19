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
 * Chat model for transforms + critique. GLM 5.2 on OpenRouter (user-selected,
 * verified end-to-end). It is a reasoning model, so the route handlers pass the
 * OpenRouter `reasoning: { enabled: false }` extension to keep short edits snappy
 * and stop reasoning tokens from starving the output budget. Keep token caps
 * modest; transforms are short edits, not long generations.
 */
export const AI_CHAT_MODEL = "z-ai/glm-5.2";

/** Cap output for selection transforms — they rewrite a span, not a document. */
export const AI_TRANSFORM_MAX_TOKENS = 1024;

/** Cap output for the critique pass — a short structured list, not an essay. */
export const AI_CRITIQUE_MAX_TOKENS = 1500;

/**
 * Cap output for the AI review pass — a structured list of anchored comments +
 * edits, not an essay. Larger than critique because each item carries a verbatim
 * quote + body (plan 011).
 */
export const AI_REVIEW_MAX_TOKENS = 4000;

/**
 * Embedding model + dimension for Phase C RAG. The `vectorIndex.dimensions` in
 * `convex/schema.ts` MUST equal `AI_EMBEDDING_DIM` exactly — changing the model
 * means a new index + a full re-embed. Verified on OpenRouter
 * (`openai/text-embedding-3-small` → 1536-dim).
 */
export const AI_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const AI_EMBEDDING_DIM = 1536;
