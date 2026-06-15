"use client";

import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	rootCtx,
} from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { slashFactory } from "@milkdown/plugin-slash";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { getMarkdown, replaceAll } from "@milkdown/utils";
import { forwardRef, useImperativeHandle, useRef } from "react";

import { BRIDGE_META } from "@/lib/bridge/protocol";
import type { EditorHandle } from "@/lib/editor/handle";
import { normalizeMarkdown } from "@/lib/markdown";
import { exportCaretFromCm, importCaretToCm } from "@/lib/modes/caret";
import type { CaretPosition } from "@/lib/modes/types";
import { SlashMenuView } from "./slash-menu-view";

export type MilkdownEditorHandle = EditorHandle;

const rectoSlash = slashFactory("RECTO_SLASH");

type InnerProps = {
	onChange?: () => void;
};

const MilkdownEditorInner = forwardRef<MilkdownEditorHandle, InnerProps>(
	function MilkdownEditorInner({ onChange }, ref) {
		const editorRef = useRef<Editor | null>(null);
		const rootRef = useRef<HTMLElement | null>(null);
		const onChangeRef = useRef(onChange);
		const programmaticRef = useRef(false);

		onChangeRef.current = onChange;

		useEditor((root) => {
			rootRef.current = root;
			const editor = Editor.make()
				.config((ctx) => {
					ctx.set(rootCtx, root);
					ctx.set(defaultValueCtx, "");
					ctx.set(rectoSlash.key, {
						view: (view) =>
							new SlashMenuView(view, (entry) => {
								const created = editorRef.current;
								if (!created) return;
								programmaticRef.current = true;
								entry.run(created.ctx);
								programmaticRef.current = false;
								onChangeRef.current?.();
							}),
					});
				})
				.use(commonmark)
				.use(gfm)
				.use(rectoSlash)
				.use(listener)
				.config((ctx) => {
					ctx.get(listenerCtx).markdownUpdated((_ctx, md, prevMd) => {
						if (programmaticRef.current) return;
						if (md !== prevMd) onChangeRef.current?.();
					});
				});

			editor.create().then((created) => {
				editorRef.current = created;
			});

			return editor;
		}, []);

		useImperativeHandle(ref, () => ({
			seed(markdown: string, opts?: { programmatic?: boolean }) {
				const editor = editorRef.current;
				if (!editor) return;
				const normalized = normalizeMarkdown(markdown);
				// Skip redundant replaceAll — it would reset the selection/cursor.
				const current = normalizeMarkdown(editor.action(getMarkdown()));
				if (current === normalized) return;
				if (opts?.programmatic) programmaticRef.current = true;
				editor.action(replaceAll(normalized, false));
				if (opts?.programmatic) programmaticRef.current = false;
			},
			getCanonicalMarkdown() {
				const editor = editorRef.current;
				if (!editor) return "";
				const md = editor.action(getMarkdown());
				return normalizeMarkdown(md);
			},
			exportCaret(): CaretPosition {
				const editor = editorRef.current;
				if (!editor) return { offset: 0, anchor: 0, head: 0 };
				try {
					const view = editor.ctx.get(editorViewCtx);
					const { anchor, head } = view.state.selection;
					return exportCaretFromCm(anchor, head);
				} catch {
					return { offset: 0, anchor: 0, head: 0 };
				}
			},
			importCaret(caret: CaretPosition) {
				const editor = editorRef.current;
				if (!editor) return;
				try {
					const view = editor.ctx.get(editorViewCtx);
					const { anchor, head } = importCaretToCm(
						view.state.doc.content.size,
						caret,
					);
					const tr = view.state.tr.setSelection(
						TextSelection.create(view.state.doc, anchor, head),
					);
					tr.setMeta(BRIDGE_META, true);
					tr.setMeta("addToHistory", false);
					view.dispatch(tr);
				} catch {
					// best-effort caret restore
				}
			},
			isFocused() {
				const editor = editorRef.current;
				if (!editor) return false;
				try {
					const view = editor.ctx.get(editorViewCtx);
					return view.hasFocus();
				} catch {
					return false;
				}
			},
			getRootElement() {
				return rootRef.current;
			},
			focus() {
				const editor = editorRef.current;
				if (!editor) return;
				try {
					editor.ctx.get(editorViewCtx).focus();
				} catch {
					// editor still mounting
				}
			},
		}));

		return <Milkdown />;
	},
);

type MilkdownEditorProps = {
	onChange?: () => void;
	className?: string;
};

export const MilkdownEditor = forwardRef<
	MilkdownEditorHandle,
	MilkdownEditorProps
>(function MilkdownEditor({ onChange, className }, ref) {
	return (
		<MilkdownProvider>
			<div className={className}>
				<MilkdownEditorInner ref={ref} onChange={onChange} />
			</div>
		</MilkdownProvider>
	);
});
