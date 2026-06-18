import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/**
 * A located comment highlight in the CURRENT canonical Markdown — offsets are
 * resolved by `locateAnchor` (lib/review/anchor.ts) against the live editor text
 * before being pushed here. Orphaned comments (anchor lost) carry no range and so
 * are simply absent from this list.
 */
export type CommentHighlight = {
	commentId: string;
	from: number;
	to: number;
	resolved: boolean;
};

/** Push a fresh set of comment highlights into the running CodeMirror view. */
export const setCommentHighlights = StateEffect.define<CommentHighlight[]>();

/**
 * Display-only comment highlights for the source surfaces (raw + vim). CM's
 * document string IS the canonical Markdown, so anchor offsets map 1:1 onto
 * positions — this field just turns `{from,to}` into marks (mirror of the prose-lint
 * `lint-extension.ts`). Decorations re-map through edits (`deco.map(tr.changes)`) so
 * highlights stay aligned until the next debounced re-locate lands; they never
 * participate in the edit itself. The colour is a distinct OKLCH token from the
 * lint squiggles (see `.recto-comment-mark` in globals.css).
 */
const commentField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setCommentHighlights)) {
				const docLen = tr.state.doc.length;
				const marks = effect.value
					.filter((h) => h.from < h.to && h.to <= docLen)
					.sort((a, b) => a.from - b.from)
					.map((h) =>
						Decoration.mark({
							class: h.resolved
								? "recto-comment-mark recto-comment-mark--resolved"
								: "recto-comment-mark",
							attributes: { "data-comment-id": h.commentId },
						}).range(h.from, h.to),
					);
				deco = Decoration.set(marks, true);
			}
		}
		return deco;
	},
	provide: (f) => EditorView.decorations.from(f),
});

/** The comment-highlight decoration extension for CodeMirror. */
export function commentHighlightExtension(): Extension {
	return commentField;
}
