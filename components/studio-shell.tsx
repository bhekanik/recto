"use client";

import { useClerk } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Command as CommandIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { CommandPalette } from "@/components/command-palette";
import { DocumentSwitcher } from "@/components/document-switcher";
import { EmptyState } from "@/components/empty-state";
import {
	HistoryPanel,
	type HistoryView,
} from "@/components/history/history-panel";
import { OutlinePanel } from "@/components/outline/outline-panel";
import { StatusBar } from "@/components/status-bar";
import { Toaster } from "@/components/toaster";
import { TopFormatToolbar } from "@/components/top-format-toolbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RenderPaneNode } from "@/components/workspace/render-pane-node";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dispatchOpenSearch } from "@/lib/editor/codemirror";
import {
	copyAsMarkdown,
	copyAsRichText,
	type ExportSource,
	exportHtmlFile,
	exportMarkdownFile,
} from "@/lib/export";
import type { ActionId } from "@/lib/keyboard/actions";
import {
	createAppShortcutHandler,
	dispatchFocusEditor,
	dispatchModeSwitch,
	resolveModeAction,
} from "@/lib/keyboard/app-shortcuts";
import { caretAtOffset } from "@/lib/modes/caret";
import { extractOutline } from "@/lib/outline/extract";
import { scrollRootToHeadingIndex } from "@/lib/outline/scroll-to-heading";
import { currentStreak, goalProgress, localDateKey } from "@/lib/stats/streak";
import { StudioSettingsProvider } from "@/lib/studio/settings-context";
import { useIsMobile } from "@/lib/studio/use-is-mobile";
import {
	READING_SCALE_MAX,
	READING_SCALE_MIN,
	useStudioSettings,
} from "@/lib/studio/use-studio-settings";
import { cn } from "@/lib/utils";
import { findLeaf } from "@/lib/workspace/queries";
import {
	getActiveLeaf,
	useDocumentHistoryFor,
	useWorkspace,
	WorkspaceProvider,
} from "@/lib/workspace/workspace-context";

