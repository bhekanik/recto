import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { parseMarkdown } from "@/lib/markdown/parse";

const sanitizeSchema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames ?? []), "br"],
};

const previewProcessor = unified()
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeSanitize, sanitizeSchema)
	.use(rehypeStringify);

/** Render canonical MDAST to sanitized HTML for preview mode. */
export function renderPreviewHtml(markdown: string): string {
	const tree = parseMarkdown(markdown);
	const hast = previewProcessor.runSync(tree);
	return previewProcessor.stringify(hast);
}
