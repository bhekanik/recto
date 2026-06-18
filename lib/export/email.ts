import type { Element, Root as HastRoot } from "hast";
import type { Root as MdastRoot } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { parseMarkdown, splitFrontmatter } from "@/lib/markdown";

/**
 * The EMAIL render pipeline (plan 008) — a third sibling of the in-app preview
 * and the foreign-consumer export HTML (blueprint 11 §1.1). Like export HTML it
 * targets a foreign consumer (an email client) and absolutizes URLs, but unlike
 * it the styles are inlined ONTO each element, because email clients strip
 * `<style>` blocks and external CSS. This is preview/export-side output, NOT a
 * send path: there is no recipient, no "from", no transport (overview §8 / §5e).
 */

/** Origin against which root-relative URLs are absolutized (mirrors lib/export/html.ts). */
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

/** Resolve every root-relative href/src to an absolute https URL (blueprint 11 §5). */
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
 * Per-element inline styles — the same visual contract as EXPORT_STYLE in
 * lib/export/html.ts, expressed as inline `style=` strings so email clients
 * (which strip <style> and external CSS) still render them. Light, email-safe
 * colors: this is how the email looks in a client, not app chrome (dark-only
 * governs app chrome, overview §8). Literal hex matches the EXPORT_STYLE convention.
 */
const INLINE_STYLES: Record<string, string> = {
	h1: "line-height:1.25;margin:1.6em 0 0.5em;font-weight:600;font-size:1.8rem;",
	h2: "line-height:1.25;margin:1.6em 0 0.5em;font-weight:600;font-size:1.5rem;",
	h3: "line-height:1.25;margin:1.6em 0 0.5em;font-weight:600;font-size:1.3rem;",
	h4: "line-height:1.25;margin:1.6em 0 0.5em;font-weight:600;",
	h5: "line-height:1.25;margin:1.6em 0 0.5em;font-weight:600;",
	h6: "line-height:1.25;margin:1.6em 0 0.5em;font-weight:600;",
	p: "margin:0 0 1em;",
	ul: "margin:0 0 1em;",
	ol: "margin:0 0 1em;",
	blockquote:
		"margin:0 0 1em;border-left:3px solid #ccc;padding-left:1rem;color:#555;",
	pre: "margin:0 0 1em;background:#f6f6f6;padding:1rem;border-radius:6px;overflow-x:auto;",
	table: "margin:0 0 1em;border-collapse:collapse;width:100%;",
	a: "color:#0b5;text-decoration:underline;",
	code: 'font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:0.9em;background:#f3f3f3;padding:0.1em 0.35em;border-radius:3px;',
	th: "border:1px solid #ddd;padding:0.4em 0.6em;background:#f3f3f3;",
	td: "border:1px solid #ddd;padding:0.4em 0.6em;",
	img: "max-width:100%;",
	hr: "border:none;border-top:1px solid #ddd;margin:2rem 0;",
};

/** Inline `code` inside a `pre` should drop its own background/padding. */
const PRE_CODE_STYLE =
	'font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:0.9em;background:none;padding:0;';

/** Set an inline `style` on each element matching INLINE_STYLES. */
function inlineElementStyles() {
	return (tree: HastRoot) => {
		visit(tree, "element", (node: Element, _index, parent) => {
			const tag = node.tagName;
			let style = INLINE_STYLES[tag];
			if (
				tag === "code" &&
				parent &&
				"tagName" in parent &&
				(parent as Element).tagName === "pre"
			) {
				style = PRE_CODE_STYLE;
			}
			if (!style) return;
			node.properties = node.properties ?? {};
			const existing = node.properties.style;
			node.properties.style =
				typeof existing === "string" && existing.length > 0
					? `${existing};${style}`
					: style;
		});
	};
}

function buildEmailProcessor() {
	return unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkFrontmatter, ["yaml"])
		.use(stripFrontmatter)
		.use(remarkRehype, { allowDangerousHtml: false })
		.use(() => absolutizeUrls(appOrigin()))
		.use(inlineElementStyles)
		.use(rehypeStringify);
}

/** Email-safe HTML body (inline styles, absolute URLs) from canonical markdown. */
export function generateEmailHtml(markdown: string): string {
	return buildEmailProcessor().processSync(markdown).toString();
}

/** Plain-text snippet from the body's text nodes — used as the preview fallback. */
function bodySnippet(body: string, maxChars = 140): string {
	const texts: string[] = [];
	visit(parseMarkdown(body), "text", (node) => {
		texts.push(node.value);
	});
	const text = texts.join(" ").replace(/\s+/g, " ").trim();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars).trimEnd()}…`;
}

export type EmailInboxModel = {
	/** meta.subject || meta.title || fallbackTitle. */
	subject: string;
	/** meta.preview || a derived first-line snippet of the body. */
	preview: string;
	/** Email-safe HTML of the body (inline styles, absolute URLs). */
	bodyHtml: string;
};

/**
 * Inbox-preview model: what an inbox row + opened email would show. Falls back
 * sensibly: subject → title → fallbackTitle; preview → first prose snippet of
 * the body when empty. This is a PREVIEW — no sender address, no recipient.
 */
export function emailInboxModel(
	markdown: string,
	fallbackTitle: string,
): EmailInboxModel {
	const { meta, body } = splitFrontmatter(markdown);
	const subject = meta.subject.trim() || meta.title.trim() || fallbackTitle;
	const preview = meta.preview.trim() || bodySnippet(body);
	return { subject, preview, bodyHtml: generateEmailHtml(markdown) };
}
