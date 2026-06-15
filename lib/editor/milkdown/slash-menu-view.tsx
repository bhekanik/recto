"use client";

import { SlashProvider } from "@milkdown/plugin-slash";
import {
	type PluginView,
	type Selection,
	TextSelection,
} from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SlashMenu } from "@/components/slash-menu";
import type { SlashEntry } from "./slash-entries";

type SlashMenuState = {
	open: boolean;
	filter: string;
};

function isSelectionAtEndOfNode(selection: Selection): boolean {
	if (!(selection instanceof TextSelection)) return false;
	const { $head } = selection;
	return $head.parentOffset === $head.parent.content.size;
}

function SlashMenuHost({
	state,
	subscribe,
	onSelect,
	onClose,
}: {
	state: SlashMenuState;
	subscribe: (onStoreChange: () => void) => () => void;
	onSelect: (entry: SlashEntry) => void;
	onClose: () => void;
}) {
	const snapshot = useSyncExternalStore(
		subscribe,
		() => state,
		() => state,
	);

	return (
		<SlashMenu
			open={snapshot.open}
			query={snapshot.filter ? `/${snapshot.filter}` : "/"}
			onSelect={onSelect}
			onClose={onClose}
		/>
	);
}

/** Milkdown slash plugin view — mounts React menu inside SlashProvider content. */
export class SlashMenuView implements PluginView {
	readonly #content: HTMLElement;
	readonly #root: Root;
	readonly #slashProvider: SlashProvider;
	readonly #state: SlashMenuState = { open: false, filter: "" };
	readonly #listeners = new Set<() => void>();
	#view: EditorView;
	readonly #onSelect: (entry: SlashEntry) => void;

	constructor(view: EditorView, onSelect: (entry: SlashEntry) => void) {
		this.#view = view;
		this.#onSelect = onSelect;
		this.#content = document.createElement("div");
		this.#content.className = "milkdown-slash-menu";

		let slashProvider!: SlashProvider;

		this.#root = createRoot(this.#content);
		this.#root.render(
			<SlashMenuHost
				state={this.#state}
				subscribe={(fn) => {
					this.#listeners.add(fn);
					return () => this.#listeners.delete(fn);
				}}
				onSelect={(entry) => {
					this.#onSelect(entry);
					slashProvider.hide();
				}}
				onClose={() => slashProvider.hide()}
			/>,
		);

		slashProvider = new SlashProvider({
			content: this.#content,
			debounce: 20,
			offset: 10,
			shouldShow(this: SlashProvider, editorView: EditorView) {
				const text = this.getContent(editorView, (node) =>
					["paragraph", "heading"].includes(node.type.name),
				);
				if (text == null) return false;
				if (!isSelectionAtEndOfNode(editorView.state.selection)) return false;
				return text.startsWith("/");
			},
		});

		this.#slashProvider = slashProvider;

		this.#slashProvider.onShow = () => {
			this.#syncFilter();
			this.#state.open = true;
			this.#emit();
		};
		this.#slashProvider.onHide = () => {
			this.#state.open = false;
			this.#state.filter = "";
			this.#emit();
		};

		this.update(view);
	}

	#syncFilter(): void {
		const text =
			this.#slashProvider.getContent(this.#view, (node) =>
				["paragraph", "heading"].includes(node.type.name),
			) ?? "";
		this.#state.filter = text.startsWith("/") ? text.slice(1) : "";
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}

	update(view: EditorView): void {
		this.#view = view;
		if (this.#state.open) {
			this.#syncFilter();
			this.#emit();
		}
		this.#slashProvider.update(view);
	}

	destroy(): void {
		this.#slashProvider.destroy();
		this.#root.unmount();
		this.#content.remove();
	}
}
