"use client";

import { useClerk } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Command as CommandIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { DocumentSwitcher } from "@/components/document-switcher";
import { EmptyState } from "@/components/empty-state";
import {
	HistoryPanel,
	type HistoryView,
} from "@/components/history/history-panel";
import { StatusBar } from "@/components/status-bar";
import { Toaster } from "@/components/toaster";
import { TopFormatToolbar } from "@/components/top-format-toolbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RenderPaneNode } from "@/components/workspace/render-pane-node";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
	const [commandScope, setCommandScope] = useState<"all" | "documents">("all");
	const [creating, setCreating] = useState(false);
	const [statusVisible, setStatusVisible] = useState(true);

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
							zen={zen}
							onToggleZen={() => {
								setZen((v) => !v);
								dispatchFocusEditor();
							}}
						/>
					</div>
				)}

				<CommandPalette
					open={commandOpen}
					onOpenChange={setCommandOpen}
					scope={commandScope}
					documents={documents}
					onRunAction={(id) => dispatchRef.current(id)}
					onOpenDocument={(id) => {
						if (workspace?.activePaneId) {
							actions.setPaneDocument(workspace.activePaneId, id);
						}
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
