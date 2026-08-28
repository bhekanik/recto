"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { DocumentHeader } from "@/components/workspace/document-header";
import { EmptyPaneBound } from "@/components/workspace/empty-pane";
import { PaneShell } from "@/components/workspace/pane-shell";
import { api } from "@/convex/_generated/api";
import {
	CodeMirrorEditor,
	type CodeMirrorEditorHandle,
	SEARCH_EVENT,
} from "@/lib/editor/codemirror";
import { FORMAT_EVENT, type FormatEventDetail } from "@/lib/editor/format";
import { createPreviewHandle, type EditorHandle } from "@/lib/editor/handle";
import { uploadImage } from "@/lib/editor/image-upload";
import {
	MilkdownEditor,
	type MilkdownEditorHandle,
} from "@/lib/editor/milkdown";
import { PreviewPane } from "@/lib/editor/preview";
import {
	FOCUS_EDITOR_EVENT,
	FOCUS_PANE_EVENT,
	LINT_COUNT_EVENT,
	SWITCH_MODE_EVENT,
} from "@/lib/events";
import { useProseLint } from "@/lib/lint/use-prose-lint";
import {
	type DocumentMeta,
	EMPTY_META,
	splitFrontmatter,
} from "@/lib/markdown";
import type { CaretPosition, Mode, VimSubMode } from "@/lib/modes/types";
import {
	SET_COMMENTS_EVENT,
	type SetCommentsDetail,
} from "@/lib/review/summon";
import { useStudioSettingsContext } from "@/lib/studio/settings-context";
import { useIsMobile } from "@/lib/studio/use-is-mobile";
import { cn } from "@/lib/utils";
import type { PaneLeaf } from "@/lib/workspace/types";
import {
	useBridgeSession,
	useDocumentSyncFor,
	useWorkspace,
} from "@/lib/workspace/workspace-context";

/**
 * Convex's HTTP-actions origin (`.convex.site`), a different host from the
 * WebSocket API (`.convex.cloud`). Derived rather than required as its own
 * variable so an environment that only sets `NEXT_PUBLIC_CONVEX_URL` still
 * uploads.
 */
const CONVEX_SITE_URL = (
	process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
	(process.env.NEXT_PUBLIC_CONVEX_URL ?? "").replace(
		/\.convex\.cloud$/,
		".convex.site",
	)
).replace(/\/$/, "");

type PaneEditorProps = {
	leaf: PaneLeaf;
	isActive: boolean;
	onFocus: () => void;
	onOpenSwitcher: () => void;
	onCreate: () => void;
	/** Whether this pane can be closed (more than one pane open). */
	canClose: boolean;
	onClose: () => void;
};

function focusEditor(handle: EditorHandle): void {
	handle.focus();
	requestAnimationFrame(() => handle.focus());
}