function StudioWorkspace() {
	const {
		workspace,
		actions,
		registry,
		loading,
		documentSwitcherOpen,
		setDocumentSwitcherOpen,
		getDocumentSync,
	} = useWorkspace();

	const documents = useQuery(api.documents.list, {});
	const createDocument = useMutation(api.documents.create).withOptimisticUpdate(
		(localStore) => {
			const current = localStore.getQuery(api.documents.list, {});
			if (current === undefined) return;
			const now = Date.now();
			localStore.setQuery(api.documents.list, {}, [
				{
					_id: crypto.randomUUID() as Id<"documents">,
					title: "Untitled",
					wordCount: 0,
					updatedAt: now,
				},
				...current,
			]);
		},
	);

	const settings = useStudioSettings();
	const isMobile = useIsMobile();

	// Apply the palette to <html> (not just the shell div) so it also reaches
	// portalled overlays — command palette, switcher, dialogs — and the body
	// atmosphere wash, all of which mount outside the shell subtree.
	useEffect(() => {
		document.documentElement.dataset.theme = settings.theme;
	}, [settings.theme]);

	const [commandOpen, setCommandOpen] = useState(false);
	const [commandScope, setCommandScope] = useState<
		"all" | "documents" | "headings"
	>("all");
	const [creating, setCreating] = useState(false);
	const [statusVisible, setStatusVisible] = useState(true);
	// Active pane's prose-lint issue count, fed by a window event from PaneEditor.
	const [lintCount, setLintCount] = useState(0);

	useEffect(() => {
		const onCount = (event: CustomEvent<{ count: number }>) => {
			setLintCount(event.detail.count);
		};
		window.addEventListener("recto:lint-count", onCount as EventListener);
		return () =>
			window.removeEventListener("recto:lint-count", onCount as EventListener);
	}, []);

	// Zen mode: hide all chrome but the canvas; reveal on mouse move, re-hide on
	// idle (and stay revealed while the pointer is over the chrome).
	const [zen, setZen] = useState(false);
	const [chromeRevealed, setChromeRevealed] = useState(false);
	const overChromeRef = useRef(false);
	const revealTimerRef = useRef<number | null>(null);

	const clearRevealTimer = useCallback(() => {
		if (revealTimerRef.current !== null) {
			window.clearTimeout(revealTimerRef.current);
			revealTimerRef.current = null;
		}
	}, []);

	const scheduleHide = useCallback(() => {
		clearRevealTimer();
		revealTimerRef.current = window.setTimeout(() => {
			if (!overChromeRef.current) setChromeRevealed(false);
		}, 2200);
	}, [clearRevealTimer]);

	useEffect(() => {
		if (!zen) {
			setChromeRevealed(false);
			clearRevealTimer();
			return;
		}
		const onMove = () => {
			setChromeRevealed(true);
			scheduleHide();
		};
		window.addEventListener("mousemove", onMove);
		// Touch has no mousemove — reveal the chrome (and its exit control) on tap.
		window.addEventListener("touchstart", onMove, { passive: true });
		// Reveal briefly on entering zen so the exit control is discoverable.
		setChromeRevealed(true);
		scheduleHide();
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("touchstart", onMove);
			clearRevealTimer();
		};
	}, [zen, scheduleHide, clearRevealTimer]);

	const chromeHoverProps = zen
		? {
				onMouseEnter: () => {
					overChromeRef.current = true;
					clearRevealTimer();
					setChromeRevealed(true);
				},
				onMouseLeave: () => {
					overChromeRef.current = false;
					scheduleHide();
				},
			}
		: {};

	// Zen takes the page fullscreen too. Requested from a user gesture (toggle /
	// shortcut), so the browser allows it; failures degrade to plain zen.
	useEffect(() => {
		if (typeof document === "undefined") return;
		if (zen) {
			if (!document.fullscreenElement) {
				document.documentElement.requestFullscreen?.().catch(() => {});
			}
		} else if (document.fullscreenElement) {
			document.exitFullscreen?.().catch(() => {});
		}
	}, [zen]);

	// Leaving fullscreen by Esc / F11 should also leave zen.
	useEffect(() => {
		const onFullscreenChange = () => {
			if (!document.fullscreenElement) setZen(false);
		};
		document.addEventListener("fullscreenchange", onFullscreenChange);
		return () =>
			document.removeEventListener("fullscreenchange", onFullscreenChange);
	}, []);

	const activeLeaf = workspace ? getActiveLeaf(workspace) : null;
	const activeMode = activeLeaf?.mode ?? "rich";
	const activeDocId = activeLeaf?.documentId ?? null;
	const activeSync = activeDocId ? getDocumentSync(activeDocId) : null;
	const activeTitle =
		documents?.find((d) => d._id === activeDocId)?.title ?? "Untitled";
	const activeWordCount = activeSync?.wordCount ?? 0;

	// --- Word goals, session stats, and the cross-device streak (plan 002) ---
	const [goalConfigOpen, setGoalConfigOpen] = useState(false);

	// Per-document session baseline: the word count first observed this mount.
	// A new mount = a new session; switching docs keeps each doc's own baseline.
	const sessionBaselineRef = useRef<Map<Id<"documents">, number>>(new Map());
	if (
		activeDocId &&
		activeSync &&
		!sessionBaselineRef.current.has(activeDocId)
	) {
		sessionBaselineRef.current.set(activeDocId, activeWordCount);
	}
	const sessionBaseline = activeDocId
		? (sessionBaselineRef.current.get(activeDocId) ?? activeWordCount)
		: activeWordCount;
	const sessionWords = Math.max(activeWordCount - sessionBaseline, 0);

	// Cross-device daily totals (the streak source of truth lives in Convex).
	const dailyStats = useQuery(api.writingStats.list, {});
	const today = localDateKey();
	const streakDays = dailyStats ? currentStreak(dailyStats, today) : 0;
	const persistedTodayWords =
		dailyStats?.find((s) => s.date === today)?.words ?? 0;
	// "Today's words" for the daily goal = the day's high-water mark, plus the
	// live document count if it's currently higher (single active doc is typical).
	const dailyWords = Math.max(persistedTodayWords, activeWordCount);

	// Goal progress for whichever scope the (switchable) setting selects.
	const goalWords =
		settings.goalScope === "daily" ? dailyWords : activeWordCount;
	const goalTarget =
		settings.goalScope === "daily"
			? settings.dailyGoalTarget
			: settings.wordGoalTarget;
	const goalProgressValue = useMemo(
		() => goalProgress(goalWords, goalTarget, settings.wordGoalKind),
		[goalWords, goalTarget, settings.wordGoalKind],
	);
	const goalLabel =
		goalTarget > 0
			? `${settings.goalScope === "daily" ? "Daily goal" : "Goal"}: ${goalWords.toLocaleString()} / ${goalTarget.toLocaleString()} words`
			: "Set word goal";

	// Low-frequency daily-total flush — coarse on purpose. Streaks need only
	// day-granularity, so a ~30s debounce keeps stats writes off the typing hot
	// path; the mutation is monotonic, so redundant/late flushes are harmless.
	const recordStats = useMutation(api.writingStats.record);
	const dailyWordsRef = useRef(dailyWords);
	dailyWordsRef.current = dailyWords;
	const flushDailyTotal = useDebouncedCallback((words: number) => {
		if (words <= 0) return;
		void recordStats({ date: localDateKey(), words });
	}, 30_000);

	// Re-arm the debounce whenever the day's word count changes (not per save).
	useEffect(() => {
		flushDailyTotal(dailyWords);
	}, [dailyWords, flushDailyTotal]);

	// Flush once on unmount / tab close so the day's last words are recorded.
	useEffect(() => {
		const flushNow = () => {
			flushDailyTotal.cancel();
			if (dailyWordsRef.current > 0) {
				void recordStats({
					date: localDateKey(),
					words: dailyWordsRef.current,
				});
			}
		};
		window.addEventListener("beforeunload", flushNow);
		return () => {
			window.removeEventListener("beforeunload", flushNow);
			flushNow();
		};
	}, [flushDailyTotal, recordStats]);

	const activeHistory = useDocumentHistoryFor(activeDocId);
	const activeHistoryRef = useRef(activeHistory);
	activeHistoryRef.current = activeHistory;
	const [historyPanel, setHistoryPanel] = useState<{
		open: boolean;
		view: HistoryView;
	}>({ open: false, view: "tree" });

	const handleCheckpoint = useCallback(() => {
		const history = activeHistoryRef.current;
		if (!history) return;
		const label = window.prompt(
			"Name this version",
			`Checkpoint ${new Date().toLocaleString()}`,
		);
		if (label === null) return;
		void history.tagVersion(label || "Checkpoint", "manual");
	}, []);

	// Vim u / Ctrl-r route to the model-level undo tree via these events.
	useEffect(() => {
		const onUndo = () => activeHistoryRef.current?.undo();
		const onRedo = () => activeHistoryRef.current?.redo();
		window.addEventListener("recto:history-undo", onUndo);
		window.addEventListener("recto:history-redo", onRedo);
		return () => {
			window.removeEventListener("recto:history-undo", onUndo);
			window.removeEventListener("recto:history-redo", onRedo);
		};
	}, []);

	const handleCreate = useCallback(async () => {
		setCreating(true);
		try {
			const { documentId } = await createDocument({});
			if (workspace?.activePaneId) {
				actions.setPaneDocument(workspace.activePaneId, documentId);
			}
		} finally {
			setCreating(false);
		}
	}, [actions, createDocument, workspace?.activePaneId]);

	const { signOut } = useClerk();
	const handleSignOut = useCallback(async () => {
		await signOut();
		window.location.href = "/login";
	}, [signOut]);

	const getExportSource = useCallback((): ExportSource | null => {
		if (!activeDocId || !workspace) return null;
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		const markdown =
			handle?.getCanonicalMarkdown() ?? activeSync?.markdown ?? "";
		return { title: activeTitle, markdown };
	}, [activeDocId, workspace, registry, activeSync, activeTitle]);

	// --- Document outline (plan 005) ---
	// Read from the live handle (falling back to the synced markdown), matching
	// getExportSource. Recompute is debounced (D3) so typing stays off the parse
	// hot path; the panel and palette re-read whenever they open.
	const [outlineMarkdown, setOutlineMarkdown] = useState("");
	const refreshOutlineMarkdown = useCallback(() => {
		if (!activeDocId || !workspace) {
			setOutlineMarkdown("");
			return;
		}
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		const markdown =
			handle?.getCanonicalMarkdown() ?? activeSync?.markdown ?? "";
		setOutlineMarkdown(markdown);
	}, [activeDocId, workspace, registry, activeSync]);

	// The arg is the change signal only — the refresh always re-reads the live
	// handle (the synced markdown can lag the live editor by a frame).
	const debouncedRefreshOutline = useDebouncedCallback((_signal: string) => {
		refreshOutlineMarkdown();
	}, 250);

	// Re-arm the debounced refresh whenever the synced markdown changes.
	const syncedMarkdown = activeSync?.markdown ?? "";
	useEffect(() => {
		debouncedRefreshOutline(syncedMarkdown);
	}, [syncedMarkdown, debouncedRefreshOutline]);

	// Refresh immediately when the panel or the headings palette opens, so the
	// list is current the moment it's shown (the debounce can lag a recent edit).
	const outlinePanelOpen = settings.outlineOpen;
	const headingsPaletteOpen = commandOpen && commandScope === "headings";
	useEffect(() => {
		if (outlinePanelOpen || headingsPaletteOpen) refreshOutlineMarkdown();
	}, [outlinePanelOpen, headingsPaletteOpen, refreshOutlineMarkdown]);

	const outline = useMemo(
		() => extractOutline(outlineMarkdown),
		[outlineMarkdown],
	);
	const outlineRef = useRef(outline);
	outlineRef.current = outline;

	const jumpToHeading = useCallback(
		(index: number) => {
			if (!activeDocId || !workspace) return;
			const handle = registry.getPrimaryHandle(
				activeDocId,
				workspace.activePaneId,
			);
			// Scroll (works in rich/preview via rendered <hN> elements under the root).
			let root = handle?.getRootElement() ?? null;
			// Preview mode registers no handle — reach the active pane's preview DOM (D1a).
			if (!root) {
				root =
					document.querySelector<HTMLElement>(
						`[data-pane-id="${workspace.activePaneId}"] .recto-preview`,
					) ?? document.querySelector<HTMLElement>(".recto-preview");
			}
			scrollRootToHeadingIndex(root, index);
			// Best-effort caret: offset-exact for CodeMirror (raw/vim), a bonus for
			// Milkdown where the offset space differs. Focusing scrolls CM to the caret.
			const h = outlineRef.current[index];
			if (handle && h) {
				const md = handle.getCanonicalMarkdown();
				handle.importCaret(caretAtOffset(h.offset, md.length));
				handle.focus();
			}
		},
		[activeDocId, workspace, registry],
	);

	// Find & replace lives in the CodeMirror-backed lenses (raw/vim). Rich does a
	// lossless, instant switch to raw and opens the panel there; preview falls
	// through to the browser's native page find (no panel).
	const openFindReplace = useCallback(() => {
		if (!workspace) return;
		const leaf = findLeaf(workspace.paneTree, workspace.activePaneId);
		const mode = leaf?.mode ?? "rich";
		if (mode === "preview") return; // native browser find handles preview
		if (mode === "rich") {
			dispatchModeSwitch("raw");
			// Open once the raw editor has mounted + seeded (two frames after switch).
			requestAnimationFrame(() => {
				requestAnimationFrame(() => dispatchOpenSearch());
			});
			return;
		}
		dispatchOpenSearch();
	}, [workspace]);

	// The single action dispatcher — both the chord handler and the command
	// palette route into this (blueprint 13 §7.3.4: one implementation, two surfaces).
	const dispatch = useCallback(
		(id: ActionId) => {
			switch (id) {
				case "new-document":
					void handleCreate();
					return;
				case "mode-rich":
					dispatchModeSwitch("rich");
					return;
				case "mode-raw":
					dispatchModeSwitch("raw");
					return;
				case "mode-vim":
					dispatchModeSwitch("vim");
					return;
				case "mode-preview":
					dispatchModeSwitch("preview");
					return;
				case "cycle-next": {
					const leaf = workspace
						? findLeaf(workspace.paneTree, workspace.activePaneId)
						: null;
					dispatchModeSwitch(resolveModeAction(leaf?.mode ?? "rich", "next"));
					return;
				}
				case "cycle-prev": {
					const leaf = workspace
						? findLeaf(workspace.paneTree, workspace.activePaneId)
						: null;
					dispatchModeSwitch(resolveModeAction(leaf?.mode ?? "rich", "prev"));
					return;
				}
				case "split-v":
					// Splits are hidden on mobile (only the active pane renders), so
					// creating one would silently mutate an invisible tree.
					if (isMobile) return;
					actions.splitActivePane("vertical");
					return;
				case "split-h":
					if (isMobile) return;
					actions.splitActivePane("horizontal");
					return;
				case "close-pane":
					actions.closeActivePane();
					return;
				case "focus-next":
					actions.focusNextPane();
					return;
				case "focus-prev":
					actions.focusPrevPane();
					return;
				case "go-to-heading":
					setCommandScope("headings");
					setCommandOpen(true);
					return;
				case "toggle-outline":
					settings.toggleOutline();
					return;
				case "checkpoint":
					handleCheckpoint();
					return;
				case "undo-tree":
					setHistoryPanel({ open: true, view: "tree" });
					return;
				case "version-history":
					setHistoryPanel({ open: true, view: "versions" });
					return;
				case "undo":
					activeHistoryRef.current?.undo();
					return;
				case "redo":
					activeHistoryRef.current?.redo();
					return;
				case "copy-rich": {
					const source = getExportSource();
					if (source) void copyAsRichText(source);
					return;
				}
				case "copy-markdown": {
					const source = getExportSource();
					if (source) void copyAsMarkdown(source);
					return;
				}
				case "export-md": {
					const source = getExportSource();
					if (source) exportMarkdownFile(source);
					return;
				}
				case "export-html": {
					const source = getExportSource();
					if (source) exportHtmlFile(source);
					return;
				}
				case "find-replace":
					openFindReplace();
					return;
				case "toggle-status":
					setStatusVisible((v) => !v);
					return;
				case "toggle-focus":
					setZen((v) => !v);
					return;
				case "toggle-font":
					settings.toggleReadingFont();
					return;
				case "zoom-in":
					settings.zoomIn();
					return;
				case "zoom-out":
					settings.zoomOut();
					return;
				case "zoom-reset":
					settings.zoomReset();
					return;
				case "toggle-spellcheck":
					settings.toggleSpellcheck();
					return;
				case "toggle-toolbar":
					settings.toggleTopToolbar();
					return;
				case "toggle-typewriter":
					settings.toggleTypewriter();
					return;
				case "toggle-focus-dim":
					settings.toggleFocusDim();
					return;
				case "cycle-dim-scope":
					settings.cycleFocusDimScope();
					return;
				case "set-goal":
					setGoalConfigOpen(true);
					return;
				case "toggle-goal-style":
					settings.toggleGoalStyle();
					return;
				case "toggle-goal-scope":
					settings.toggleGoalScope();
					return;
				case "theme-twilight":
					settings.setTheme("twilight");
					return;
				case "theme-aurora":
					settings.setTheme("aurora");
					return;
				case "theme-dawn":
					settings.setTheme("dawn");
					return;
				case "theme-moonlit":
					settings.setTheme("moonlit");
					return;
			}
		},
		[
			actions,
			handleCreate,
			handleCheckpoint,
			getExportSource,
			openFindReplace,
			workspace,
			settings,
			isMobile,
		],
	);

	const dispatchRef = useRef(dispatch);
	dispatchRef.current = dispatch;

	useEffect(() => {
		if (!workspace) return;

		const handler = createAppShortcutHandler((action) => {
			switch (action.type) {
				case "open-palette":
					setCommandScope("all");
					setCommandOpen(true);
					return;
				case "open-document-switcher":
					setDocumentSwitcherOpen(true);
					return;
				case "new-document":
					void handleCreate();
					return;
				case "switch-mode":
					dispatchModeSwitch(action.mode);
					return;
				case "cycle-mode": {
					const leaf = findLeaf(workspace.paneTree, workspace.activePaneId);
					const current = leaf?.mode ?? "rich";
					dispatchModeSwitch(resolveModeAction(current, action.direction));
					return;
				}
				case "split-pane":
					actions.splitActivePane(action.direction);
					return;
				case "close-pane":
					actions.closeActivePane();
					return;
				case "focus-pane":
					if (action.direction === "next") actions.focusNextPane();
					else actions.focusPrevPane();
					return;
				case "focus-spatial":
					actions.focusDirection(action.direction);
					return;
				case "undo":
					activeHistoryRef.current?.undo();
					return;
				case "redo":
					activeHistoryRef.current?.redo();
					return;
				case "checkpoint":
					handleCheckpoint();
					return;
				case "open-undo-tree":
					setHistoryPanel({ open: true, view: "tree" });
					return;
				case "open-version-history":
					setHistoryPanel({ open: true, view: "versions" });
					return;
				case "copy-rich":
					dispatchRef.current("copy-rich");
					return;
				case "copy-markdown":
					dispatchRef.current("copy-markdown");
					return;
				case "export":
					setCommandScope("all");
					setCommandOpen(true);
					return;
				case "toggle-status":
					setStatusVisible((v) => !v);
					return;
				case "toggle-focus":
					setZen((v) => !v);
					return;
				case "toggle-typewriter":
					// Route through dispatchRef so the keydown listener isn't re-subscribed
					// on every settings change (settings stays out of this effect's deps).
					dispatchRef.current("toggle-typewriter");
					return;
				case "toggle-focus-dim":
					dispatchRef.current("toggle-focus-dim");
					return;
				case "open-go-to-heading":
					setCommandScope("headings");
					setCommandOpen(true);
					return;
				case "toggle-outline":
					// Route through dispatchRef so this effect's deps stay free of settings.
					dispatchRef.current("toggle-outline");
					return;
				case "find-replace":
					// Route through dispatchRef (stable) so this effect isn't re-subscribed.
					dispatchRef.current("find-replace");
					return;
			}
		});

		// Attach at window level (capture) so reserved chords like Cmd/Ctrl+P are
		// intercepted before the browser's default (print) regardless of focus.
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [
		actions,
		handleCreate,
		handleCheckpoint,
		setDocumentSwitcherOpen,
		workspace,
	]);

	if (loading || !workspace) {
		return (
			<div className="flex min-h-dvh items-center justify-center">
				<Skeleton className="h-8 w-32 rounded-[var(--radius-md)]" />
			</div>
		);
	}

	const showEmpty = documents !== undefined && documents.length === 0;
	const chromeHidden = zen && !chromeRevealed;

	const topChromeClass = cn(
		"z-30 flex flex-col transition-[transform,opacity] duration-[var(--motion-base)] ease-[var(--ease-out)] motion-reduce:transition-none",
		zen ? "fixed inset-x-0 top-0" : "shrink-0",
		chromeHidden && "pointer-events-none -translate-y-full opacity-0",
	);
	const bottomChromeClass = cn(
		"z-30 transition-[transform,opacity] duration-[var(--motion-base)] ease-[var(--ease-out)] motion-reduce:transition-none",
		zen ? "fixed inset-x-0 bottom-0" : "shrink-0",
		chromeHidden && "pointer-events-none translate-y-full opacity-0",
	);

	return (
		<StudioSettingsProvider value={settings}>
			<div
				className="relative flex h-dvh flex-col bg-[var(--color-bg-app)]"
				style={
					{
						"--reading-scale": settings.readingScale,
						"--reading-font":
							settings.readingFont === "serif"
								? "var(--font-app-serif)"
								: "var(--font-app-sans)",
					} as React.CSSProperties
				}
				spellCheck={settings.spellcheck}
			>
				<div className={topChromeClass} {...chromeHoverProps}>
					<header className="flex h-10 shrink-0 items-center justify-between gap-[var(--space-3)] border-b border-[var(--color-line)] bg-[var(--color-bg-app)] px-[var(--space-4)]">
						<div className="flex min-w-0 flex-1 items-center gap-[var(--space-3)]">
							<span className="select-none font-[family-name:var(--font-ui)] text-[length:var(--text-ui)] font-semibold tracking-tight text-[var(--color-ink-secondary)]">
								Recto
							</span>
							{!showEmpty && (
								<>
									<span
										aria-hidden
										className="h-3.5 w-px bg-[var(--color-line)]"
									/>
									<button
										type="button"
										onClick={() => setDocumentSwitcherOpen(true)}
										title="Switch document (⌘P)"
										className="min-w-0 truncate text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:text-[var(--color-ink-primary)]"
									>
										{activeTitle}
									</button>
								</>
							)}
						</div>
						<div className="flex items-center gap-[var(--space-1)]">
							<button
								type="button"
								onClick={() => {
									setCommandScope("all");
									setCommandOpen(true);
								}}
								title="Command palette (⌘K)"
								aria-label="Open command palette"
								className="inline-flex items-center gap-1.5 px-2 text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-ink-secondary)]"
							>
								{/* Touch has no ⌘K — show a tappable icon; keep the hint on desktop. */}
								<CommandIcon aria-hidden className="size-[18px] sm:hidden" />
								<span className="recto-kbd hidden sm:inline" aria-hidden>
									⌘K
								</span>
							</button>
							<Button
								variant="ghost"
								size="sm"
								className="text-[var(--color-ink-tertiary)] hover:text-[var(--color-ink-primary)]"
								onClick={() => void handleSignOut()}
							>
								Sign out
							</Button>
						</div>
					</header>

					{!showEmpty && settings.topToolbar && (
						<TopFormatToolbar
							disabled={activeMode === "preview"}
							onUndo={() => {
								dispatchRef.current("undo");
								dispatchFocusEditor();
							}}
							onRedo={() => {
								dispatchRef.current("redo");
								dispatchFocusEditor();
							}}
						/>
					)}
				</div>

				<main className="flex min-h-0 flex-1 flex-col bg-[var(--color-bg-app)]">
					{showEmpty ? (
						<EmptyState onCreate={handleCreate} pending={creating} />
					) : (
						<div className="min-h-0 flex-1">
							{/* Mobile: side-by-side splits don't fit, so render only the active
							    pane full-screen. The split tree still persists and returns on a
							    wider viewport; panes are reachable via "Focus next/prev pane". */}
							<RenderPaneNode
								node={isMobile && activeLeaf ? activeLeaf : workspace.paneTree}
								onOpenSwitcher={() => setDocumentSwitcherOpen(true)}
								onCreate={() => void handleCreate()}
							/>
						</div>
					)}
				</main>

				{!showEmpty && statusVisible && activeSync && (
					<div className={bottomChromeClass} {...chromeHoverProps}>
						<StatusBar
							wordCount={activeSync.wordCount}
							syncStatus={activeSync.syncStatus}
							mode={activeMode}
							onModeChange={(m) => dispatchModeSwitch(m)}
							theme={settings.theme}
							onCycleTheme={() => {
								settings.cycleTheme();
								dispatchFocusEditor();
							}}
							readingFont={settings.readingFont}
							onToggleFont={() => {
								settings.toggleReadingFont();
								dispatchFocusEditor();
							}}
							readingScale={settings.readingScale}
							onZoomIn={() => {
								settings.zoomIn();
								dispatchFocusEditor();
							}}
							onZoomOut={() => {
								settings.zoomOut();
								dispatchFocusEditor();
							}}
							onZoomReset={() => {
								settings.zoomReset();
								dispatchFocusEditor();
							}}
							canZoomIn={settings.readingScale < READING_SCALE_MAX}
							canZoomOut={settings.readingScale > READING_SCALE_MIN}
							spellcheck={settings.spellcheck}
							onToggleSpellcheck={() => {
								settings.toggleSpellcheck();
								dispatchFocusEditor();
							}}
							lint={settings.lint}
							onToggleLint={() => {
								settings.toggleLint();
								dispatchFocusEditor();
							}}
							lintCount={lintCount}
							typewriter={settings.typewriter}
							onToggleTypewriter={() => {
								settings.toggleTypewriter();
								dispatchFocusEditor();
							}}
							focusDim={settings.focusDim}
							onToggleFocusDim={() => {
								settings.toggleFocusDim();
								dispatchFocusEditor();
							}}
							focusDimScope={settings.focusDimScope}
							onCycleDimScope={() => {
								settings.cycleFocusDimScope();
								dispatchFocusEditor();
							}}
							zen={zen}
							onToggleZen={() => {
								setZen((v) => !v);
								dispatchFocusEditor();
							}}
							goalStyle={settings.goalStyle}
							goalProgress={goalProgressValue}
							goalTarget={goalTarget}
							goalLabel={goalLabel}
							sessionWords={sessionWords}
							streakDays={streakDays}
							goalConfigOpen={goalConfigOpen}
							onGoalConfigOpenChange={setGoalConfigOpen}
							wordGoalTarget={settings.wordGoalTarget}
							onWordGoalTargetChange={settings.setWordGoalTarget}
							dailyGoalTarget={settings.dailyGoalTarget}
							onDailyGoalTargetChange={settings.setDailyGoalTarget}
							wordGoalKind={settings.wordGoalKind}
							onWordGoalKindChange={settings.setWordGoalKind}
							goalScope={settings.goalScope}
							onGoalScopeChange={settings.setGoalScope}
							onGoalStyleChange={settings.setGoalStyle}
						/>
					</div>
				)}

				<CommandPalette
					open={commandOpen}
					onOpenChange={setCommandOpen}
					scope={commandScope}
					documents={documents}
					headings={outline}
					onRunAction={(id) => dispatchRef.current(id)}
					onOpenDocument={(id) => {
						if (workspace?.activePaneId) {
							actions.setPaneDocument(workspace.activePaneId, id);
						}
					}}
					onJumpToHeading={(i) => {
						jumpToHeading(i);
						dispatchFocusEditor();
					}}
				/>

				<DocumentSwitcher
					open={documentSwitcherOpen}
					onOpenChange={(open) => {
						setDocumentSwitcherOpen(open);
						if (!open) dispatchFocusEditor();
					}}
				/>

				{activeDocId && (
					<HistoryPanel
						documentId={activeDocId}
						open={historyPanel.open}
						view={historyPanel.view}
						onViewChange={(view) =>
							setHistoryPanel((prev) => ({ ...prev, view }))
						}
						onClose={() => {
							setHistoryPanel((prev) => ({ ...prev, open: false }));
							dispatchFocusEditor();
						}}
					/>
				)}

				{!showEmpty && (
					<OutlinePanel
						open={settings.outlineOpen}
						headings={outline}
						onJumpToHeading={(i) => {
							jumpToHeading(i);
							dispatchFocusEditor();
						}}
						onClose={() => {
							settings.setOutlineOpen(false);
							dispatchFocusEditor();
						}}
					/>
				)}

				<Toaster />
			</div>
		</StudioSettingsProvider>
	);
}

export function StudioShell() {
	const router = useRouter();
	const { isAuthenticated, isLoading: authLoading } = useConvexAuth();

	useEffect(() => {
		if (!authLoading && !isAuthenticated) {
			router.replace("/login");
		}
	}, [authLoading, isAuthenticated, router]);

	if (authLoading || !isAuthenticated) {
		return (
			<div className="flex min-h-dvh items-center justify-center">
				<Skeleton className="h-8 w-32 rounded-[var(--radius-md)]" />
			</div>
		);
	}

	return (
		<WorkspaceProvider enabled={isAuthenticated}>
			<StudioWorkspace />
		</WorkspaceProvider>
	);
}
