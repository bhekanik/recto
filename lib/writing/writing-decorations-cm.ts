import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { WritingMark } from "./marks";

/** Push the passages to draw into the running CodeMirror view. */
export const setWritingMarks = StateEffect.define<WritingMark[]>();

/**
 * Ghosts and alternatives on the source surfaces (raw + vim), where offsets are
 * positions. Display only: marks re-map through edits until the next push.
 */
const writingField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for (const effect of tr.effects) {
			if (!effect.is(setWritingMarks)) continue;
			const length = tr.state.doc.length;
			deco = Decoration.set(
				effect.value
					.filter((mark) => mark.from < mark.to && mark.to <= length)
					.map((mark) =>
						Decoration.mark({ class: `recto-writing-${mark.kind}` }).range(
							mark.from,
							mark.to,
						),
					),
				true,
			);
		}
		return deco;
	},
	provide: (field) => EditorView.decorations.from(field),
});

export function writingMarksExtension(): Extension {
	return writingField;
}
