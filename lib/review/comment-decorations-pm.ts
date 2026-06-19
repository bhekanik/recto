import type { Node as PMNode } from "@milkdown/prose/model";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { dispatchOpenComment } from "@/lib/review/summon";

/**
 * A comment to highlight in the rich (ProseMirror) surface, located by SEARCHING
 * the document text for its quoted substring — PM positions are tree positions, not
 * source offsets, so a numeric offset would drift (exactly the technique in
 * lib/editor/milkdown/lint-plugin.ts). The quote is the comment anchor's stored
 * `quote`; orphaned comments (anchor lost) are simply omitted from this list.
 */
export type CommentMark = {
	commentId: string;
	quote: string;
	resolved: boolean;
};

export const commentPluginKey = new PluginKey<DecorationSet>("RECTO_COMMENTS");
/** Transaction meta key carrying a fresh `CommentMark[]` for the rich editor. */
export const setCommentMeta = "recto-set-comments";

type TextSegment = { text: string; pos: number };

/** Collect every text leaf with its absolute ProseMirror position. */
function collectSegments(doc: PMNode): TextSegment[] {
	const segments: TextSegment[] = [];
	doc.descendants((node, pos) => {
		if (node.isText && node.text) segments.push({ text: node.text, pos });
		return true;
	});
	return segments;
}

/**
 * Locate `needle` within the document text at or after the global cursor offset
 * (mirror of lint-plugin.ts findSpan). Returns the matching PM range and the global
 * offset just past the match. Searches a single segment only; spans straddling a
 * text-leaf boundary are treated as unmatched. Returns null when not found.
 */
function findSpan(
	segments: TextSegment[],
	needle: string,
	fromGlobal: number,
): { pmFrom: number; pmTo: number; nextGlobal: number } | null {
	let global = 0;
	for (const seg of segments) {
		const segEnd = global + seg.text.length;
		if (segEnd > fromGlobal) {
			const localStart = Math.max(0, fromGlobal - global);
			const k = seg.text.indexOf(needle, localStart);
			if (k !== -1) {
				return {
					pmFrom: seg.pos + k,
					pmTo: seg.pos + k + needle.length,
					nextGlobal: global + k + needle.length,
				};
			}
		}
		global = segEnd;
	}
	return null;
}

/**
 * Markdown syntax appears in the source quote but not in PM text leaves, so a quote
 * carrying it won't match verbatim; split it into clean prose fragments and decorate
 * the longest one (mirror of lint-plugin.ts cleanFragments).
 */
const MD_SYNTAX = /[#*_`~[\]()]|^\s*[-+>]\s|^\s*\d+\.\s/gm;

function cleanFragments(text: string): string[] {
	return text
		.split(MD_SYNTAX)
		.map((f) => f.trim())
		.filter((f) => f.length >= 4)
		.sort((a, b) => b.length - a.length);
}

/**
 * Build inline decorations by re-deriving each comment's range from its quote. A
 * cursor advances left-to-right so distinct comments with the same quote each get
 * their own mark. A quote that carries markdown syntax falls back to its longest
 * clean fragment; only quotes with no matchable fragment are dropped (they still
 * highlight in raw/vim, where offsets are exact).
 */
function buildDecorations(doc: PMNode, marks: CommentMark[]): DecorationSet {
	const segments = collectSegments(doc);
	if (segments.length === 0) return DecorationSet.empty;

	const decorations: Decoration[] = [];
	let cursor = 0;
	for (const mark of marks) {
		if (!mark.quote) continue;
		const candidates = [mark.quote, ...cleanFragments(mark.quote)];
		let span: ReturnType<typeof findSpan> = null;
		for (const candidate of candidates) {
			span = findSpan(segments, candidate, cursor);
			if (span) break;
		}
		if (!span) continue;
		cursor = span.nextGlobal;
		decorations.push(
			Decoration.inline(span.pmFrom, span.pmTo, {
				class: mark.resolved
					? "recto-comment-mark recto-comment-mark--resolved"
					: "recto-comment-mark",
				"data-comment-id": mark.commentId,
			}),
		);
	}
	if (decorations.length === 0) return DecorationSet.empty;
	return DecorationSet.create(doc, decorations);
}

/**
 * Display-only comment highlights for the rich (ProseMirror) surface. Holds a
 * DecorationSet in plugin state; a fresh `CommentMark[]` arrives via tr meta and
 * rebuilds it, otherwise the set re-maps through the transaction so highlights
 * survive edits. Never edits the document, history, or selection.
 */
export function commentPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: commentPluginKey,
		state: {
			init: () => DecorationSet.empty,
			apply(tr, old) {
				const marks = tr.getMeta(setCommentMeta) as CommentMark[] | undefined;
				if (marks) return buildDecorations(tr.doc, marks);
				return old.map(tr.mapping, tr.doc);
			},
		},
		props: {
			decorations(state) {
				return commentPluginKey.getState(state);
			},
			// Clicking a highlight opens that comment in the panel (editor→panel, the
			// reverse of jumpToComment). We resolve the nearest [data-comment-id]
			// ancestor of the click target and dispatch a window event; returning false
			// lets ProseMirror place the caret / handle selection as normal, so editing
			// is never blocked. A non-highlight click resolves nothing and is a no-op.
			handleClick(_view, _pos, event) {
				const target = event.target as HTMLElement | null;
				const el = target?.closest?.("[data-comment-id]");
				const commentId = el?.getAttribute("data-comment-id");
				if (commentId) dispatchOpenComment(commentId);
				return false;
			},
		},
	});
}
