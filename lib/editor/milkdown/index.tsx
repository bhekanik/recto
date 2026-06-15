"use client";

import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	rootCtx,
} from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { getMarkdown, replaceAll } from "@milkdown/utils";
import { forwardRef, useImperativeHandle, useRef } from "react";

import { normalizeMarkdown } from "@/lib/markdown";

export type MilkdownEditorHandle = {
	seed: (markdown: string) => void;
	getCanonicalMarkdown: () => string;
	isFocused: () => boolean;
	getRootElement: () => HTMLElement | null;
};

type InnerProps = {
	onChange?: () => void;
};

const MilkdownEditorInner = forwardRef<MilkdownEditorHandle, InnerProps>(
	function MilkdownEditorInner({ onChange }, ref) {
		const editorRef = useRef<Editor | null>(null);
		const rootRef = useRef<HTMLElement | null>(null);
		const onChangeRef = useRef(onChange);
		onChangeRef.current = onChange;

		useEditor((root) => {
			rootRef.current = root;
			const editor = Editor.make()
				.config((ctx) => {
					ctx.set(rootCtx, root);
					ctx.set(defaultValueCtx, "");
				})
				.use(commonmark)
				.use(gfm)
				.use(listener)
				.config((ctx) => {
					ctx.get(listenerCtx).markdownUpdated((_ctx, md, prevMd) => {
						if (md !== prevMd) onChangeRef.current?.();
					});
				});

			editor.create().then((created) => {
				editorRef.current = created;
			});

			return editor;
		}, []);

		useImperativeHandle(ref, () => ({
			seed(markdown: string) {
				const editor = editorRef.current;
				if (!editor) return;
				const normalized = normalizeMarkdown(markdown);
				editor.action(replaceAll(normalized, false));
			},
			getCanonicalMarkdown() {
				const editor = editorRef.current;
				if (!editor) return "";
				const md = editor.action(getMarkdown());
				return normalizeMarkdown(md);
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