/** Per-leaf editor surface; parent keys by paneId for stable mount. */
export function PaneEditor({
	leaf,
	isActive,
	onFocus,
	onOpenSwitcher,
	onCreate,
	canClose,
	onClose,
}: PaneEditorProps) {
	const { actions, registry } = useWorkspace();
	const {
		spellcheck,
		smartPaste,
		typewriter,
		focusDim,
		focusDimScope,
		lint,
		lintCategories,
	} = useStudioSettingsContext();
	// Typewriter fights the mobile soft keyboard (which manages the viewport
	// itself), so disable centering on phones; dimming stays on for all viewports.
	const isMobile = useIsMobile();
	const typewriterEffective = typewriter && !isMobile;
	const richRef = useRef<MilkdownEditorHandle>(null);
	const cmRef = useRef<CodeMirrorEditorHandle>(null);
	const [vimSubMode, setVimSubMode] = useState<VimSubMode>("normal");
	const [editorReady, setEditorReady] = useState(false);
	const [paneMarkdown, setPaneMarkdown] = useState<string | null>(null);
	const [pendingCaret, setPendingCaret] = useState<CaretPosition | null>(null);
	// Title/subtitle frontmatter surfaced as the rich-mode header. Milkdown reports
	// it via onMeta (on seed); the header writes back via richRef.setMeta.
	const [headerMeta, setHeaderMeta] = useState<DocumentMeta>({ ...EMPTY_META });

	const handleMetaChange = useCallback((meta: DocumentMeta) => {
		setHeaderMeta(meta);
		richRef.current?.setMeta(meta);
	}, []);

	// Image paste/drop (plan 008) — upload to Convex storage, then the editor's
	// paste/drop handler (CodeMirror or Milkdown) inserts a canonical image. The
	// URL resolve happens inside an event handler, so use the imperative client
	// (not a reactive useQuery).
	// One POST to Convex's HTTP endpoint, which stores the bytes and records who
	// owns them before answering. Splitting those two steps across the network
	// is what left files unattributed (ADR-21).
	const { getToken } = useAuth();
	const handleUploadImage = useCallback(
		(file: File | Blob) =>
			uploadImage({
				file,
				siteUrl: CONVEX_SITE_URL,
				getToken: () => getToken({ template: "convex" }),
			}),
		[getToken],
	);

	// Milkdown reports frontmatter on every seed. While the writer is editing the
	// header, IT is the source of truth — a seed's (possibly stale) metadata must
	// not clobber the title/subtitle being typed.
	const handleEditorMeta = useCallback((meta: DocumentMeta) => {
		if (document.activeElement?.closest("[data-doc-header]")) return;
		setHeaderMeta(meta);
	}, []);

	const documentId = leaf.documentId;
	const sync = useDocumentSyncFor(documentId);
	const documents = useQuery(api.documents.list, documentId ? {} : "skip");
	const meta = documents?.find((d) => d._id === documentId);
	const title = meta?.title ?? "Untitled";

	const markdown = paneMarkdown ?? sync?.markdown ?? "";
	const bridgeSession = useBridgeSession(documentId, markdown);

	const modeRef = useRef(leaf.mode);
	modeRef.current = leaf.mode;

	const paneMarkdownRef = useRef(paneMarkdown);
	paneMarkdownRef.current = paneMarkdown;

	const paneSeededRef = useRef(false);
	const freshSeedDoneRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on document rebind only
	useEffect(() => {
		paneSeededRef.current = false;
		freshSeedDoneRef.current = false;
	}, [documentId]);

	const getEditorHandle = useCallback((): EditorHandle | null => {
		if (modeRef.current === "rich") return richRef.current;
		if (modeRef.current === "raw" || modeRef.current === "vim") {
			return cmRef.current;
		}
		return createPreviewHandle(() => paneMarkdownRef.current ?? markdown);
	}, [markdown]);

	// Prose linter (plan 004). A per-keystroke tick (incremented from the editors'
	// onChange) is the linter's only re-analyze signal — it reads live editor text,
	// never a reactive query, so the editor keeps owning live state. The hook
	// debounces + runs off the typing hot path (worker, idle fallback).
	const [changeTick, setChangeTick] = useState(0);
	const handleEditorChange = useCallback(() => {
		sync?.handleEditorChange();
		setChangeTick((t) => t + 1);
	}, [sync]);

	const {
		docIssues,
		bodyIssues,
		count: lintCount,
	} = useProseLint(
		() => getEditorHandle()?.getCanonicalMarkdown() ?? "",
		lintCategories,
		lint,
		changeTick,
	);

	// Push fresh issues into whichever surfaces are mounted: CM takes full-doc
	// offsets, Milkdown takes body-relative issues (it re-searches by text). Also
	// re-pushes on a mode switch so a freshly mounted editor shows current marks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: leaf.mode re-pushes current issues into the editor that just became active on a mode switch
	useEffect(() => {
		cmRef.current?.setLintIssues(docIssues);
		richRef.current?.setLintIssues(bodyIssues);
	}, [docIssues, bodyIssues, leaf.mode]);

	// Surface the active pane's issue count to the status bar via a window event
	// (avoids prop-drilling through the recursive pane renderer).
	useEffect(() => {
		if (!isActive) return;
		window.dispatchEvent(
			new CustomEvent(LINT_COUNT_EVENT, {
				detail: { count: lint ? lintCount : 0 },
			}),
		);
	}, [isActive, lint, lintCount]);

	// Comment highlights (plan 010 Phase B): studio-shell owns the comment query +
	// anchoring and pushes located marks here for the ACTIVE pane only. We forward
	// them into whichever editors are mounted — CM takes resolved offsets, Milkdown
	// re-searches by quote. Display-only; the editor's document value is untouched.
	// A ref keeps the latest marks so a mode switch (fresh editor) can re-apply them.
	const lastCommentsRef = useRef<SetCommentsDetail>({ cm: [], pm: [] });
	useEffect(() => {
		if (!isActive) return;
		const onSetComments = (event: CustomEvent<SetCommentsDetail>) => {
			lastCommentsRef.current = event.detail;
			cmRef.current?.setCommentHighlights(event.detail.cm);
			richRef.current?.setCommentHighlights(event.detail.pm);
		};
		window.addEventListener(SET_COMMENTS_EVENT, onSetComments as EventListener);
		return () =>
			window.removeEventListener(
				SET_COMMENTS_EVENT,
				onSetComments as EventListener,
			);
	}, [isActive]);

	// Re-apply the latest comment marks into the editor that just became active on a
	// mode switch (mirrors the lint re-push on leaf.mode change).
	// biome-ignore lint/correctness/useExhaustiveDependencies: leaf.mode re-applies current marks into the freshly mounted editor
	useEffect(() => {
		cmRef.current?.setCommentHighlights(lastCommentsRef.current.cm);
		richRef.current?.setCommentHighlights(lastCommentsRef.current.pm);
	}, [leaf.mode]);

	useEffect(() => {
		if (!documentId) return;
		registry.acquire(documentId);
		return () => registry.release(documentId);
	}, [documentId, registry]);

	useEffect(() => {
		if (!documentId) return;
		registry.registerPane(documentId, {
			paneId: leaf.paneId,
			mode: leaf.mode,
			richRef,
			cmRef,
		});
		if (bridgeSession) {
			registry.setBridge(documentId, bridgeSession);
		}

		// Milkdown creates its ProseMirror view asynchronously, so getPmView()
		// can be null at register time and wireBridge would half-connect. Retry
		// (bounded) until both complementary editor views are live.
		let attempts = 0;
		let interval: number | null = null;
		if (!registry.wireBridge(documentId)) {
			interval = window.setInterval(() => {
				attempts += 1;
				if (registry.wireBridge(documentId) || attempts > 120) {
					if (interval !== null) window.clearInterval(interval);
					interval = null;
				}
			}, 40);
		}

		return () => {
			if (interval !== null) window.clearInterval(interval);
			registry.unregisterPane(documentId, leaf.paneId);
			// Re-evaluate so a removed pane disconnects its view and any
			// remaining complementary pair reconnects.
			registry.wireBridge(documentId);
		};
	}, [bridgeSession, documentId, leaf.mode, leaf.paneId, registry]);

	useEffect(() => {
		if (documentId && sync) {
			const t = setTimeout(() => setEditorReady(true), 50);
			return () => clearTimeout(t);
		}
		setEditorReady(false);
	}, [documentId, sync]);

	// Per-pane idle hydration. The active/focused pane owns its live state and is
	// seeded + idle-rehydrated by useDocumentSync (D11); here we keep any OTHER
	// pane bound to the same document (a D6 second pane) showing the canonical
	// markdown, and restore its persisted cursor/scroll on first seed. We never
	// seed a focused editor — that would clobber the writer's caret.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sync?.markdown drives re-hydration; leaf.viewState read once on first seed
	useEffect(() => {
		if (!editorReady || !documentId || !sync) return;
		if (leaf.mode === "preview") return;
		if (paneMarkdown !== null) return; // a local mode-switch owns this pane's content
		const handle = leaf.mode === "rich" ? richRef.current : cmRef.current;
		if (!handle || handle.isFocused()) return;
		// The writer may be editing the title/subtitle (ProseMirror reports itself
		// as unfocused then) — re-seeding would clobber the header mid-type.
		if (document.activeElement?.closest("[data-doc-header]")) return;

		handle.seed(sync.markdown, { programmatic: true });

		if (!paneSeededRef.current) {
			paneSeededRef.current = true;
			const sel = leaf.viewState.selection;
			const scrollFraction = leaf.viewState.scrollTop;
			requestAnimationFrame(() => {
				if (sel) {
					handle.importCaret({
						offset: sel.head,
						anchor: sel.anchor,
						head: sel.head,
					});
				}
				const root = handle.getRootElement();
				if (root && scrollFraction > 0) {
					const max = Math.max(0, root.scrollHeight - root.clientHeight);
					root.scrollTop = scrollFraction * max;
				}
			});
		}
	}, [editorReady, documentId, sync, sync?.markdown, leaf.mode, paneMarkdown]);

	// Fresh-pane seed: a new split clones an empty editor that is immediately
	// focused, so the idle hydration above skips it (focus guard) and the central
	// sync has already seeded the *previous* active pane. Seed this pane once,
	// retrying until Milkdown's async ProseMirror view is live. Guarded so it
	// never re-seeds a pane the writer has since edited or cleared.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per mount; sync?.markdown only gates content availability
	useEffect(() => {
		if (freshSeedDoneRef.current) return;
		if (!editorReady || !documentId || leaf.mode === "preview") return;
		if (paneMarkdown !== null) {
			freshSeedDoneRef.current = true;
			return;
		}
		const expected = sync?.markdown ?? "";
		if (!expected.trim()) return; // nothing to seed yet — wait for content
		// Compare the BODY, not the full canonical: an early frontmatter-only seed
		// (metaRef set before Milkdown's view was ready) leaves a non-empty
		// canonical (the `---` block) with an empty body — that still needs seeding.
		const expectedBody = splitFrontmatter(expected).body.trim();

		let cancelled = false;
		let attempts = 0;
		const trySeed = (): boolean => {
			if (cancelled) return true;
			const handle = leaf.mode === "rich" ? richRef.current : cmRef.current;
			if (!handle) return false;
			const currentBody = splitFrontmatter(
				handle.getCanonicalMarkdown(),
			).body.trim();
			// Body already matches (incl. both empty) — nothing to do.
			if (currentBody === expectedBody) {
				freshSeedDoneRef.current = true;
				return true;
			}
			handle.seed(expected, { programmatic: true });
			// A no-op seed means the inner editor isn't ready yet — retry.
			const afterBody = splitFrontmatter(
				handle.getCanonicalMarkdown(),
			).body.trim();
			if (afterBody === expectedBody) {
				freshSeedDoneRef.current = true;
				return true;
			}
			return false;
		};

		if (trySeed()) return;
		const interval = window.setInterval(() => {
			attempts += 1;
			if (trySeed() || attempts > 200) window.clearInterval(interval);
		}, 30);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [editorReady, documentId, leaf.mode, sync?.markdown, paneMarkdown]);

	// Capture this pane's cursor/scroll when it loses focus so cross-device resume
	// can restore a recent caret position (blueprint 09 §4.2 — recent is enough).
	useEffect(() => {
		if (!documentId || leaf.mode === "preview") return;
		const handle = leaf.mode === "rich" ? richRef.current : cmRef.current;
		const root = handle?.getRootElement() ?? null;
		if (!root) return;
		const capture = () => {
			const live = leaf.mode === "rich" ? richRef.current : cmRef.current;
			if (!live) return;
			const caret = live.exportCaret();
			const scrollMax = Math.max(0, root.scrollHeight - root.clientHeight);
			const scrollTop = scrollMax > 0 ? root.scrollTop / scrollMax : 0;
			actions.setPaneViewState(leaf.paneId, {
				selection: { anchor: caret.anchor, head: caret.head },
				scrollTop: Math.min(1, Math.max(0, scrollTop)),
			});
		};
		root.addEventListener("focusout", capture);
		return () => root.removeEventListener("focusout", capture);
	}, [documentId, leaf.mode, leaf.paneId, actions]);

	const lastModeRef = useRef<Mode | null>(null);

	useEffect(() => {
		if (!editorReady || !documentId) return;

		const previousMode = lastModeRef.current;
		const isInitial = previousMode === null;
		const isModeSwitch = previousMode !== null && previousMode !== leaf.mode;
		if (!isInitial && !isModeSwitch) return;

		if (leaf.mode === "preview") {
			lastModeRef.current = leaf.mode;
			return;
		}

		let cancelled = false;
		const run = (): boolean => {
			if (cancelled) return true;
			const handle = leaf.mode === "rich" ? richRef.current : cmRef.current;
			if (!handle) return false;

			if (isModeSwitch) {
				handle.seed(markdown, { programmatic: true });
				if (pendingCaret) {
					handle.importCaret(pendingCaret);
					setPendingCaret(null);
				}
			}

			if (isActive) focusEditor(handle);
			lastModeRef.current = leaf.mode;
			return true;
		};

		if (run()) return;
		const interval = window.setInterval(() => {
			if (run()) window.clearInterval(interval);
		}, 16);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [editorReady, documentId, leaf.mode, markdown, pendingCaret, isActive]);

	const switchMode = useCallback(
		(to: Mode) => {
			if (to === leaf.mode) return;
			const outgoing = getEditorHandle();
			const liveMarkdown = outgoing?.getCanonicalMarkdown() ?? markdown;
			const caret = outgoing?.exportCaret() ?? null;
			setPaneMarkdown(liveMarkdown);
			setPendingCaret(caret);
			actions.setPaneMode(leaf.paneId, to);
			// Mode switch is a structural boundary — commit the pending undo node.
			sync?.flushHistory();
			void sync?.flushMarkdown(liveMarkdown);
		},
		[actions, getEditorHandle, leaf.mode, leaf.paneId, markdown, sync],
	);

	useEffect(() => {
		if (!isActive) return;
		const onModeShortcut = (event: CustomEvent<{ mode: Mode }>) => {
			switchMode(event.detail.mode);
		};
		window.addEventListener(SWITCH_MODE_EVENT, onModeShortcut as EventListener);
		return () =>
			window.removeEventListener(
				SWITCH_MODE_EVENT,
				onModeShortcut as EventListener,
			);
	}, [isActive, switchMode]);

	// Find/replace lives in the CodeMirror-backed lenses (raw/vim). The rich lens
	// routes to raw first (in studio-shell); preview falls through to native find.
	useEffect(() => {
		if (!isActive) return;
		const onSearch = () => {
			if (leaf.mode !== "raw" && leaf.mode !== "vim") return;
			cmRef.current?.openSearch();
		};
		window.addEventListener(SEARCH_EVENT, onSearch as EventListener);
		return () =>
			window.removeEventListener(SEARCH_EVENT, onSearch as EventListener);
	}, [isActive, leaf.mode]);

	// Formatting commands (top toolbar + floating selection bar) target the active
	// pane's current editor; the preview handle's runFormat is a harmless no-op.
	useEffect(() => {
		if (!isActive) return;
		const onFormat = (event: CustomEvent<FormatEventDetail>) => {
			getEditorHandle()?.runFormat(event.detail.command, {
				href: event.detail.href,
			});
		};
		window.addEventListener(FORMAT_EVENT, onFormat as EventListener);
		return () =>
			window.removeEventListener(FORMAT_EVENT, onFormat as EventListener);
	}, [isActive, getEditorHandle]);

	// Writing is primary: any chrome interaction hands focus back to the editor.
	useEffect(() => {
		if (!isActive) return;
		const onFocusEditor = () => {
			const handle =
				leaf.mode === "rich"
					? richRef.current
					: leaf.mode === "raw" || leaf.mode === "vim"
						? cmRef.current
						: null;
			if (!handle) return;
			handle.focus();
			requestAnimationFrame(() => handle.focus());
		};
		window.addEventListener(FOCUS_EDITOR_EVENT, onFocusEditor);
		return () => window.removeEventListener(FOCUS_EDITOR_EVENT, onFocusEditor);
	}, [isActive, leaf.mode]);

	// Keyboard pane navigation moves editor focus into the now-active pane.
	useEffect(() => {
		const onFocusPane = (event: CustomEvent<{ paneId: string }>) => {
			if (event.detail.paneId !== leaf.paneId) return;
			const handle =
				leaf.mode === "rich"
					? richRef.current
					: leaf.mode === "preview"
						? null
						: cmRef.current;
			handle?.focus();
		};
		window.addEventListener(FOCUS_PANE_EVENT, onFocusPane as EventListener);
		return () =>
			window.removeEventListener(
				FOCUS_PANE_EVENT,
				onFocusPane as EventListener,
			);
	}, [leaf.paneId, leaf.mode]);

	if (!documentId) {
		return (
			<EmptyPaneBound
				leaf={leaf}
				onOpenSwitcher={onOpenSwitcher}
				onCreate={onCreate}
			/>
		);
	}

	const loading = !editorReady || !sync;
	const surfaceClass =
		"recto-editor-body h-full min-h-0 overflow-auto bg-[var(--color-bg-surface)]";

	const paneClass = (active: boolean) =>
		cn(
			"absolute inset-0 overflow-auto transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)] motion-reduce:transition-none",
			active
				? "pointer-events-auto z-10 opacity-100"
				: "pointer-events-none z-0 opacity-0",
		);

	const isCode = leaf.mode === "raw" || leaf.mode === "vim";

	return (
		<PaneShell
			paneId={leaf.paneId}
			title={title}
			mode={leaf.mode}
			vimSubMode={vimSubMode}
			isActive={isActive}
			onFocus={onFocus}
			canClose={canClose}
			onClose={onClose}
		>
			{loading ? (
				<Skeleton className="m-[var(--space-4)] min-h-[30vh] rounded-[var(--radius-lg)]" />
			) : (
				<div className="relative h-full min-h-[30vh]">
					<div
						className={paneClass(leaf.mode === "rich")}
						inert={leaf.mode !== "rich"}
					>
						<div className="recto-editor-body recto-rich-pane h-full min-h-0 overflow-auto bg-[var(--color-bg-surface)]">
							<DocumentHeader
								meta={headerMeta}
								onChange={handleMetaChange}
								onEnterBody={() => richRef.current?.focus()}
							/>
							<MilkdownEditor
								ref={richRef}
								bridgeSession={bridgeSession}
								onChange={handleEditorChange}
								onMeta={handleEditorMeta}
								typewriter={typewriterEffective}
								focusDim={focusDim}
								focusDimScope={focusDimScope}
								smartPaste={smartPaste}
								onUploadImage={handleUploadImage}
								className="milkdown"
							/>
						</div>
					</div>
					<div className={paneClass(isCode)} inert={!isCode}>
						<CodeMirrorEditor
							ref={cmRef}
							vimEnabled={leaf.mode === "vim"}
							bridgeSession={bridgeSession}
							onChange={handleEditorChange}
							onVimModeChange={setVimSubMode}
							spellcheck={spellcheck}
							smartPaste={smartPaste}
							typewriter={typewriterEffective}
							focusDim={focusDim}
							focusDimScope={focusDimScope}
							onUploadImage={handleUploadImage}
							className={`codemirror ${surfaceClass} font-[family-name:var(--font-mono)] text-[length:var(--text-body)]`}
						/>
					</div>
					<div
						className={paneClass(leaf.mode === "preview")}
						inert={leaf.mode !== "preview"}
					>
						<PreviewPane
							markdown={markdown}
							fallbackTitle={title}
							className={`recto-preview ${surfaceClass} text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-ink-primary)]`}
						/>
					</div>
				</div>
			)}
		</PaneShell>
	);
}
