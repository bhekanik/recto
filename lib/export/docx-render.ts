import type { Root as MdastRoot } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { stripFlagsFromMdast } from "../markdown/flags";
import { splitFrontmatter } from "../markdown/frontmatter";

/**
 * The `.docx` renderer, shared by the browser (`lib/export/docx.ts`) and the
 * Convex Node action (`convex/export.ts`) so a Word file downloaded from the
 * web and one produced for a native client are byte-for-byte the same document
 * (plan 023 §4.1(6)).
 *
 * Nothing here may touch `window`, `document`, `Blob`, toasts or React: the
 * Convex bundler pulls this file into a server bundle. Relative imports only —
 * the `@/` alias is a Next/vitest concern the Convex bundler does not resolve.
 */

export const DOCX_MIME_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Origin used when a document's own links/images are root-relative. */
export const DEFAULT_EXPORT_ORIGIN = "https://recto.app";

/** Drop the leading YAML frontmatter node — it is metadata, not body. */
function stripFrontmatter() {
	return (tree: MdastRoot) => {
		tree.children = tree.children.filter((node) => node.type !== "yaml");
	};
}

function absolutize(url: string, origin: string): string {
	try {
		return new URL(url, origin).href;
	} catch {
		return url;
	}
}

/**
 * v1 image posture: remark-docx only embeds images via its fetch-based image
 * plugin, which drops any image that fails to load (e.g. CORS on storage
 * URLs). Instead of embedding, rewrite each image into a hyperlink carrying
 * the alt text and the absolute URL, so the pointer survives into Word
 * (plan 020 scope; blueprint 11 §10 records the limitation).
 */
function imagesToLinks(origin: string) {
	return (tree: MdastRoot) => {
		visit(tree, "image", (node, index, parent) => {
			if (parent === undefined || index === undefined) return;
			const url = absolutize(node.url, origin);
			parent.children[index] = {
				type: "link",
				url,
				children: [{ type: "text", value: node.alt?.trim() || url }],
			};
		});
	};
}

/** Resolve root-relative link hrefs to absolute https URLs (pitfall 2.1.4). */
function absolutizeLinkUrls(origin: string) {
	return (tree: MdastRoot) => {
		visit(tree, "link", (node) => {
			if (node.url.startsWith("#")) return; // in-document anchor
			node.url = absolutize(node.url, origin);
		});
	};
}

/**
 * Compile canonical Markdown to `.docx` bytes — real OOXML (footnotes, GFM
 * table alignment, task lists) straight from the MDAST, no HTML round-trip.
 * remark-docx is dynamically imported so it stays out of the web's main bundle.
 *
 * `fallbackTitle` is used only when the document's frontmatter carries no
 * title; frontmatter wins because it is what the writer typed.
 */
export async function renderDocx(
	markdown: string,
	fallbackTitle: string,
	origin: string = DEFAULT_EXPORT_ORIGIN,
): Promise<ArrayBuffer> {
	const { default: remarkDocx } = await import("remark-docx");
	const { meta } = splitFrontmatter(markdown);
	const docTitle = meta.title.trim() || fallbackTitle;
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkFrontmatter, ["yaml"])
		.use(stripFrontmatter)
		// remark-docx prints raw HTML as text; a writing flag is not prose.
		.use(() => stripFlagsFromMdast)
		.use(() => imagesToLinks(origin))
		.use(() => absolutizeLinkUrls(origin))
		// The dialect's `---` is a horizontal rule, not a page break.
		.use(remarkDocx, { title: docTitle, thematicBreak: "line" });
	const file = await processor.process(markdown);
	return await file.result;
}
