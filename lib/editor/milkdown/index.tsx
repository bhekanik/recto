"use client";

import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	editorViewOptionsCtx,
	parserCtx,
	rootCtx,
	serializerCtx,
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
import {
	Plugin,
	PluginKey,
	type EditorState as PMEditorState,
	TextSelection,
} from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import type { Parser } from "@milkdown/transformer";
import { $prose, callCommand, getMarkdown, replaceAll } from "@milkdown/utils";
import type { EditorView as PMEditorView } from "prosemirror-view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { BridgeSession } from "@/lib/bridge/coordinator";

import { BRIDGE_META } from "@/lib/bridge/protocol";
import { activeFocusRange, type FocusScope } from "@/lib/editor/focus-range";
import type { FormatCommand } from "@/lib/editor/format";
import type { EditorHandle } from "@/lib/editor/handle";
import { isImageFile } from "@/lib/editor/image-upload";
import type { LintIssue } from "@/lib/lint";
import {
	composeFrontmatter,
	type DocumentMeta,
	EMPTY_META,
	markdownFromHtml,
	normalizeMarkdown,
	splitFrontmatter,
} from "@/lib/markdown";
import { exportCaretFromCm, importCaretToCm } from "@/lib/modes/caret";
import type { CaretPosition } from "@/lib/modes/types";
import {
	type CommentMark,
	commentPlugin,
	setCommentMeta,
} from "@/lib/review/comment-decorations-pm";
import { lintPlugin, setLintMeta } from "./lint-plugin";
import { SelectionToolbarView } from "./selection-toolbar-view";
import { SlashMenuView } from "./slash-menu-view";

export type MilkdownEditorHandle = EditorHandle & {
	getPmView: () => PMEditorView | null;
	getParser: () => Parser | null;
	/** Update the title/subtitle frontmatter from the document header inputs. */
	setMeta: (meta: DocumentMeta) => void;
	/** Push display-only prose-lint decorations (body-relative offsets, text re-search). */
	setLintIssues: (issues: LintIssue[]) => void;
	/** Push display-only comment highlights (located by quote text; plan 010 Phase B). */
	setCommentHighlights: (marks: CommentMark[]) => void;
};

const rectoSlash = slashFactory("RECTO_SLASH");
const rectoSelectionTooltip = tooltipFactory("RECTO_SELECTION");

const focusPluginKey = new PluginKey("recto-focus");

/**
 * Active-range decoration for rich mode. ProseMirror positions are NOT plain-text
 * offsets, so we compute the range within the single textblock containing the
 * caret: the block's text feeds {@link activeFocusRange}, and the resulting
 * text-relative `[from, to)` maps back to document positions by adding the block
 * content's start position. This keeps sentence ranges accurate inside a block
 * (and paragraph scope = the whole block) without a fragile doc-wide text map.
 */
function activeRichRange(
	state: PMEditorState,
	scope: FocusScope,
): { from: number; to: number } | null {
	const { $head } = state.selection;
	// The textblock (paragraph/heading/etc.) the caret sits in; depth 0 = doc.
	const depth = $head.depth;
	if (depth === 0) return null;
	const block = $head.parent;
	if (!block.isTextblock) return null;
	const blockText = block.textContent;
	if (blockText.trim().length === 0) return null;
	// Content start position of the block (just inside its opening token).
	const blockContentStart = $head.start(depth);
	const caretInBlock = $head.parentOffset;
	// Within one textblock there are no blank lines, so paragraph scope = the whole
	// block; sentence scope segments the block text.
	const range = activeFocusRange(blockText, caretInBlock, scope);
	if (!range) return null;
	return {
		from: blockContentStart + range.from,
		to: blockContentStart + range.to,
	};
}

