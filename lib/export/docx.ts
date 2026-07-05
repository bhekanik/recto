import type { Root as MdastRoot } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { splitFrontmatter } from "@/lib/markdown";
import { toast } from "@/lib/ui/toast";
import type { ExportSource } from "./clipboard";
import { safeFilename, triggerDownload } from "./file";

export const DOCX_MIME_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
 * Compile canonical Markdown to a .docx Blob — real OOXML (footnotes, GFM
 * table alignment, task lists) straight from the MDAST, no HTML round-trip.
 * remark-docx is dynamically imported so it stays out of the main bundle.
 */
export async function generateDocxBlob(
	markdown: string,
	title: string,
): Promise<Blob> {
	const { default: remarkDocx } = await import("remark-docx");
	const origin = appOrigin();
	const { meta } = splitFrontmatter(markdown);
	const docTitle = meta.title.trim() || title;
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkFrontmatter, ["yaml"])
		.use(stripFrontmatter)
		.use(() => imagesToLinks(origin))
		.use(() => absolutizeLinkUrls(origin))
		// The dialect's `---` is a horizontal rule, not a page break.
		.use(remarkDocx, { title: docTitle, thematicBreak: "line" });
	const file = await processor.process(markdown);
	const arrayBuffer = await file.result;
	return new Blob([arrayBuffer], { type: DOCX_MIME_TYPE });
}

/** Export as .docx — download + toast; never throws (matches clipboard posture). */
export async function exportDocxFile(source: ExportSource): Promise<void> {
	try {
		const blob = await generateDocxBlob(source.markdown, source.title);
		triggerDownload(blob, `${safeFilename(source.title)}.docx`);
		toast("Exported Word document", "success");
	} catch {
		toast("Couldn't export .docx", "error");
	}
}
