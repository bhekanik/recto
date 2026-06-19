"use client";

import { markdown } from "@codemirror/lang-markdown";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
	Compartment,
	EditorState,
	type Extension,
	Transaction,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	drawSelection,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { BridgeSession } from "@/lib/bridge/coordinator";
import { bridgeOrigin } from "@/lib/bridge/protocol";
import { activeFocusRange, type FocusScope } from "@/lib/editor/focus-range";
import type { FormatCommand } from "@/lib/editor/format";
import type { EditorHandle } from "@/lib/editor/handle";
import type { LintIssue } from "@/lib/lint";
import { markdownFromHtml, normalizeMarkdown } from "@/lib/markdown";
import { exportCaretFromCm, importCaretToCm } from "@/lib/modes/caret";
import type { CaretPosition, VimSubMode } from "@/lib/modes/types";
import {
	type CommentHighlight,
	commentHighlightExtension,
	setCommentHighlights,
} from "@/lib/review/comment-decorations-cm";
import { dispatchOpenComment } from "@/lib/review/summon";
import { lintExtension, setLintIssues } from "./lint-extension";

export type CodeMirrorEditorHandle = EditorHandle & {
	setVimEnabled: (enabled: boolean) => void;
	getCmView: () => EditorView | null;
	/** Push display-only prose-lint decorations (full-doc offsets). */
	setLintIssues: (issues: LintIssue[]) => void;
	/** Push display-only comment highlights (full-doc offsets; plan 010 Phase B). */
	setCommentHighlights: (highlights: CommentHighlight[]) => void;
	/** Open the find/replace panel (focuses the editor first). */
	openSearch: () => void;
};

type CodeMirrorEditorProps = {
	vimEnabled: boolean;
	onChange?: () => void;
	onVimModeChange?: (mode: VimSubMode) => void;
	className?: string;
	bridgeSession?: BridgeSession | null;
	/** Native browser spellcheck. CM force-sets false, so we override explicitly. */
	spellcheck?: boolean;
	/** Smart paste — convert pasted rich HTML into canonical Markdown (plan 007). */
	smartPaste?: boolean;
	/** Typewriter scrolling — keep the caret line vertically centered (plan 003). */
	typewriter?: boolean;
	/** Focus dimming — fade everything but the active sentence/paragraph. */
	focusDim?: boolean;
	/** Granularity of the focus-dim highlight. */
	focusDimScope?: FocusScope;
	/** Upload a pasted/dropped image and resolve to a servable URL + alt (plan 008). */
	onUploadImage?: (file: File | Blob) => Promise<{ url: string; alt: string }>;
};

function spellcheckAttrs(enabled: boolean): Extension {
	return EditorView.contentAttributes.of({ spellcheck: String(enabled) });
}

/** Decoration marking the active sentence/paragraph so CSS can keep it bright. */
const focusActiveMark = Decoration.mark({ class: "recto-focus-active" });

/**
 * Build the focus-mode extension for CodeMirror: a dim-decoration ViewPlugin
 * (recomputes the active range on doc/selection change) plus a typewriter
 * ViewPlugin (centers the caret on caret moves, suppressed during a non-empty
 * selection per the iA caveat). When `focusDim` is on the content gets the
 * `recto-focus-dim` class so the container dims and only the active mark stays
 * primary.
 */
function buildFocusExtension(
	typewriter: boolean,
	focusDim: boolean,
	scope: FocusScope,
): Extension {
	const computeDeco = (view: EditorView): DecorationSet => {
		if (!focusDim) return Decoration.none;
		const range = activeFocusRange(
			view.state.doc.toString(),
			view.state.selection.main.head,
			scope,
		);
		if (!range || range.to <= range.from) return Decoration.none;
		return Decoration.set([focusActiveMark.range(range.from, range.to)]);
	};

	const dimPlugin = ViewPlugin.fromClass(
		class {
			deco: DecorationSet;
			constructor(view: EditorView) {
				this.deco = computeDeco(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.selectionSet) {
					this.deco = computeDeco(u.view);
				}
			}
		},
		{ decorations: (v) => v.deco },
	);

	const typewriterPlugin = ViewPlugin.fromClass(
		class {
			update(u: ViewUpdate) {
				if (!typewriter) return;
				if (!(u.docChanged || u.selectionSet)) return;
				const sel = u.view.state.selection.main;
				// iA caveat: never recenter while a selection is being made/extended.
				if (!sel.empty) return;
				const head = sel.head;
				// Dispatching a scroll effect synchronously inside update() throws
				// ("calls get during an update") — defer to the next frame.
				requestAnimationFrame(() => {
					u.view.dispatch({
						effects: EditorView.scrollIntoView(head, { y: "center" }),
					});
				});
			}
		},
	);

	const containerClass = EditorView.editorAttributes.of({
		class: focusDim ? "recto-focus-dim" : "",
	});

	return [dimPlugin, typewriterPlugin, containerClass];
}