/** Find the nearest vertically-scrollable ancestor of `el` (the editor host). */
function nearestScroller(el: HTMLElement | null): HTMLElement | null {
	let node = el?.parentElement ?? null;
	while (node) {
		const style = window.getComputedStyle(node);
		const oy = style.overflowY;
		if (
			(oy === "auto" || oy === "scroll" || oy === "overlay") &&
			node.scrollHeight > node.clientHeight
		) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

/**
 * Center the caret line in its scroll container (typewriter scrolling). Suppressed
 * by the caller when the selection is non-empty (the iA caveat — centering while
 * dragging a selection janks). Uses a DOM scroll, not a PM transaction.
 */
function centerCaret(view: PMEditorView): void {
	const head = view.state.selection.head;
	const scroller = nearestScroller(view.dom as HTMLElement);
	if (!scroller) return;
	let coords: { top: number; bottom: number };
	try {
		coords = view.coordsAtPos(head);
	} catch {
		return;
	}
	const caretMidY = (coords.top + coords.bottom) / 2;
	const rect = scroller.getBoundingClientRect();
	const viewportMidY = rect.top + rect.height / 2;
	scroller.scrollTop += caretMidY - viewportMidY;
}

/**
 * Upload an image, then insert a canonical inline `image` node (`![alt](src)`) at
 * `pos`. Mirrors the CodeMirror image path (plan 008): the upload is async, so it
 * reads the view back from the ref on resolve (the view may have unmounted or the
 * doc shifted) and clamps the position. `uploadImage` already toasts + rethrows on
 * failure, so a failed upload silently leaves the doc untouched. The image insert
 * is a normal user edit (no programmaticRef / BRIDGE_META), so the
 * markdownUpdated listener forwards it to sync automatically.
 */
function insertUploadedImage(
	getView: () => PMEditorView | null,
	uploader: (file: File | Blob) => Promise<{ url: string; alt: string }>,
	file: File | Blob,
	pos: number,
): void {
	void uploader(file)
		.then(({ url, alt }) => {
			const view = getView();
			if (!view) return;
			const imageType = view.state.schema.nodes.image;
			if (!imageType) return;
			const node = imageType.create({ src: url, alt });
			const at = Math.min(Math.max(0, pos), view.state.doc.content.size);
			const tr = view.state.tr.insert(at, node);
			view.dispatch(tr);
			view.focus();
		})
		.catch(() => {
			// uploadImage already surfaced a toast; nothing to insert.
		});
}

type InnerProps = {
	onChange?: () => void;
	bridgeSession?: BridgeSession | null;
	onMeta?: (meta: DocumentMeta) => void;
	typewriter?: boolean;
	focusDim?: boolean;
	focusDimScope?: FocusScope;
	/** Smart paste — convert pasted rich HTML into canonical Markdown (plan 007). */
	smartPaste?: boolean;
	/** Upload a pasted/dropped image and resolve to a servable URL + alt (plan 008). */
	onUploadImage?: (file: File | Blob) => Promise<{ url: string; alt: string }>;
};

const MilkdownEditorInner = forwardRef<MilkdownEditorHandle, InnerProps>(
	function MilkdownEditorInner(
		{
			onChange,
			bridgeSession,
			onMeta,
			typewriter = false,
			focusDim = false,
			focusDimScope = "sentence",
			smartPaste = true,
			onUploadImage,
		},
		ref,
	) {
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
		// The focus plugin is long-lived; it reads current settings through refs so
		// toggling typewriter/dim never rebuilds the ProseMirror editor.
		const typewriterRef = useRef(typewriter);
		const focusDimRef = useRef(focusDim);
		const focusScopeRef = useRef<FocusScope>(focusDimScope);
		// handlePaste reads the live setting via a ref so toggling smart-paste never
		// rebuilds the ProseMirror editor.
		const smartPasteRef = useRef(smartPaste);
		// handlePaste/handleDrop read the uploader via a ref so the long-lived
		// ProseMirror view never rebuilds when the (memoized) uploader changes.
		const onUploadImageRef = useRef(onUploadImage);
		// Resolve the live ProseMirror view on demand (async image upload may finish
		// after the handler returns); reads from editorRef so it survives the await.
		const getViewRef = useRef((): PMEditorView | null => {
			const editor = editorRef.current;
			if (!editor) return null;
			try {
				return editor.ctx.get(editorViewCtx);
			} catch {
				return null;
			}
		});

		onChangeRef.current = onChange;
		bridgeSessionRef.current = bridgeSession;
		onMetaRef.current = onMeta;
		typewriterRef.current = typewriter;
		focusDimRef.current = focusDim;
		focusScopeRef.current = focusDimScope;
		smartPasteRef.current = smartPaste;
		onUploadImageRef.current = onUploadImage;

		useEditor((root) => {
			rootRef.current = root;
			const editor = Editor.make()
				.config((ctx) => {
					ctx.set(rootCtx, root);
					ctx.set(defaultValueCtx, "");
					parserRef.current = ctx.get(parserCtx);
					// Smart paste: re-enter pasted rich HTML through the canonical
					// HTML→Markdown converter, then the Milkdown parser — NOT
					// ProseMirror's own clipboard DOM parser. That keeps the lossless
					// canonical invariant. Off (or no text/html) returns false and
					// Milkdown's default commonmark/gfm clipboard parse runs instead.
					// editorViewOptionsCtx takes Partial<Omit<DirectEditorProps,
					// "state">>, so handlePaste sits at the top level (it is an
					// EditorProps hook), not under an `editorProps` key.
					ctx.set(editorViewOptionsCtx, {
						handlePaste: (view, event) => {
							// Image branch (plan 008) — runs BEFORE the smart-paste text/html
							// path so a pasted image is never treated as text. An image item
							// in the clipboard uploads to Convex storage, then inserts a
							// canonical `image` node at the caret.
							const uploader = onUploadImageRef.current;
							const items = event.clipboardData?.items;
							const imageFile = items
								? [...items]
										.map((i) => (i.kind === "file" ? i.getAsFile() : null))
										.find((f): f is File => !!f && isImageFile(f))
								: undefined;
							if (imageFile && uploader) {
								event.preventDefault();
								insertUploadedImage(
									getViewRef.current,
									uploader,
									imageFile,
									view.state.selection.head,
								);
								return true;
							}
							if (!smartPasteRef.current) return false;
							const html = event.clipboardData?.getData("text/html");
							if (!html) return false; // no rich content — default paste
							const md = markdownFromHtml(html);
							if (!md.trim()) return false;
							const parser = parserRef.current;
							if (!parser) return false;
							const doc = parser(md);
							if (!doc) return false;
							// Insert the parsed slice at the current selection. This is a
							// normal user edit (no programmaticRef / BRIDGE_META), so the
							// markdownUpdated listener forwards it to sync automatically.
							const { from, to } = view.state.selection;
							const tr = view.state.tr.replaceWith(from, to, doc.content);
							view.dispatch(tr);
							return true;
						},
						handleDrop: (view, event) => {
							// Drag-dropped image (plan 008) → Convex storage, inserted at the
							// drop coordinates (falls back to the caret). Non-image drops fall
							// through to ProseMirror's default handling.
							const uploader = onUploadImageRef.current;
							const files = event.dataTransfer?.files;
							const file = files
								? [...files].find((f) => isImageFile(f))
								: undefined;
							if (!file || !uploader) return false;
							event.preventDefault();
							const dropPos = view.posAtCoords({
								left: event.clientX,
								top: event.clientY,
							});
							const pos = dropPos?.pos ?? view.state.selection.head;
							insertUploadedImage(getViewRef.current, uploader, file, pos);
							return true;
						},
					});
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
				.use(
					// Focus mode: dim-decoration + typewriter centering. One long-lived
					// plugin reads live settings via refs (Decision: no editor rebuild).
					$prose(
						() =>
							new Plugin({
								key: focusPluginKey,
								props: {
									attributes: (): { [name: string]: string } =>
										focusDimRef.current ? { class: "recto-focus-dim" } : {},
									decorations: (state) => {
										if (!focusDimRef.current) return DecorationSet.empty;
										const range = activeRichRange(state, focusScopeRef.current);
										if (!range || range.to <= range.from) {
											return DecorationSet.empty;
										}
										return DecorationSet.create(state.doc, [
											Decoration.inline(range.from, range.to, {
												class: "recto-focus-active",
											}),
										]);
									},
								},
								view: () => ({
									update: (v, prev) => {
										if (!typewriterRef.current) return;
										const sel = v.state.selection;
										// iA caveat: never recenter while a selection is being made.
										if (!sel.empty) return;
										const moved =
											!prev.selection.eq(sel) || !prev.doc.eq(v.state.doc);
										if (!moved) return;
										// Defer: scrolling synchronously inside update() can race
										// ProseMirror's own DOM write; rAF lets layout settle.
										requestAnimationFrame(() => centerCaret(v));
									},
								}),
							}),
					),
				)
				// Prose-lint decorations (plan 004) — a separate, display-only $prose
				// plugin alongside the focus one. Issues arrive via tr meta; it never
				// edits the document, history, or selection.
				.use($prose(() => lintPlugin()))
				// Comment highlights (plan 010 Phase B) — display-only $prose plugin;
				// marks arrive via tr meta and are located by searching for the quote.
				.use($prose(() => commentPlugin()))
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

		// Toggling focus settings doesn't itself dispatch a transaction, so the dim
		// decoration would only update on the next edit/caret move. Poke the view with
		// a no-op transaction so the new state applies immediately.
		// biome-ignore lint/correctness/useExhaustiveDependencies: editorRef is a stable ref; we intentionally re-poke only on focus-setting changes
		useEffect(() => {
			const editor = editorRef.current;
			if (!editor) return;
			try {
				const view = editor.ctx.get(editorViewCtx);
				view.dispatch(view.state.tr.setMeta(focusPluginKey, true));
				if (typewriter) requestAnimationFrame(() => centerCaret(view));
			} catch {
				// editor still mounting — the plugin reads live refs on its first render
			}
		}, [typewriter, focusDim, focusDimScope]);

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
			getSelectedMarkdown() {
				const editor = editorRef.current;
				if (!editor) return null;
				try {
					const view = editor.ctx.get(editorViewCtx);
					const { from, to } = view.state.selection;
					if (to <= from) return null;
					// getMarkdown serializes the sliced range with Milkdown's own
					// serializer — no ProseMirror-position → markdown-offset math.
					const md = editor.action(getMarkdown({ from, to }));
					const trimmed = md.trim();
					return trimmed.length > 0 ? trimmed : null;
				} catch {
					return null;
				}
			},
			replaceSelectionMarkdown(replacement: string) {
				const editor = editorRef.current;
				if (!editor) return null;
				try {
					const view = editor.ctx.get(editorViewCtx);
					const { from, to } = view.state.selection;
					if (to <= from) return null;
					const parser = editor.ctx.get(parserCtx);
					const serializer = editor.ctx.get(serializerCtx);
					// Parse the AI Markdown to a full doc node, then fit its content into
					// the selection range via a THROWAWAY transaction — the live editor is
					// never mutated here. replaceWith lets ProseMirror reconcile the slice
					// into the surrounding context (inline-into-inline, block-into-block).
					const parsed = parser(replacement);
					if (!parsed) return null;
					const tr = view.state.tr.replaceWith(from, to, parsed.content);
					// Serialize the resulting doc back to canonical body Markdown and
					// re-attach this pane's frontmatter so the handle contract still
					// speaks full canonical Markdown. The caller commits this once.
					const body = serializer(tr.doc);
					return composeFrontmatter(metaRef.current, body, extraRef.current);
				} catch {
					return null;
				}
			},
			setLintIssues(issues: LintIssue[]) {
				const editor = editorRef.current;
				if (!editor) return;
				try {
					const view = editor.ctx.get(editorViewCtx);
					view.dispatch(view.state.tr.setMeta(setLintMeta, issues));
				} catch {
					// editor still mounting — next push will land once the view exists
				}
			},
			setCommentHighlights(marks: CommentMark[]) {
				const editor = editorRef.current;
				if (!editor) return;
				try {
					const view = editor.ctx.get(editorViewCtx);
					view.dispatch(view.state.tr.setMeta(setCommentMeta, marks));
				} catch {
					// editor still mounting — next push will land once the view exists
				}
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
	typewriter?: boolean;
	focusDim?: boolean;
	focusDimScope?: FocusScope;
	/** Smart paste — convert pasted rich HTML into canonical Markdown (plan 007). */
	smartPaste?: boolean;
	/** Upload a pasted/dropped image and resolve to a servable URL + alt (plan 008). */
	onUploadImage?: (file: File | Blob) => Promise<{ url: string; alt: string }>;
};

export const MilkdownEditor = forwardRef<
	MilkdownEditorHandle,
	MilkdownEditorProps
>(function MilkdownEditor(
	{
		onChange,
		className,
		bridgeSession,
		onMeta,
		typewriter,
		focusDim,
		focusDimScope,
		smartPaste,
		onUploadImage,
	},
	ref,
) {
	return (
		<MilkdownProvider>
			<div className={className}>
				<MilkdownEditorInner
					ref={ref}
					onChange={onChange}
					bridgeSession={bridgeSession}
					onMeta={onMeta}
					typewriter={typewriter}
					focusDim={focusDim}
					focusDimScope={focusDimScope}
					smartPaste={smartPaste}
					onUploadImage={onUploadImage}
				/>
			</div>
		</MilkdownProvider>
	);
});
