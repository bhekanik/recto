import { dump, load } from "js-yaml";
import type { Root } from "mdast";

import { normalizeMarkdown } from "./normalize";
import { parseMarkdown } from "./parse";
import { stringifyMdast } from "./serialize";

/** The header/metadata fields Recto surfaces from YAML frontmatter. */
export type DocumentMeta = {
	title: string;
	subtitle: string;
	subject: string; // newsletter subject line (email "Subject:")
	preview: string; // newsletter preview / preheader text (inbox snippet)
};

export type SplitDocument = {
	meta: DocumentMeta;
	/** Frontmatter keys beyond title/subtitle/subject/preview — preserved on recompose. */
	extra: Record<string, unknown>;
	/** Canonical Markdown body with the frontmatter block removed. */
	body: string;
};

export const EMPTY_META: DocumentMeta = {
	title: "",
	subtitle: "",
	subject: "",
	preview: "",
};

function toStringField(
	value: unknown,
	activeArrays = new WeakSet<unknown[]>(),
): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) {
		if (activeArrays.has(value)) return "";
		activeArrays.add(value);
		try {
			return value.map((item) => toStringField(item, activeArrays)).join(",");
		} finally {
			activeArrays.delete(value);
		}
	}
	return String(value);
}

function parseYaml(value: string): Record<string, unknown> {
	try {
		const parsed = load(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Malformed YAML — treat as no usable frontmatter.
	}
	return {};
}

/**
 * Split canonical Markdown into its title/subtitle frontmatter and body.
 * Any frontmatter keys beyond title/subtitle are returned in `extra` so a later
 * compose() preserves them. Body is re-stringified canonically (sans block).
 */
export function splitFrontmatter(markdown: string): SplitDocument {
	const root = parseMarkdown(markdown);
	const [first, ...restNodes] = root.children;

	if (first?.type !== "yaml") {
		return { meta: { ...EMPTY_META }, extra: {}, body: markdown.trimStart() };
	}

	const parsed = parseYaml(first.value);
	const { title, subtitle, subject, preview, ...extra } = parsed;
	const meta: DocumentMeta = {
		title: toStringField(title),
		subtitle: toStringField(subtitle),
		subject: toStringField(subject),
		preview: toStringField(preview),
	};

	const bodyRoot: Root = { type: "root", children: restNodes };
	const body = restNodes.length ? stringifyMdast(bodyRoot).trim() : "";

	return { meta, extra, body };
}

/**
 * Recompose canonical Markdown from header meta + body. Emits no frontmatter
 * block at all when title/subtitle/subject/preview and extra are all empty (so
 * docs aren't littered with empty `---`). `extra` round-trips unknown keys.
 */
export function composeFrontmatter(
	meta: DocumentMeta,
	body: string,
	extra: Record<string, unknown> = {},
): string {
	const ordered: Record<string, unknown> = {};
	if (meta.title.trim()) ordered.title = meta.title;
	if (meta.subtitle.trim()) ordered.subtitle = meta.subtitle;
	if (meta.subject.trim()) ordered.subject = meta.subject;
	if (meta.preview.trim()) ordered.preview = meta.preview;
	for (const [key, value] of Object.entries(extra)) {
		if (!["title", "subtitle", "subject", "preview"].includes(key))
			ordered[key] = value;
	}

	const trimmedBody = body.trim();

	if (Object.keys(ordered).length === 0) {
		return trimmedBody ? `${trimmedBody}\n` : "";
	}

	const yaml = dump(ordered, { lineWidth: -1, noRefs: true }).trimEnd();
	const block = `---\n${yaml}\n---\n`;
	const composed = trimmedBody ? `${block}\n${trimmedBody}\n` : block;
	// Run through the canonical pipeline so the result matches everything else.
	return normalizeMarkdown(composed);
}
