import { parseMarkdown } from "@/lib/markdown/parse";
import { extractOutlineFromMdast } from "./extract";

/**
 * The Markdown of the section holding `offset`: from the nearest heading at or
 * before it to the next heading of the same or a higher level, so nested
 * subsections stay with their parent. Before the first heading it is the text
 * up to that heading, minus frontmatter. `offset` indexes the string passed in.
 */
export function sectionAtOffset(markdown: string, offset: number): string {
	const root = parseMarkdown(markdown);
	const first = root.children[0];
	const bodyStart =
		first?.type === "yaml" ? (first.position?.end.offset ?? 0) : 0;
	const headings = extractOutlineFromMdast(root);
	const current = headings.findLast((heading) => heading.offset <= offset);
	const next = current
		? headings.find(
				(heading) =>
					heading.offset > current.offset && heading.depth <= current.depth,
			)
		: headings[0];
	return markdown
		.slice(current?.offset ?? bodyStart, next?.offset ?? markdown.length)
		.trim();
}
