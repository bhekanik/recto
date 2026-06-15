import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { CANONICAL_STRINGIFY } from "./stringify-options.ts";

const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkFrontmatter)
	.use(remarkStringify, CANONICAL_STRINGIFY);

/** Parse canonical Markdown into remark MDAST. */
export function parseMarkdown(markdown: string): Root {
	return processor.parse(markdown) as Root;
}

/** Serialize remark MDAST to canonical Markdown bytes. */
export function stringifyMdast(mdast: Root): string {
	return processor.stringify(mdast);
}

/** Round-trip through the canonical pipeline. */
export function normalizeMarkdown(markdown: string): string {
	return stringifyMdast(parseMarkdown(markdown));
}
