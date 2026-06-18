import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { LintIssue } from "@/lib/lint";

/** Push a fresh set of prose-lint issues into the running CodeMirror view. */
export const setLintIssues = StateEffect.define<LintIssue[]>();

/**
 * Display-only squiggle decorations for the source surfaces (raw + vim). CM's
 * document string IS the canonical Markdown, so issue offsets map 1:1 onto
 * positions — this field just turns `{from,to}` into marks. Decorations re-map
 * through edits (`deco.map(tr.changes)`) so highlights stay aligned until the
 * next debounced re-analyze lands; they never participate in the edit itself.
 */
const lintField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(setLintIssues)) {
				const docLen = tr.state.doc.length;
				const marks = effect.value
					.filter((i) => i.from < i.to && i.to <= docLen)
					.sort((a, b) => a.from - b.from)
					.map((i) =>
						Decoration.mark({
							class: `recto-lint recto-lint--${i.category}`,
							attributes: { title: i.message },
						}).range(i.from, i.to),
					);
				deco = Decoration.set(marks, true);
			}
		}
		return deco;
	},
	provide: (f) => EditorView.decorations.from(f),
});

/** The prose-lint decoration extension for CodeMirror. */
export function lintExtension(): Extension {
	return lintField;
}
