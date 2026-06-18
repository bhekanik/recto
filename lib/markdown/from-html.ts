import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { normalizeMarkdown } from "./normalize";
import { CANONICAL_STRINGIFY } from "./stringify-options";

// Mirror lib/preview/render.ts: keep <br>, drop everything dangerous/styling
// (scripts, inline styles, mso-* junk). rehype-sanitize strips disallowed tags
// and attributes — including the `style` attributes Word/Docs paste carries.
const sanitizeSchema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames ?? []), "br"],
};

// rehype-parse (HTML → hast) → sanitize → rehype-remark (hast → mdast) →
// remark-gfm (so tables / strikethrough / task-lists survive) → remark-stringify
// with the frozen CANONICAL_STRINGIFY. The output dialect is identical to the
// rest of Recto by construction, so it round-trips through the corpus guard.
const htmlToMarkdownProcessor = unified()
	.use(rehypeParse, { fragment: true })
	.use(rehypeSanitize, sanitizeSchema)
	.use(rehypeRemark)
	.use(remarkGfm)
	.use(remarkStringify, CANONICAL_STRINGIFY);

/**
 * Convert clipboard `text/html` into canonical Markdown. The output uses the
 * same dialect as the rest of Recto (CANONICAL_STRINGIFY) and is run through
 * normalizeMarkdown so it is guaranteed round-trip-stable before it ever
 * reaches an editor surface.
 *
 * Note: smart quotes / NBSP / em-dashes are carried through as literal UTF-8
 * content — Recto's canonical Markdown keeps them as-is (they are valid body
 * text and already round-trip in the corpus). This is intentionally NOT an
 * ASCII transliterator.
 *
 * Scope: text/html only. Binary clipboard items (images, files) are handled
 * elsewhere by the editor paste handlers, which only call this for rich text.
 */
export function markdownFromHtml(html: string): string {
	const out = String(htmlToMarkdownProcessor.processSync(html));
	// Defensive: editors normalize on insert anyway, but converging here keeps
	// the function's contract "canonical Markdown" true in isolation.
	return normalizeMarkdown(out);
}