function mapVimMode(mode: string): VimSubMode {
	if (mode === "insert") return "insert";
	if (mode.startsWith("visual")) return "visual";
	return "normal";
}

// Strip any existing leading block marker so block formats toggle/replace cleanly.
const BLOCK_PREFIX = /^(\s*)(#{1,6} +|> +|[-*+] +|\d+\. +)?/;

/** Wrap the selection in inline Markdown markers (bold/italic/strike/code). */
function wrapInline(view: EditorView, marker: string): void {
	const { from, to } = view.state.selection.main;
	const selected = view.state.sliceDoc(from, to);
	view.dispatch({
		changes: { from, to, insert: `${marker}${selected}${marker}` },
		selection: selected
			? { anchor: from + marker.length, head: to + marker.length }
			: { anchor: from + marker.length },
	});
	view.focus();
}

/** Apply (or toggle off) a leading line marker across the selected lines. */
function setLinePrefix(view: EditorView, prefix: string | null): void {
	const { state } = view;
	const { from, to } = state.selection.main;
	const startLine = state.doc.lineAt(from).number;
	const endLine = state.doc.lineAt(to).number;
	const changes: { from: number; to: number; insert: string }[] = [];
	let ordinal = 1;
	for (let n = startLine; n <= endLine; n++) {
		const line = state.doc.line(n);
		const indent = /^\s*/.exec(line.text)?.[0] ?? "";
		const stripped = line.text.replace(BLOCK_PREFIX, "$1");
		let insert: string;
		if (prefix === null) {
			insert = stripped;
		} else {
			const marker = prefix === "1. " ? `${ordinal}. ` : prefix;
			// Toggle: if the line already starts with exactly this marker, remove it.
			insert =
				line.text.slice(indent.length).startsWith(marker.trimStart()) &&
				prefix !== "1. "
					? stripped
					: indent + marker + stripped.slice(indent.length);
		}
		changes.push({ from: line.from, to: line.to, insert });
		ordinal += 1;
	}
	view.dispatch({ changes });
	view.focus();
}

/** Apply a formatting command to a CodeMirror source surface via Markdown text. */
function applyCmFormat(
	view: EditorView,
	command: FormatCommand,
	opts?: { href?: string },
): void {
	switch (command) {
		case "bold":
			wrapInline(view, "**");
			return;
		case "italic":
			wrapInline(view, "*");
			return;
		case "strike":
			wrapInline(view, "~~");
			return;
		case "code":
			wrapInline(view, "`");
			return;
		case "link": {
			const { from, to } = view.state.selection.main;
			const text = view.state.sliceDoc(from, to) || "text";
			const href = opts?.href ?? window.prompt("Link URL", "https://") ?? "";
			if (!href) return;
			view.dispatch({
				changes: { from, to, insert: `[${text}](${href})` },
				selection: { anchor: from + 1, head: from + 1 + text.length },
			});
			view.focus();
			return;
		}
		case "h1":
			setLinePrefix(view, "# ");
			return;
		case "h2":
			setLinePrefix(view, "## ");
			return;
		case "h3":
			setLinePrefix(view, "### ");
			return;
		case "paragraph":
			setLinePrefix(view, null);
			return;
		case "quote":
			setLinePrefix(view, "> ");
			return;
		case "bulletList":
			setLinePrefix(view, "- ");
			return;
		case "orderedList":
			setLinePrefix(view, "1. ");
			return;
		case "codeBlock": {
			const { from, to } = view.state.selection.main;
			const selected = view.state.sliceDoc(from, to);
			view.dispatch({
				changes: { from, to, insert: `\`\`\`\n${selected}\n\`\`\`` },
				selection: { anchor: from + 4 },
			});
			view.focus();
			return;
		}
	}
}

/**
 * Upload an image, then insert a canonical `![alt](url)` reference at `pos`. The
 * upload is async, so it reads the view back from the ref on resolve (the view
 * may have unmounted or the doc shifted). `uploadImage` already toasts + rethrows
 * on failure, so a failed upload silently leaves the doc untouched.
 */
function insertUploadedImage(
	viewRef: { current: EditorView | null },
	uploader: (file: File | Blob) => Promise<{ url: string; alt: string }>,
	file: File | Blob,
	pos: number,
): void {
	void uploader(file)
		.then(({ url, alt }) => {
			const view = viewRef.current;
			if (!view) return;
			const insert = `![${alt}](${url})`;
			const at = Math.min(pos, view.state.doc.length);
			view.dispatch({
				changes: { from: at, insert },
				selection: { anchor: at + insert.length },
			});
			view.focus();
		})
		.catch(() => {
			// uploadImage already surfaced a toast; nothing to insert.
		});
}

type VimApi = {
	defineAction: (name: string, fn: () => void) => void;
	mapCommand: (
		keys: string,
		type: string,
		name: string,
		args: object,
		extra: object,
	) => void;
};

// Route Vim's normal-mode u / Ctrl-r to the model-level undo tree (blueprint 07
// §6, phase-4 E3) instead of CM6's linear history. Done once, globally.
let vimHistoryRemapped = false;
function ensureVimHistoryRemap(): void {
	if (vimHistoryRemapped || typeof window === "undefined") return;
	vimHistoryRemapped = true;
	try {
		const api = Vim as unknown as VimApi;
		api.defineAction("rectoHistoryUndo", () => {
			window.dispatchEvent(new CustomEvent("recto:history-undo"));
		});
		api.defineAction("rectoHistoryRedo", () => {
			window.dispatchEvent(new CustomEvent("recto:history-redo"));
		});
		api.mapCommand(
			"u",
			"action",
			"rectoHistoryUndo",
			{},
			{ context: "normal" },
		);
		api.mapCommand(
			"<C-r>",
			"action",
			"rectoHistoryRedo",
			{},
			{ context: "normal" },
		);
	} catch {
		// Vim API shape changed — degrade silently (undo via Mod-z still works).
	}
}

export const CodeMirrorEditor = forwardRef<
	CodeMirrorEditorHandle,
	CodeMirrorEditorProps
>(function CodeMirrorEditor(
	{
		vimEnabled,
		onChange,
		onVimModeChange,
		className,
		bridgeSession,
		spellcheck = true,
		smartPaste = true,
		typewriter = false,
		focusDim = false,
		focusDimScope = "sentence",
		onUploadImage,
	},
	ref,
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	const onUploadImageRef = useRef(onUploadImage);
	onUploadImageRef.current = onUploadImage;
	const onVimModeChangeRef = useRef(onVimModeChange);
	const bridgeSessionRef = useRef(bridgeSession);
	const programmaticRef = useRef(false);
	const vimCompartmentRef = useRef(new Compartment());
	const spellcheckCompartmentRef = useRef(new Compartment());
	const focusCompartmentRef = useRef(new Compartment());
	const vimEnabledRef = useRef(vimEnabled);
	vimEnabledRef.current = vimEnabled;
	const spellcheckRef = useRef(spellcheck);
	spellcheckRef.current = spellcheck;
	const smartPasteRef = useRef(smartPaste);
	smartPasteRef.current = smartPaste;
	const typewriterRef = useRef(typewriter);
	typewriterRef.current = typewriter;
	const focusDimRef = useRef(focusDim);
	focusDimRef.current = focusDim;
	const focusScopeRef = useRef<FocusScope>(focusDimScope);
	focusScopeRef.current = focusDimScope;

	onChangeRef.current = onChange;
	onVimModeChangeRef.current = onVimModeChange;
	bridgeSessionRef.current = bridgeSession;

	useEffect(() => {
		if (!containerRef.current || viewRef.current) return;

		ensureVimHistoryRemap();
		const vimExt = vimCompartmentRef.current.of(
			vimEnabledRef.current ? vim() : [],
		);

		const updateListener = EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			const programmatic = update.transactions.some((tr) =>
				tr.annotation(bridgeOrigin),
			);
			if (programmatic || programmaticRef.current) return;
			bridgeSessionRef.current?.handleRawUpdate(
				update.state.doc.toString(),
				false,
			);
			onChangeRef.current?.();
		});

		const extensions: Extension[] = [
			vimExt,
			spellcheckCompartmentRef.current.of(
				spellcheckAttrs(spellcheckRef.current),
			),
			focusCompartmentRef.current.of(
				buildFocusExtension(
					typewriterRef.current,
					focusDimRef.current,
					focusScopeRef.current,
				),
			),
			drawSelection(),
			markdown(),
			// Image paste/drop → Convex storage (plan 008), then smart paste: route
			// rich clipboard HTML through the canonical HTML→Markdown converter so a
			// paste from Word/Docs/web lands as clean canonical Markdown. Image items
			// are handled BEFORE the text/html branch. Off (or no image/html) falls
			// through to CM's default text/plain paste — that IS the "paste as plain"
			// branch.
			EditorView.domEventHandlers({
				paste(event, view) {
					const data = event.clipboardData;
					if (!data) return false; // let CM handle it
					// Image branch: an image item in the clipboard uploads + inserts a
					// canonical `![alt](url)` reference. Runs before the text/html path.
					const uploader = onUploadImageRef.current;
					const imageFile = [...data.items]
						.find((i) => i.type.startsWith("image/"))
						?.getAsFile();
					if (imageFile && uploader) {
						event.preventDefault();
						insertUploadedImage(
							viewRef,
							uploader,
							imageFile,
							view.state.selection.main.head,
						);
						return true;
					}
					const html = data.getData("text/html");
					if (!smartPasteRef.current || !html) return false;
					const md = markdownFromHtml(html);
					if (!md.trim()) return false;
					event.preventDefault();
					const { from, to } = view.state.selection.main;
					view.dispatch({
						changes: { from, to, insert: md },
						selection: { anchor: from + md.length },
					});
					return true;
				},
				drop(event, view) {
					const uploader = onUploadImageRef.current;
					const file = [...(event.dataTransfer?.files ?? [])].find((f) =>
						f.type.startsWith("image/"),
					);
					if (!file || !uploader) return false;
					event.preventDefault();
					const pos =
						view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
						view.state.selection.main.head;
					insertUploadedImage(viewRef, uploader, file, pos);
					return true;
				},
				// Clicking a comment highlight opens that comment in the panel
				// (editor→panel, the reverse of jumpToComment). Comment marks render
				// with a [data-comment-id] attribute, so we resolve the nearest such
				// ancestor of the click target and dispatch a window event. Returning
				// false lets CM place the caret / select normally — a non-highlight
				// click resolves nothing and is a plain no-op.
				mousedown(event) {
					const target = event.target as HTMLElement | null;
					const el = target?.closest?.("[data-comment-id]");
					const commentId = el?.getAttribute("data-comment-id");
					if (commentId) dispatchOpenComment(commentId);
					return false;
				},
			}),
			lintExtension(),
			commentHighlightExtension(),
			search({ top: true }),
			// AFTER vimExt so vim's keymap wins in normal mode (its `/` search keeps
			// working); the search keymap only binds panel chords (Mod-F, Enter, etc.).
			keymap.of(searchKeymap),
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

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({
			effects: spellcheckCompartmentRef.current.reconfigure(
				spellcheckAttrs(spellcheck),
			),
		});
	}, [spellcheck]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({
			effects: focusCompartmentRef.current.reconfigure(
				buildFocusExtension(typewriter, focusDim, focusDimScope),
			),
		});
		// Reconfiguring rebuilds the plugins but doesn't re-fire their update(); when
		// typewriter is freshly on, center the current caret right away.
		if (typewriter && view.state.selection.main.empty) {
			requestAnimationFrame(() => {
				view.dispatch({
					effects: EditorView.scrollIntoView(view.state.selection.main.head, {
						y: "center",
					}),
				});
			});
		}
	}, [typewriter, focusDim, focusDimScope]);

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
		runFormat(command: FormatCommand, opts?: { href?: string }) {
			const view = viewRef.current;
			if (!view) return;
			applyCmFormat(view, command, opts);
		},
		setVimEnabled(enabled: boolean) {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: vimCompartmentRef.current.reconfigure(enabled ? vim() : []),
			});
		},
		getCmView() {
			return viewRef.current;
		},
		setLintIssues(issues: LintIssue[]) {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({ effects: setLintIssues.of(issues) });
		},
		setCommentHighlights(highlights: CommentHighlight[]) {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({ effects: setCommentHighlights.of(highlights) });
		},
		openSearch() {
			const view = viewRef.current;
			if (!view) return;
			view.focus();
			openSearchPanel(view);
		},
	}));

	return <div ref={containerRef} className={className} />;
});

/** Window event name for "open the find/replace panel in the active editor". */
export const SEARCH_EVENT = "recto:open-search";

/** Ask the active pane's CodeMirror editor to open its search panel. */
export function dispatchOpenSearch(): void {
	window.dispatchEvent(new CustomEvent(SEARCH_EVENT));
}
