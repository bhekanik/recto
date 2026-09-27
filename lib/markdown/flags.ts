import type { Root } from "mdast";
import { visit } from "unist-util-visit";

import { parseMarkdown } from "./parse";

/**
 * Writing flags: a placeholder the writer drops mid-sentence for a missing
 * name, date or fact, with a note about what's needed. A flag lives in the
 * text as an HTML comment, `<!--flag: her maiden name-->`, so it moves with
 * the words around it, needs no server state, and stays invisible anywhere
 * the Markdown is rendered (preview, HTML, Word, other Markdown tools).
 *
 * The Mac app mirrors this file in `apple/RectoApp/Sources/Flags.swift`; the
 * cases in `flags.test.ts` are the contract for both.
 */

export const FLAG_OPEN = "<!--flag";
export const FLAG_CLOSE = "-->";

/**
 * U+2060 WORD JOINER, written before a flag that would otherwise begin a line.
 * A line starting `<!--` opens a CommonMark HTML block, which would swallow
 * the rest of the line (and can interrupt a paragraph); an invisible,
 * non-breaking character in front keeps the flag inline.
 */
export const FLAG_GUARD = "⁠";

/** A flag in the source. `from`/`to` include a leading guard when present. */
export type Flag = {
	from: number;
	to: number;
	/** Where the comment itself starts (after any guard). */
	tokenFrom: number;
	note: string;
};

const FLAG_HTML = /^<!--flag(?::[ \t]*([^\n]*?))?[ \t]*-->$/;

/** True for an HTML node value that is exactly one flag. */
export function isFlagHtml(value: string): boolean {
	return FLAG_HTML.test(value);
}

/** The note in an HTML node value that is a flag, else null. */
export function flagNoteOf(value: string): string | null {
	const match = FLAG_HTML.exec(value);
	return match ? (match[1] ?? "").trim() : null;
}

/**
 * A note that fits inside the comment on one line: whitespace collapsed, and
 * `--` (which could close the comment early) turned into an en dash.
 */
export function cleanFlagNote(note: string): string {
	return note
		.replace(/\s+/g, " ")
		.trim()
		.replace(/-{2,}/g, "–")
		.replace(/-$/, "–");
}

/** The comment for a note: `<!--flag: note-->`, or `<!--flag-->` when empty. */
export function flagToken(note: string): string {
	const clean = cleanFlagNote(note);
	return clean
		? `${FLAG_OPEN}: ${clean}${FLAG_CLOSE}`
		: `${FLAG_OPEN}${FLAG_CLOSE}`;
}

/**
 * Whether a flag inserted at `at` would begin a line's content: only
 * indentation and block markers (`>`, `-`, `*`, `+`, `1.`, `1)`, `[ ]`)
 * before it on its line.
 */
export function needsFlagGuard(markdown: string, at: number): boolean {
	const lineStart = markdown.lastIndexOf("\n", at - 1) + 1;
	const before = markdown.slice(lineStart, at);
	return /^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*(?:\[[ xX]\][ \t]*)?$/.test(
		before,
	);
}

/** The text to insert for a new flag at `at`, guard included when needed. */
export function flagInsertion(markdown: string, at: number, note = ""): string {
	const token = flagToken(note);
	return needsFlagGuard(markdown, at) ? FLAG_GUARD + token : token;
}

/** Every flag in document order. Flags inside code are text, not flags. */
export function findFlags(markdown: string): Flag[] {
	return findFlagsInMdast(parseMarkdown(markdown), markdown);
}

export function findFlagsInMdast(root: Root, markdown: string): Flag[] {
	const flags: Flag[] = [];
	visit(root, "html", (node) => {
		const note = flagNoteOf(node.value);
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (note === null || start === undefined || end === undefined) return;
		const guarded = start > 0 && markdown[start - 1] === FLAG_GUARD;
		flags.push({
			from: guarded ? start - 1 : start,
			to: end,
			tokenFrom: start,
			note,
		});
	});
	return flags;
}

/**
 * Remove every flag (and its guard) from a parsed tree, for renderers that
 * would otherwise print an HTML comment as text.
 */
export function stripFlagsFromMdast(root: Root): void {
	visit(root, "html", (node, index, parent) => {
		if (!parent || index === undefined || !isFlagHtml(node.value)) return;
		const before = parent.children[index - 1];
		if (before?.type === "text" && before.value.endsWith(FLAG_GUARD)) {
			before.value = before.value.slice(0, -FLAG_GUARD.length);
		}
		parent.children.splice(index, 1);
		return index;
	});
}

/** `markdown` with `flag`'s note replaced. */
export function setFlagNote(
	markdown: string,
	flag: Flag,
	note: string,
): string {
	return (
		markdown.slice(0, flag.tokenFrom) +
		flagToken(note) +
		markdown.slice(flag.to)
	);
}

/**
 * `markdown` with `flag` (and its guard) removed. A flag between two spaces
 * takes one with it, so resolving `in ⚑ in` leaves `in in`, not a double space.
 */
export function removeFlag(markdown: string, flag: Flag): string {
	const spaced = markdown[flag.from - 1] === " " && markdown[flag.to] === " ";
	return (
		markdown.slice(0, flag.from) +
		markdown.slice(spaced ? flag.to + 1 : flag.to)
	);
}
