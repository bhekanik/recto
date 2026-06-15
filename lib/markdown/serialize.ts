import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { CANONICAL_STRINGIFY } from "./stringify-options";

const serializer = unified()
	.use(remarkStringify, CANONICAL_STRINGIFY)
	.use(remarkGfm)
	.use(remarkFrontmatter, ["yaml"]);

/** Serialize remark MDAST to canonical Markdown bytes. */
export function stringifyMdast(mdast: Root): string {
	return serializer.stringify(mdast);
}
