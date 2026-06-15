import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { CANONICAL_STRINGIFY } from "./stringify-options";

const parseProcessor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkFrontmatter)
	.use(remarkStringify, CANONICAL_STRINGIFY);

function parseForCount(markdown: string): Root {
	return parseProcessor.parse(markdown) as Root;
}

/** Count prose words from MDAST text nodes (excludes syntax). */
export function countWordsFromMdast(mdast: Root): number {
	const texts: string[] = [];
	visit(mdast, "text", (node) => {
		texts.push(node.value);
	});
	return countWordsFromPlainText(texts.join(" "));
}

/** Count words from a Markdown string via the canonical pipeline. */
export function countWords(markdownOrMdast: string | Root): number {
	if (typeof markdownOrMdast === "string") {
		if (markdownOrMdast.trim() === "") return 0;
		return countWordsFromMdast(parseForCount(markdownOrMdast));
	}
	return countWordsFromMdast(markdownOrMdast);
}

/** Count words in plain text — collapses whitespace, ignores empty tokens. */
export function countWordsFromPlainText(text: string): number {
	const trimmed = text.trim();
	if (trimmed === "") return 0;
	return trimmed.split(/\s+/).filter(Boolean).length;
}
