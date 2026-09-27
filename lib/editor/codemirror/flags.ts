import type { Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	MatchDecorator,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

import type { FlagEditing } from "@/lib/editor/flags";
import {
	findFlags,
	flagInsertion,
	flagToken,
	removeFlag,
} from "@/lib/markdown/flags";

// Raw and Vim show the source, so a flag stays readable text, tinted so it
// stands out from the prose around it.
const flagDecorator = new MatchDecorator({
	regexp: /⁠?<!--flag(?::[^\n]*?)?-->/g,
	decoration: Decoration.mark({ class: "recto-flag-token" }),
});

export function flagHighlight(): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = flagDecorator.createDeco(view);
			}
			update(update: ViewUpdate) {
				this.decorations = flagDecorator.updateDeco(update, this.decorations);
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}

/** `FlagEditing` over a CodeMirror view: the document is the Markdown. */
export function codeMirrorFlagEditing(
	getView: () => EditorView | null,
): FlagEditing {
	const flagAt = (view: EditorView, index: number) =>
		findFlags(view.state.doc.toString())[index];

	return {
		caretAnchor() {
			const view = getView();
			if (!view) return null;
			const at = view.state.selection.main.to;
			const box = view.coordsAtPos(at);
			if (!box) return null;
			return {
				at,
				rect: new DOMRect(box.left, box.top, 1, box.bottom - box.top),
			};
		},
		insertAt(at, note) {
			const view = getView();
			if (!view || at > view.state.doc.length) return null;
			const insert = flagInsertion(view.state.doc.toString(), at, note);
			view.dispatch({
				changes: { from: at, insert },
				selection: { anchor: at + insert.length },
				scrollIntoView: true,
			});
			view.focus();
			return findFlags(view.state.doc.toString()).findIndex(
				(flag) => flag.to === at + insert.length,
			);
		},
		setNote(index, note) {
			const view = getView();
			if (!view) return;
			const flag = flagAt(view, index);
			if (!flag) return;
			view.dispatch({
				changes: { from: flag.tokenFrom, to: flag.to, insert: flagToken(note) },
			});
		},
		remove(index) {
			const view = getView();
			if (!view) return;
			const doc = view.state.doc.toString();
			const flag = findFlags(doc)[index];
			if (!flag) return;
			// `removeFlag` decides how much goes (guard, one space); apply that span.
			const removed = doc.length - removeFlag(doc, flag).length;
			view.dispatch({ changes: { from: flag.from, to: flag.from + removed } });
		},
		goTo(index) {
			const view = getView();
			if (!view) return;
			const flag = flagAt(view, index);
			if (!flag) return;
			view.dispatch({ selection: { anchor: flag.to }, scrollIntoView: true });
			view.focus();
		},
		rect(index) {
			const view = getView();
			if (!view) return null;
			const flag = flagAt(view, index);
			if (!flag) return null;
			const start = view.coordsAtPos(flag.tokenFrom);
			const end = view.coordsAtPos(flag.to);
			if (!start || !end) return null;
			return new DOMRect(
				start.left,
				start.top,
				Math.max(1, end.right - start.left),
				start.bottom - start.top,
			);
		},
	};
}
