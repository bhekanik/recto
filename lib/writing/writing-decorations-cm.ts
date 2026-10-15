import {
	type Extension,
	StateEffect,
	type StateEffectType,
	StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { WritingMark } from "./marks";

/** Push the passages to draw into the running CodeMirror view. */
export const setWritingMarks = StateEffect.define<WritingMark[]>();
/** The Lab's cuts and findings: a layer of their own, pushed by the shell. */
export const setLabMarks = StateEffect.define<WritingMark[]>();

/**
 * Ghosts and alternatives on the source surfaces (raw + vim), where offsets are
 * positions. Display only: marks re-map through edits until the next push.
 */
function markField(effectType: StateEffectType<WritingMark[]>) {
	return StateField.define<DecorationSet>({
		create: () => Decoration.none,
		update(deco, tr) {
			deco = deco.map(tr.changes);
			for (const effect of tr.effects) {
				if (!effect.is(effectType)) continue;
				const length = tr.state.doc.length;
				deco = Decoration.set(
					effect.value
						.filter((mark) => mark.from < mark.to && mark.to <= length)
						.map((mark) =>
							Decoration.mark({
								class: `recto-writing-${mark.kind}`,
								...(mark.index === undefined
									? {}
									: { attributes: { "data-lab-cut": String(mark.index) } }),
							}).range(mark.from, mark.to),
						),
					true,
				);
			}
			return deco;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

export function writingMarksExtension(): Extension {
	return [markField(setWritingMarks), markField(setLabMarks)];
}
