"use client";

import { markdown } from "@codemirror/lang-markdown";
import {
	Compartment,
	EditorState,
	type Extension,
	Transaction,
} from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { bridgeOrigin } from "@/lib/bridge/protocol";
import type { EditorHandle } from "@/lib/editor/handle";
import { normalizeMarkdown } from "@/lib/markdown";
import { exportCaretFromCm, importCaretToCm } from "@/lib/modes/caret";
import type { CaretPosition, VimSubMode } from "@/lib/modes/types";

export type CodeMirrorEditorHandle = EditorHandle & {
	setVimEnabled: (enabled: boolean) => void;
};

type CodeMirrorEditorProps = {
	vimEnabled: boolean;
	onChange?: () => void;
	onVimModeChange?: (mode: VimSubMode) => void;
	className?: string;
};

function mapVimMode(mode: string): VimSubMode {
	if (mode === "insert") return "insert";
	if (mode.startsWith("visual")) return "visual";
	return "normal";
}

export const CodeMirrorEditor = forwardRef<
	CodeMirrorEditorHandle,
	CodeMirrorEditorProps
>(function CodeMirrorEditor(
	{ vimEnabled, onChange, onVimModeChange, className },
	ref,
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	const onVimModeChangeRef = useRef(onVimModeChange);
	const programmaticRef = useRef(false);
	const vimCompartmentRef = useRef(new Compartment());
	const vimEnabledRef = useRef(vimEnabled);
	vimEnabledRef.current = vimEnabled;

	onChangeRef.current = onChange;
	onVimModeChangeRef.current = onVimModeChange;

	useEffect(() => {
		if (!containerRef.current || viewRef.current) return;

		const vimExt = vimCompartmentRef.current.of(
			vimEnabledRef.current ? vim() : [],
		);

		const updateListener = EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			const programmatic = update.transactions.some((tr) =>
				tr.annotation(bridgeOrigin),
			);
			if (programmatic || programmaticRef.current) return;
			onChangeRef.current?.();
		});

		const extensions: Extension[] = [
			vimExt,
			drawSelection(),
			markdown(),
			updateListener,
			EditorView.lineWrapping,
			EditorState.tabSize.of(2),
		];

		const view = new EditorView({
			state: EditorState.create({ doc: "", extensions }),
			parent: containerRef.current,
		});
		viewRef.current = view;

		const vimHandler = (event: { mode: string }) => {
			onVimModeChangeRef.current?.(mapVimMode(event.mode));
		};
		const cm = getCM(view);
		cm?.on("vim-mode-change", vimHandler);

		return () => {
			cm?.off("vim-mode-change", vimHandler);
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({
			effects: vimCompartmentRef.current.reconfigure(vimEnabled ? vim() : []),
		});
		if (vimEnabled) {
			onVimModeChangeRef.current?.("normal");
		}
	}, [vimEnabled]);

	useImperativeHandle(ref, () => ({
		seed(markdownText: string, opts?: { programmatic?: boolean }) {
			const view = viewRef.current;
			if (!view) return;
			const normalized = normalizeMarkdown(markdownText);
			const current = view.state.doc.toString();
			if (current === normalized) return;

			programmaticRef.current = true;
			view.dispatch({
				changes: {
					from: 0,
					to: view.state.doc.length,
					insert: normalized,
				},
				annotations: opts?.programmatic
					? [bridgeOrigin.of(1), Transaction.addToHistory.of(false)]
					: [bridgeOrigin.of(1)],
			});
			programmaticRef.current = false;
		},
		getCanonicalMarkdown() {
			const view = viewRef.current;
			if (!view) return "";
			return normalizeMarkdown(view.state.doc.toString());
		},
		exportCaret() {
			const view = viewRef.current;
			if (!view) return { offset: 0, anchor: 0, head: 0 };
			const { anchor, head } = view.state.selection.main;
			return exportCaretFromCm(anchor, head);
		},
		importCaret(caret: CaretPosition) {
			const view = viewRef.current;
			if (!view) return;
			const { anchor, head } = importCaretToCm(view.state.doc.length, caret);
			view.dispatch({
				selection: { anchor, head },
				annotations: [bridgeOrigin.of(1), Transaction.addToHistory.of(false)],
			});
		},
		isFocused() {
			return viewRef.current?.hasFocus ?? false;
		},
		getRootElement() {
			return containerRef.current;
		},
		focus() {
			// Focus only; Vim stays in normal mode (its expected entry state).
			viewRef.current?.focus();
		},
		setVimEnabled(enabled: boolean) {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: vimCompartmentRef.current.reconfigure(enabled ? vim() : []),
			});
		},
	}));

	return <div ref={containerRef} className={className} />;
});
