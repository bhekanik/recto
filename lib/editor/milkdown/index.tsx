"use client";

import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	parserCtx,
	rootCtx,
} from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { slashFactory } from "@milkdown/plugin-slash";
import { tooltipFactory } from "@milkdown/plugin-tooltip";
import {
	commonmark,
	createCodeBlockCommand,
	toggleEmphasisCommand,
	toggleInlineCodeCommand,
	toggleLinkCommand,
	toggleStrongCommand,
	turnIntoTextCommand,
	wrapInBlockquoteCommand,
	wrapInBulletListCommand,
	wrapInHeadingCommand,
	wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { gfm, toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import type { Parser } from "@milkdown/transformer";
import { callCommand, getMarkdown, replaceAll } from "@milkdown/utils";
import type { EditorView as PMEditorView } from "prosemirror-view";
import { forwardRef, useImperativeHandle, useRef } from "react";

import type { BridgeSession } from "@/lib/bridge/coordinator";

import { BRIDGE_META } from "@/lib/bridge/protocol";
import type { FormatCommand } from "@/lib/editor/format";
import type { EditorHandle } from "@/lib/editor/handle";
import {
	composeFrontmatter,
	type DocumentMeta,
	EMPTY_META,
	normalizeMarkdown,
	splitFrontmatter,
} from "@/lib/markdown";
import { exportCaretFromCm, importCaretToCm } from "@/lib/modes/caret";
import type { CaretPosition } from "@/lib/modes/types";
import { SelectionToolbarView } from "./selection-toolbar-view";
import { SlashMenuView } from "./slash-menu-view";

export type MilkdownEditorHandle = EditorHandle & {
	getPmView: () => PMEditorView | null;
	getParser: () => Parser | null;
	/** Update the title/subtitle frontmatter from the document header inputs. */
	setMeta: (meta: DocumentMeta) => void;
};

const rectoSlash = slashFactory("RECTO_SLASH");
const rectoSelectionTooltip = tooltipFactory("RECTO_SELECTION");

type InnerProps = {
	onChange?: () => void;
	bridgeSession?: BridgeSession | null;
	onMeta?: (meta: DocumentMeta) => void;
};

const MilkdownEditorInner = forwardRef<MilkdownEditorHandle, InnerProps>(
	function MilkdownEditorInner({ onChange, bridgeSession, onMeta }, ref) {
		const editorRef = useRef<Editor | null>(null);
		const rootRef = useRef<HTMLElement | null>(null);
		const onChangeRef = useRef(onChange);
		const bridgeSessionRef = useRef(bridgeSession);
		const programmaticRef = useRef(false);
		const parserRef = useRef<Parser | null>(null);
		// Milkdown renders BODY only; the YAML frontmatter (title/subtitle + any
		// unknown keys) is held here and re-attached on getCanonicalMarkdown so the
		// handle contract still speaks full canonical Markdown.
		const metaRef = useRef<DocumentMeta>({ ...EMPTY_META });
		const extraRef = useRef<Record<string, unknown>>({});
		const onMetaRef = useRef(onMeta);

		onChangeRef.current = onChange;
		bridgeSessionRef.current = bridgeSession;
		onMetaRef.current = onMeta;

		useEditor((root) => {
			rootRef.current = root;
			const editor = Editor.make()
				.config((ctx) => {
					ctx.set(rootCtx, root);
					ctx.set(defaultValueCtx, "");
					parserRef.current = ctx.get(parserCtx);
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
					ctx.set(rectoSelectionTooltip.key, {
						view: (view) => new SelectionToolbarView(view),
					});
				})
				.use(commonmark)
				.use(gfm)
				.use(rectoSlash)
				.use(rectoSelectionTooltip)
				.use(listener)
				.config((ctx) => {
					ctx.get(listenerCtx).markdownUpdated((_ctx, md, prevMd) => {
						if (programmaticRef.current) return;
						if (md !== prevMd) {
							// The bus carries full canonical (body + this pane's frontmatter).
							bridgeSessionRef.current?.handleRichUpdate(
								composeFrontmatter(metaRef.current, md, extraRef.current),
							);
							onChangeRef.current?.();
						}
					});
				});

			editor.create().then((created) => {
				editorRef.current = created;
			});

			return editor;
		}, []);

		useImperativeHandle(ref, () => ({
			seed(markdown: string, opts?: { programmatic?: boolean }) {
				// Peel off frontmatter: ProseMirror only renders the body; the header
				// inputs reflect title/subtitle via onMeta.
				const { meta, extra, body } = splitFrontmatter(markdown);
				metaRef.current = meta;
				extraRef.current = extra;
				onMetaRef.current?.(meta);

				const editor = editorRef.current;
				if (!editor) return;
				const normalized = normalizeMarkdown(body);
				// Skip redundant replaceAll — it would reset the selection/cursor.
				const current = normalizeMarkdown(editor.action(getMarkdown()));
				if (current === normalized) return;
				if (opts?.programmatic) programmaticRef.current = true;
				editor.action(replaceAll(normalized, false));
				if (opts?.programmatic) programmaticRef.current = false;
			},
			getCanonicalMarkdown() {
				const editor = editorRef.current;
				const body = editor ? editor.action(getMarkdown()) : "";
				return composeFrontmatter(metaRef.current, body, extraRef.current);
			},
			setMeta(meta: DocumentMeta) {
				metaRef.current = meta;
				// Body is unchanged; nudge sync + the live bus to pick up new canonical.
				onChangeRef.current?.();
				const editor = editorRef.current;
				if (editor) {
					bridgeSessionRef.current?.handleRichUpdate(
						composeFrontmatter(
							meta,
							editor.action(getMarkdown()),
							extraRef.current,
						),
					);
				}
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
			runFormat(command: FormatCommand, opts?: { href?: string }) {
				const editor = editorRef.current;
				if (!editor) return;
				try {
					// Keep edits flowing to sync — formatting is a real user edit, so
					// we do NOT mark it programmatic (that would suppress handleRichUpdate).
					switch (command) {
						case "bold":
							editor.action(callCommand(toggleStrongCommand.key));
							break;
						case "italic":
							editor.action(callCommand(toggleEmphasisCommand.key));
							break;
						case "strike":
							editor.action(callCommand(toggleStrikethroughCommand.key));
							break;
						case "code":
							editor.action(callCommand(toggleInlineCodeCommand.key));
							break;
						case "link": {
							const href =
								opts?.href ?? window.prompt("Link URL", "https://") ?? "";
							if (!href) break;
							editor.action(callCommand(toggleLinkCommand.key, { href }));
							break;
						}
						case "h1":
							editor.action(callCommand(wrapInHeadingCommand.key, 1));
							break;
						case "h2":
							editor.action(callCommand(wrapInHeadingCommand.key, 2));
							break;
						case "h3":
							editor.action(callCommand(wrapInHeadingCommand.key, 3));
							break;
						case "paragraph":
							editor.action(callCommand(turnIntoTextCommand.key));
							break;
						case "quote":
							editor.action(callCommand(wrapInBlockquoteCommand.key));
							break;
						case "bulletList":
							editor.action(callCommand(wrapInBulletListCommand.key));
							break;
						case "orderedList":
							editor.action(callCommand(wrapInOrderedListCommand.key));
							break;
						case "codeBlock":
							editor.action(callCommand(createCodeBlockCommand.key));
							break;
					}
					editor.ctx.get(editorViewCtx).focus();
				} catch {
					// editor still mounting / command unavailable — ignore
				}
			},
			getPmView() {
				const editor = editorRef.current;
				if (!editor) return null;
				try {
					return editor.ctx.get(editorViewCtx);
				} catch {
					return null;
				}
			},
			getParser() {
				return parserRef.current;
			},
		}));

		return <Milkdown />;
	},
);

type MilkdownEditorProps = {
	onChange?: () => void;
	className?: string;
	bridgeSession?: BridgeSession | null;
	onMeta?: (meta: DocumentMeta) => void;
};

export const MilkdownEditor = forwardRef<
	MilkdownEditorHandle,
	MilkdownEditorProps
>(function MilkdownEditor({ onChange, className, bridgeSession, onMeta }, ref) {
	return (
		<MilkdownProvider>
			<div className={className}>
				<MilkdownEditorInner
					ref={ref}
					onChange={onChange}
					bridgeSession={bridgeSession}
					onMeta={onMeta}
				/>
			</div>
		</MilkdownProvider>
	);
});
