"use client";

import { TooltipProvider } from "@milkdown/plugin-tooltip";
import type { EditorState, PluginView } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { createRoot, type Root } from "react-dom/client";

import { SelectionToolbar } from "@/components/selection-toolbar";

/**
 * Milkdown plugin view: a floating formatting bar above a non-empty selection.
 * Uses Milkdown's TooltipProvider (floating-ui) for positioning + the default
 * "show on non-empty text selection while focused" predicate.
 */
export class SelectionToolbarView implements PluginView {
	readonly #content: HTMLElement;
	readonly #root: Root;
	readonly #provider: TooltipProvider;

	constructor(view: EditorView) {
		this.#content = document.createElement("div");
		this.#content.className = "recto-selection-toolbar";

		this.#root = createRoot(this.#content);
		this.#root.render(<SelectionToolbar />);

		this.#provider = new TooltipProvider({
			content: this.#content,
			debounce: 30,
			offset: 8,
		});
		this.#provider.update(view);
	}

	update(view: EditorView, prevState?: EditorState): void {
		this.#provider.update(view, prevState);
	}

	destroy(): void {
		this.#provider.destroy();
		this.#root.unmount();
		this.#content.remove();
	}
}
