import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkFrontmatter, ["yaml"]);

/** Parse canonical Markdown into remark MDAST. */
export function parseMarkdown(markdown: string): Root {
	return parser.parse(markdown) as Root;
}
