import type { PhrasingContent, Root } from "mdast";
import { visit } from "unist-util-visit";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { parseMarkdown } from "@/lib/markdown/parse";

function phrasingToText(nodes: PhrasingContent[]): string {
	return nodes
		.map((node) => {
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

/**
 * Default document title: the frontmatter `title` when set, else the first
 * heading in the body.
 */
export function deriveTitleFromMarkdown(markdown: string): string {
	const { meta, body } = splitFrontmatter(markdown);
	if (meta.title.trim()) return meta.title.trim();
	return deriveTitleFromMdast(parseMarkdown(body));
}

/** Derive default title from MDAST root. */
export function deriveTitleFromMdast(root: Root): string {
	let title = "";
	visit(root, "heading", (node) => {
		if (title.length > 0) return;
		title = phrasingToText(node.children).trim();
	});
	if (title.length > 0) return title;

	visit(root, "paragraph", (node) => {
		if (title.length > 0) return;
		title = phrasingToText(node.children).trim();
	});
	return title.length > 0 ? title : "Untitled";
}
