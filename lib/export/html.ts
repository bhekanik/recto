import type { Element, Root as HastRoot } from "hast";
import type { Root as MdastRoot } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { type DocumentMeta, splitFrontmatter } from "@/lib/markdown";

/** Origin against which root-relative URLs are absolutized for export. */
function appOrigin(): string {
	return typeof window !== "undefined"
		? window.location.origin
		: "https://recto.app";
}

/** Drop the leading YAML frontmatter node — it is metadata, not body. */
function stripFrontmatter() {
	return (tree: MdastRoot) => {
		tree.children = tree.children.filter((node) => node.type !== "yaml");
	};
}

/** Resolve every root-relative href/src to an absolute https URL (pitfall 2.1.4). */
function absolutizeUrls(origin: string) {
	return (tree: HastRoot) => {
		visit(tree, "element", (node: Element) => {
			const props = node.properties;
			if (!props) return;
			for (const attr of ["href", "src"] as const) {
				const value = props[attr];
				if (typeof value === "string" && value.length > 0) {
					try {
						props[attr] = new URL(value, origin).href;
					} catch {
						// leave unresolvable values as-authored
					}
				}
			}
		});
	};
}

/**
 * The EXPORT html pipeline (blueprint 11 §6) — distinct from the in-app preview
 * pipeline. No rehype-sanitize: export targets foreign consumers (Word / Docs /
 * Pages) and the input is the user's own dialect-only document (single-user, D5).
 * Frontmatter is stripped; root-relative URLs are absolutized.
 */
function buildProcessor() {
	return unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkFrontmatter, ["yaml"])
		.use(stripFrontmatter)
		.use(remarkRehype, { allowDangerousHtml: false })
		.use(() => absolutizeUrls(appOrigin()))
		.use(rehypeStringify);
}

const EXPORT_STYLE = `
  :root { color-scheme: light; }
  body {
    font-family: "Source Serif 4", Georgia, "Times New Roman", serif;
    font-size: 17px; line-height: 1.65; color: #1a1a1a;
    max-width: 42rem; margin: 2.5rem auto; padding: 0 1.25rem;
  }
  h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 600; }
  h1 { font-size: 1.8rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.3rem; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  a { color: #0b5; text-decoration: underline; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
    background: #f3f3f3; padding: 0.1em 0.35em; border-radius: 3px; }
  pre { background: #f6f6f6; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; padding-left: 1rem; color: #555; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.4em 0.6em; }
  th { background: #f3f3f3; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
  .recto-subtitle { font-size: 1.2rem; color: #555; margin: -0.4em 0 0; }
  .recto-doc-header h1 { margin-top: 0; }
  .recto-doc-header hr { margin: 1.2rem 0 2rem; }
`;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function wrapSelfContainedHtml(body: string, title: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Rendered title/subtitle header (frontmatter is stripped from the body). */
function renderExportHeader(meta: DocumentMeta): string {
	const title = meta.title.trim();
	const subtitle = meta.subtitle.trim();
	if (!title && !subtitle) return "";
	const parts: string[] = ['<header class="recto-doc-header">'];
	if (title) parts.push(`<h1>${escapeHtml(title)}</h1>`);
	if (subtitle)
		parts.push(`<p class="recto-subtitle">${escapeHtml(subtitle)}</p>`);
	parts.push("<hr>", "</header>");
	return parts.join("\n");
}

/** Self-contained export HTML from canonical Markdown (shared by copy + .html export). */
export function generateExportHtml(markdown: string, title: string): string {
	const { meta } = splitFrontmatter(markdown);
	const header = renderExportHeader(meta);
	const body = buildProcessor().processSync(markdown).toString();
	const docTitle = meta.title.trim() || title;
	return wrapSelfContainedHtml(
		`${header}${header ? "\n" : ""}${body}`,
		docTitle,
	);
}
