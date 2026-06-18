import type { Node as PMNode } from "@milkdown/prose/model";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { LintIssue } from "@/lib/lint";

export const lintPluginKey = new PluginKey<DecorationSet>("RECTO_LINT");
/** Transaction meta key carrying a fresh `LintIssue[]` for the rich editor. */
export const setLintMeta = "recto-set-lint";

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
 * Locate `needle` within the document text at or after the global cursor offset.
 * Returns the matching segment, the local index within it, and the global offset
 * just past the match (so the next search resumes after it — duplicate spans each
 * get their own decoration). Searches across a single segment only; spans that
 * straddle a text-leaf boundary (rare for word/sentence-level issues) are
 * treated as unmatched. Returns null when not found.
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
 * Markdown syntax (emphasis markers, headings, list/quote markers, links) appears
 * in the source but not in PM text leaves, so a span carrying it won't match
 * verbatim. We split such a span into its clean prose fragments and decorate the
 * longest one — recovering most readability sentences (which often contain a stray
 * `**` or a leading `- `) instead of dropping them. Word-level spans (passive /
 * adverb / weasel) are single clean words and match verbatim.
 */
const MD_SYNTAX = /[#*_`~[\]()]|^\s*[-+>]\s|^\s*\d+\.\s/gm;

/** Clean prose fragments of a source span (markdown syntax stripped, ≥4 chars). */
function cleanFragments(text: string): string[] {
	return text
		.split(MD_SYNTAX)
		.map((f) => f.trim())
		.filter((f) => f.length >= 4)
		.sort((a, b) => b.length - a.length);
}

/**
 * Build inline decorations by re-deriving each issue's range from its text. PM
 * positions are tree positions, not source offsets, so a numeric offset would
 * drift. We search the document text for each issue's exact substring, advancing a
 * cursor so left-to-right order and duplicate spans are honored. A span that
 * carries markdown syntax falls back to its longest clean fragment so rich-mode
 * readability highlights survive; only spans with no matchable fragment are
 * dropped (they still highlight exactly in raw/vim, where offsets are exact).
 */
function buildDecorations(doc: PMNode, issues: LintIssue[]): DecorationSet {
	const segments = collectSegments(doc);
	if (segments.length === 0) return DecorationSet.empty;

	const ordered = [...issues].sort((a, b) => a.from - b.from || a.to - b.to);
	const decorations: Decoration[] = [];
	let cursor = 0;
	for (const issue of ordered) {
		if (!issue.text) continue;
		// Try the verbatim span first; if it carries markdown syntax, fall back to
		// its longest clean prose fragment.
		const candidates = [issue.text, ...cleanFragments(issue.text)];
		let span: ReturnType<typeof findSpan> = null;
		for (const candidate of candidates) {
			span = findSpan(segments, candidate, cursor);
			if (span) break;
		}
		if (!span) continue;
		cursor = span.nextGlobal;
		decorations.push(
			Decoration.inline(span.pmFrom, span.pmTo, {
				class: `recto-lint recto-lint--${issue.category}`,
				title: issue.message,
			}),
		);
	}
	if (decorations.length === 0) return DecorationSet.empty;
	return DecorationSet.create(doc, decorations);
}

/**
 * Display-only prose-lint decorations for the rich (ProseMirror) surface. Holds a
 * DecorationSet in plugin state; a fresh `LintIssue[]` arrives via tr meta and
 * rebuilds it, otherwise the set re-maps through the transaction so highlights
 * survive edits. Never edits the document, history, or selection.
 */
export function lintPlugin(): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key: lintPluginKey,
		state: {
			init: () => DecorationSet.empty,
			apply(tr, old) {
				const issues = tr.getMeta(setLintMeta) as LintIssue[] | undefined;
				if (issues) return buildDecorations(tr.doc, issues);
				return old.map(tr.mapping, tr.doc);
			},
		},
		props: {
			decorations(state) {
				return lintPluginKey.getState(state);
			},
		},
	});
}
