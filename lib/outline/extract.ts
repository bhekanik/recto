import type { PhrasingContent, Root } from "mdast";
import { visit } from "unist-util-visit";

import { isFlagHtml } from "@/lib/markdown/flags";
import { parseMarkdown } from "@/lib/markdown/parse";

export type OutlineHeading = {
	/** Heading level 1–6. */
	depth: number;
	/** Plain text of the heading (markdown syntax stripped). */
	text: string;
	/** Character offset of the heading start in the parsed source. */
	offset: number;
	/** 0-based index in document order (aligns with rendered DOM order). */
	index: number;
};

/**
 * Flatten phrasing content to plain text — recurses into children, reads `value`.
 * Inlined from `lib/markdown/derive-title.ts` (not exported there; keep blast
 * radius minimal).
 */
function phrasingToText(nodes: PhrasingContent[]): string {
	return nodes
		.map((node) => {
			// A writing flag is a note to the writer, not heading text.
			if (node.type === "html" && isFlagHtml(node.value)) return "";
			if ("value" in node && typeof node.value === "string") {
				return node.value;
			}
			if ("children" in node && Array.isArray(node.children)) {
				return phrasingToText(node.children as PhrasingContent[]);
			}
			return "";
		})
		.join("");
}

/** Extract a flat, in-document-order outline of headings from markdown. */
export function extractOutline(markdown: string): OutlineHeading[] {
	return extractOutlineFromMdast(parseMarkdown(markdown));
}

export function extractOutlineFromMdast(root: Root): OutlineHeading[] {
	const out: OutlineHeading[] = [];
	visit(root, "heading", (node) => {
		// Keep empty-text headings (with text: "") so the index still aligns with
		// the rendered DOM order; the panel/palette show a placeholder for them.
		const text = phrasingToText(node.children).trim();
		out.push({
			depth: node.depth,
			text,
			offset: node.position?.start.offset ?? 0,
			index: out.length,
		});
	});
	return out;
}
