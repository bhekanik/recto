import type { Node as PMNode } from "@milkdown/prose/model";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import type { EditorView, NodeView } from "@milkdown/prose/view";

import {
	createFlagGlyph,
	FLAG_CLICK_EVENT,
	type FlagClickDetail,
	type FlagEditing,
	updateFlagGlyph,
} from "@/lib/editor/flags";
import {
	FLAG_GUARD,
	flagNoteOf,
	flagToken,
	isFlagHtml,
} from "@/lib/markdown/flags";

function noteOf(value: string): string {
	return flagNoteOf(value) ?? "";
}

function isFlagNode(node: PMNode): boolean {
	return node.type.name === "html" && isFlagHtml(String(node.attrs.value));
}

/** Positions of every flag node, in document order. */
export function flagPositions(doc: PMNode): number[] {
	const positions: number[] = [];
	doc.descendants((node, pos) => {
		if (isFlagNode(node)) positions.push(pos);
		return true;
	});
	return positions;
}

/**
 * Milkdown keeps inline HTML as an atom `html` node whose value is the raw
 * source. This view draws a flag's node as the flag glyph; every other HTML
 * node keeps the preset's plain rendering.
 */
class HtmlNodeView implements NodeView {
	dom: HTMLElement;

	constructor(
		private node: PMNode,
		view: EditorView,
		getPos: () => number | undefined,
	) {
		if (isFlagNode(node)) {
			this.dom = createFlagGlyph(noteOf(String(node.attrs.value)));
			this.dom.addEventListener("mousedown", (event) => {
				event.preventDefault();
				const pos = getPos();
				if (pos === undefined) return;
				const index = flagPositions(view.state.doc).indexOf(pos);
				if (index < 0) return;
				window.dispatchEvent(
					new CustomEvent<FlagClickDetail>(FLAG_CLICK_EVENT, {
						detail: { index },
					}),
				);
			});
		} else {
			const span = document.createElement("span");
			span.dataset.type = "html";
			span.dataset.value = String(node.attrs.value);
			span.textContent = String(node.attrs.value);
			this.dom = span;
		}
	}

	update(node: PMNode): boolean {
		if (
			node.type !== this.node.type ||
			isFlagNode(node) !== isFlagNode(this.node)
		) {
			return false;
		}
		if (!isFlagNode(node) && node.attrs.value !== this.node.attrs.value)
			return false;
		this.node = node;
		if (isFlagNode(node))
			updateFlagGlyph(this.dom, noteOf(String(node.attrs.value)));
		return true;
	}

	ignoreMutation(): boolean {
		return true;
	}
}

export function flagPlugin(): Plugin {
	return new Plugin({
		props: {
			nodeViews: {
				html: (node, view, getPos) => new HtmlNodeView(node, view, getPos),
			},
		},
	});
}

/** `FlagEditing` over a Milkdown view. */
export function milkdownFlagEditing(
	getView: () => EditorView | null,
): FlagEditing {
	const positionOf = (view: EditorView, index: number) =>
		flagPositions(view.state.doc)[index];

	return {
		caretAnchor() {
			const view = getView();
			if (!view) return null;
			const at = view.state.selection.to;
			const box = view.coordsAtPos(at);
			return {
				at,
				rect: new DOMRect(box.left, box.top, 1, box.bottom - box.top),
			};
		},
		insertAt(at, note) {
			const view = getView();
			if (!view) return null;
			const { state } = view;
			if (at > state.doc.content.size) return null;
			const $at = state.doc.resolve(at);
			if (!$at.parent.inlineContent) return null;
			const html = state.schema.nodes.html;
			if (!html) return null;
			// A flag that starts a line would begin an HTML block in Markdown.
			const before = $at.nodeBefore;
			const startsLine =
				$at.parentOffset === 0 || before?.type.name === "hardbreak";
			const flag = html.create({ value: flagToken(note) });
			const nodes = startsLine ? [state.schema.text(FLAG_GUARD), flag] : [flag];
			const tr = state.tr.insert(at, nodes);
			const after = at + nodes.reduce((size, node) => size + node.nodeSize, 0);
			tr.setSelection(TextSelection.create(tr.doc, after)).scrollIntoView();
			view.dispatch(tr);
			view.focus();
			return flagPositions(view.state.doc).indexOf(after - flag.nodeSize);
		},
		setNote(index, note) {
			const view = getView();
			if (!view) return;
			const pos = positionOf(view, index);
			if (pos === undefined) return;
			view.dispatch(
				view.state.tr.setNodeMarkup(pos, undefined, { value: flagToken(note) }),
			);
		},
		remove(index) {
			const view = getView();
			if (!view) return;
			const pos = positionOf(view, index);
			if (pos === undefined) return;
			const { doc } = view.state;
			let from = pos;
			let to = pos + (doc.nodeAt(pos)?.nodeSize ?? 1);
			if (doc.textBetween(from - 1, from, "", "") === FLAG_GUARD) from -= 1;
			// Between two spaces the flag takes one with it, as `removeFlag` does.
			if (
				doc.textBetween(from - 1, from, "", "") === " " &&
				doc.textBetween(to, to + 1, "", "") === " "
			) {
				to += 1;
			}
			view.dispatch(view.state.tr.delete(from, to));
		},
		goTo(index) {
			const view = getView();
			if (!view) return;
			const pos = positionOf(view, index);
			if (pos === undefined) return;
			const after = pos + (view.state.doc.nodeAt(pos)?.nodeSize ?? 1);
			view.dispatch(
				view.state.tr
					.setSelection(TextSelection.create(view.state.doc, after))
					.scrollIntoView(),
			);
			view.focus();
		},
		rect(index) {
			const view = getView();
			if (!view) return null;
			const pos = positionOf(view, index);
			if (pos === undefined) return null;
			const dom = view.nodeDOM(pos);
			return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
		},
	};
}
