"use client";

import { useClerk } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Command as CommandIcon, GitBranch } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiConsentDialog } from "@/components/ai/ai-consent-dialog";
import { AiReviewPanel } from "@/components/ai/ai-review-panel";
import { AiTransformPopover } from "@/components/ai/ai-transform-popover";
import { RelatedPassagesPanel } from "@/components/ai/related-passages-panel";
import { CommandPalette } from "@/components/command-palette";
import { DeleteAccountDialog } from "@/components/delete-account-dialog";
import { DocumentSwitcher } from "@/components/document-switcher";
import { EmptyState } from "@/components/empty-state";
import { FlagNoteField } from "@/components/flags/flag-note-field";
import { NotesPanel } from "@/components/flags/notes-panel";
import {
	HistoryPanel,
	type HistoryView,
} from "@/components/history/history-panel";
import { OutlinePanel } from "@/components/outline/outline-panel";
import { CommentsPanel } from "@/components/review/comments-panel";
import { ReviewSurface } from "@/components/review/review-surface";
import { ShareDialog } from "@/components/share-dialog";
import { SyncStatusBar } from "@/components/sync/sync-status-bar";
import { Toaster } from "@/components/toaster";
import { TopFormatToolbar } from "@/components/top-format-toolbar";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { RenderPaneNode } from "@/components/workspace/render-pane-node";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dispatchOpenSearch } from "@/lib/editor/codemirror";
import {
	HISTORY_REDO_EVENT,
	HISTORY_UNDO_EVENT,
	LINT_COUNT_EVENT,
} from "@/lib/events";
import type { ExportSource } from "@/lib/export";
import {
	isMacOSPlatform,
	macAppDocumentURL,
} from "@/lib/handoff/document-link";
import { useDocumentDeepLink } from "@/lib/handoff/use-document-deep-link";
import type { ActionId } from "@/lib/keyboard/actions";
import {
	createAppShortcutHandler,
	dispatchFocusEditor,
	dispatchModeSwitch,
	resolveModeAction,
} from "@/lib/keyboard/app-shortcuts";
import { readingTimeMinutes } from "@/lib/markdown";
import { headingsWithFlags } from "@/lib/outline/flagged-headings";
import { createActionMap } from "@/lib/studio/action-map";
import { StudioSettingsProvider } from "@/lib/studio/settings-context";
import { useAiFeatures } from "@/lib/studio/use-ai-features";
import { useCommentHighlights } from "@/lib/studio/use-comment-highlights";
import { draftKey, useFlags } from "@/lib/studio/use-flags";
import { useIsMobile } from "@/lib/studio/use-is-mobile";
import { useOutline } from "@/lib/studio/use-outline";
import { useQuietChrome } from "@/lib/studio/use-quiet-chrome";
import { useResolvedAppearance } from "@/lib/studio/use-resolved-appearance";
import {
	READING_SCALE_MAX,
	READING_SCALE_MIN,
	useStudioSettings,
} from "@/lib/studio/use-studio-settings";
import { useWritingStats } from "@/lib/studio/use-writing-stats";
import { useZenMode } from "@/lib/studio/use-zen-mode";
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
					titleMode: "derived" as const,
					wordCount: 0,
					updatedAt: now,
					documentUuid: undefined,
				},
				...current,
			]);
		},
	);

	const settings = useStudioSettings();
	const isMobile = useIsMobile();
	// Writes the `dark` class on <html>; the layout's blocking script already set
	// it before the first paint, this keeps it honest when the setting changes.
	const resolvedAppearance = useResolvedAppearance(settings.appearance);
	const darkPalettes = resolvedAppearance === "dark";

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
		window.addEventListener(LINT_COUNT_EVENT, onCount as EventListener);
		return () =>
			window.removeEventListener(LINT_COUNT_EVENT, onCount as EventListener);
	}, []);

	// Zen mode: hide all chrome but the canvas; reveal on mouse move, re-hide on
	// idle (and stay revealed while the pointer is over the chrome). Also takes
	// the page fullscreen; leaving fullscreen leaves zen.
	const { zen, setZen, chromeRevealed, chromeHoverProps } = useZenMode();
	// Zen already hides the chrome; quiet chrome is for the everyday window.
	const quiet = useQuietChrome(settings.quietChrome && !zen);

	const activeLeaf = workspace ? getActiveLeaf(workspace) : null;
	const activeMode = activeLeaf?.mode ?? "rich";
	// Live mirror of the active lens for the (stable) shortcut handler, so the
	// find chord can fall through to native page find in the read-only preview
	// lens without re-subscribing the keydown listener on every mode switch.
	const activeModeRef = useRef(activeMode);
	activeModeRef.current = activeMode;
	// Live mirror of the mobile breakpoint for the (stable) shortcut handler, so the
	// split chord can mobile-gate exactly like the palette without re-subscribing the
	// keydown listener every time the viewport crosses the breakpoint.
	const isMobileRef = useRef(isMobile);
	isMobileRef.current = isMobile;
	const activeDocId = activeLeaf?.documentId ?? null;
	const canOpenInMacApp = isMacOSPlatform() && activeDocId !== null;

	useDocumentDeepLink({
		enabled: !loading && workspace !== null,
		documents,
		activePaneId: workspace?.activePaneId,
		setPaneDocument: (paneId, documentId) => {
			actions.setPaneDocument(paneId, documentId);
		},
	});
	const activeSync = activeDocId ? getDocumentSync(activeDocId) : null;
	const activeTitle =
		documents?.find((d) => d._id === activeDocId)?.title ?? "Untitled";
	const activeWordCount = activeSync?.wordCount ?? 0;

	// Is the active document shared (owner has invited reviewers) OR shared-with-me?
	// While true, AI is forced OFF for everyone (plan 010 cross-cutting rule): a
	// reviewer must never trigger the owner's spend and AI must not muddy the
	// suggestion/branch flow mid-review. Read once per active doc; null while
	// loading or for a doc the caller can't see.
	const activeShareState = useQuery(
		api.review.documentShareState,
		activeDocId ? { documentId: activeDocId } : "skip",
	);
	const aiConsent = useQuery(api.ai.consent.get, {});
	const acceptAiConsent = useMutation(api.ai.consent.accept);
	const [aiConsentOpen, setAiConsentOpen] = useState(false);
	const [aiConsentBusy, setAiConsentBusy] = useState(false);
	const [aiConsentError, setAiConsentError] = useState<string | null>(null);
	const activeDocShared = activeShareState?.shared ?? false;
	// The owner can manage sharing; a grantee cannot.
	const activeDocIsOwned =
		activeShareState === undefined || activeShareState === null
			? true
			: activeShareState.role === "owner";
	const hasCurrentAiConsent =
		aiConsent?.acceptedAt !== null && aiConsent !== undefined;
	const effectiveAiEnabled =
		settings.aiEnabled && hasCurrentAiConsent && !activeDocShared;
	const toggleAiEnabled = useCallback(() => {
		if (settings.aiEnabled) {
			settings.setAiEnabled(false);
			return;
		}
		if (hasCurrentAiConsent) {
			settings.setAiEnabled(true);
			return;
		}
		setAiConsentOpen(true);
	}, [hasCurrentAiConsent, settings]);
	const handleAcceptAiConsent = useCallback(async () => {
		if (!aiConsent) return;
		setAiConsentBusy(true);
		setAiConsentError(null);
		try {
			await acceptAiConsent({ version: aiConsent.version });
			settings.setAiEnabled(true);
			setAiConsentOpen(false);
		} catch (error) {
			setAiConsentError(
				error instanceof Error
					? error.message
					: "Could not enable AI. Try again.",
			);
		} finally {
			setAiConsentBusy(false);
		}
	}, [acceptAiConsent, aiConsent, settings]);
	const [shareDialogOpen, setShareDialogOpen] = useState(false);

	// Comments (plan 010 Phase B). Available whenever the caller can see the active
	// doc with at least commenter access: the owner always can; a grantee can (any
	// share role is ≥ commenter). `documentShareState` returns null for a doc the
	// caller can't see, and a role for any doc they can.
	const canComment =
		activeDocId !== null &&
		(activeShareState === undefined ||
			activeShareState === null ||
			Boolean(activeShareState.role));

	// Owner review surface (plan 010 Phase C). The owner of the active doc sees
	// open reviewer suggestion branches; a subtle header indicator appears when
	// there are any. `openBranchCount` is owner-only (it throws for a non-owner),
	// so only query it when the active doc is owned.
	const openBranchCount = useQuery(
		api.review.openBranchCount,
		activeDocId && activeDocIsOwned ? { documentId: activeDocId } : "skip",
	);
	const hasOpenBranches = (openBranchCount ?? 0) > 0;
	const canReview = activeDocIsOwned && hasOpenBranches;
	const [reviewOpen, setReviewOpen] = useState(false);

	// --- Word goals, session stats, and the cross-device streak (plan 002) ---
	const [goalConfigOpen, setGoalConfigOpen] = useState(false);

	const { sessionWords, streakDays, goalProgressValue, goalTarget, goalLabel } =
		useWritingStats({
			activeDocId,
			hasActiveSync: Boolean(activeSync),
			activeWordCount,
			goalScope: settings.goalScope,
			wordGoalTarget: settings.wordGoalTarget,
			dailyGoalTarget: settings.dailyGoalTarget,
			wordGoalKind: settings.wordGoalKind,
		});

	const activeHistory = useDocumentHistoryFor(activeDocId);
	const activeHistoryRef = useRef(activeHistory);
	activeHistoryRef.current = activeHistory;
	const [historyPanel, setHistoryPanel] = useState<{
		open: boolean;
		view: HistoryView;
	}>({ open: false, view: "tree" });

	// Read the live markdown of the active document from its primary handle.
	const getActiveMarkdown = useCallback((): string => {
		if (!activeDocId || !workspace) return "";
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		return handle?.getCanonicalMarkdown() ?? activeSync?.markdown ?? "";
	}, [activeDocId, workspace, registry, activeSync]);

	const getActiveCaretSection = useCallback((): string => {
		if (!activeDocId || !workspace) return "";
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		return handle?.getCaretSectionMarkdown?.() ?? getActiveMarkdown();
	}, [activeDocId, workspace, registry, getActiveMarkdown]);

	// --- Comments (plan 010 Phase B) ---------------------------------------
	const {
		commentsOpen,
		setCommentsOpen,
		commentDraft,
		setCommentDraft,
		focusedCommentId,
		setFocusedCommentId,
		jumpToComment,
		summonAddComment,
	} = useCommentHighlights({
		activeDocId,
		workspace,
		registry,
		activeMode,
		canComment,
		getActiveMarkdown,
		syncedMarkdown: activeSync?.markdown ?? "",
	});

	// --- AI features (plan 009 transform + RAG, plan 011 reviewer) — gated behind
	// the EFFECTIVE AI flag (settings.aiEnabled AND the active doc not being shared
	// for review, plan 010).
	const {
		aiTransform,
		aiPopover,
		setAiPopover,
		aiReview,
		aiReviewOpen,
		setAiReviewOpen,
		relatedOpen,
		setRelatedOpen,
		summonAiTransform,
		runAiTransform,
		handleReindex,
		openRelatedPassage,
	} = useAiFeatures({
		activeDocId,
		workspace,
		registry,
		activeMode,
		effectiveAiEnabled,
		aiTransformMode: settings.aiTransformMode,
		getActiveMarkdown,
		getController: () => activeHistoryRef.current,
		setPaneDocument: actions.setPaneDocument,
	});

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
		window.addEventListener(HISTORY_UNDO_EVENT, onUndo);
		window.addEventListener(HISTORY_REDO_EVENT, onRedo);
		return () => {
			window.removeEventListener(HISTORY_UNDO_EVENT, onUndo);
			window.removeEventListener(HISTORY_REDO_EVENT, onRedo);
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
	const [accountMenuOpen, setAccountMenuOpen] = useState(false);
	const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
	const handleSignOut = useCallback(async () => {
		await signOut();
		window.location.href = "/login";
	}, [signOut]);

	/**
	 * After deletion the Clerk user no longer exists, so `signOut` may well
	 * fail — the point of calling it is to clear the local session before
	 * leaving, and failing to do that must not strand the writer in a studio
	 * whose account is gone.
	 */
	const handleAccountDeleted = useCallback(async () => {
		try {
			await signOut();
		} finally {
			window.location.href = "/login";
		}
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
	const { outline, jumpToHeading } = useOutline({
		activeDocId,
		workspace,
		registry,
		syncedMarkdown: activeSync?.markdown ?? "",
		outlinePanelOpen: settings.outlineOpen,
		headingsPaletteOpen: commandOpen && commandScope === "headings",
	});

	// --- Writing flags: ⌘⇧X drops one, the notes panel lists them ---
	const flagState = useFlags({
		activeDocId,
		workspace,
		registry,
		syncedMarkdown: activeSync?.markdown ?? "",
		notesPinned: settings.notesPinned,
		unpinNotes: settings.toggleNotesPinned,
	});

	const flaggedHeadings = useMemo(
		() => headingsWithFlags(outline, flagState.flags),
		[outline, flagState.flags],
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

	// The single application action registry (blueprint 13 §7.3.4): one
	// `Record<ActionId, () => void>` that both surfaces call directly — the command
	// palette / menu and the capture-phase keyboard handler.
	const actionMap = useMemo(
		() =>
			createActionMap({
				settings,
				actions,
				isMobile,
				getActiveMode: () => {
					const leaf = workspace
						? findLeaf(workspace.paneTree, workspace.activePaneId)
						: null;
					return leaf?.mode ?? "rich";
				},
				getController: () => activeHistoryRef.current,
				handleCreate,
				handleCheckpoint,
				handleReindex,
				getExportSource,
				openFindReplace,
				summonAiTransform,
				summonAddComment,
				addFlag: flagState.addFlag,
				toggleNotes: flagState.toggleNotes,
				effectiveAiEnabled,
				activeDocId,
				activeDocIsOwned,
				canComment,
				setCommandScope,
				setCommandOpen,
				setHistoryPanel,
				setShareDialogOpen,
				setReviewOpen,
				setCommentsOpen,
				setAiReviewOpen,
				setRelatedOpen,
				setStatusVisible,
				setZen,
				setGoalConfigOpen,
				toggleAiEnabled,
				openInMacApp: (documentId) => {
					window.location.assign(macAppDocumentURL(documentId));
				},
			}),
		[
			actions,
			handleCreate,
			handleCheckpoint,
			handleReindex,
			getExportSource,
			openFindReplace,
			workspace,
			settings,
			isMobile,
			summonAiTransform,
			summonAddComment,
			flagState.addFlag,
			flagState.toggleNotes,
			effectiveAiEnabled,
			activeDocId,
			activeDocIsOwned,
			canComment,
			setCommentsOpen,
			setZen,
			setAiReviewOpen,
			setRelatedOpen,
			toggleAiEnabled,
		],
	);

	const runAction = useCallback((id: ActionId) => actionMap[id](), [actionMap]);

	const dispatchRef = useRef(runAction);
	dispatchRef.current = runAction;

	useEffect(() => {
		if (!workspace) return;

		// The keyboard handler routes every action with an `ActionId` equivalent into
		// the SAME action map (via the stable dispatchRef), so there is one
		// implementation per action. The handful of cases below have no `ActionId`
		// (palette / switcher open, spatial focus) or are parameterized by the chord
		// (mode switch/cycle, split direction — the chord split is mobile-gated via
		// `isMobileRef` to match the palette's `split-v`/`split-h`), so the handler
		// performs those directly. Routing through dispatchRef also keeps this effect's
		// deps minimal so the listener isn't re-subscribed on state changes.
		const handler = createAppShortcutHandler(
			(action) => {
				switch (action.type) {
					case "open-palette":
						setCommandScope("all");
						setCommandOpen(true);
						return;
					case "open-document-switcher":
						setDocumentSwitcherOpen(true);
						return;
					case "new-document":
						dispatchRef.current("new-document");
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
						// Mobile renders only the active pane, so a split would silently
						// mutate an invisible tree — gate it exactly like the palette's
						// `split-v`/`split-h` (lib/studio/action-map.ts).
						if (isMobileRef.current) return;
						actions.splitActivePane(action.direction);
						return;
					case "close-pane":
						dispatchRef.current("close-pane");
						return;
					case "focus-pane":
						dispatchRef.current(
							action.direction === "next" ? "focus-next" : "focus-prev",
						);
						return;
					case "focus-spatial":
						actions.focusDirection(action.direction);
						return;
					case "undo":
						dispatchRef.current("undo");
						return;
					case "redo":
						dispatchRef.current("redo");
						return;
					case "checkpoint":
						dispatchRef.current("checkpoint");
						return;
					case "open-undo-tree":
						dispatchRef.current("undo-tree");
						return;
					case "open-version-history":
						dispatchRef.current("version-history");
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
						dispatchRef.current("toggle-status");
						return;
					case "toggle-focus":
						dispatchRef.current("toggle-focus");
						return;
					case "toggle-typewriter":
						dispatchRef.current("toggle-typewriter");
						return;
					case "toggle-focus-dim":
						dispatchRef.current("toggle-focus-dim");
						return;
					case "toggle-focus-blur":
						dispatchRef.current("toggle-focus-blur");
						return;
					case "toggle-spellcheck":
						dispatchRef.current("toggle-spellcheck");
						return;
					case "add-flag":
						dispatchRef.current("add-flag");
						return;
					case "toggle-notes":
						dispatchRef.current("toggle-notes");
						return;
					case "open-go-to-heading":
						dispatchRef.current("go-to-heading");
						return;
					case "toggle-outline":
						dispatchRef.current("toggle-outline");
						return;
					case "find-replace":
						dispatchRef.current("find-replace");
						return;
					case "ai-transform":
						dispatchRef.current("ai-transform");
						return;
					case "ai-critique":
						dispatchRef.current("ai-critique");
						return;
					case "ai-related":
						dispatchRef.current("ai-related");
						return;
				}
			},
			() => activeModeRef.current,
		);

		// Attach at window level (capture) so reserved chords like Cmd/Ctrl+P are
		// intercepted before the browser's default (print) regardless of focus.
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [actions, setDocumentSwitcherOpen, workspace]);

	if (loading || !workspace) {
		return (
			<div className="flex min-h-dvh items-center justify-center">
				<Skeleton className="h-8 w-32 rounded-[var(--radius-md)]" />
			</div>
		);
	}

	const showEmpty = documents !== undefined && documents.length === 0;
	const chromeHidden = zen && !chromeRevealed;
	// Quiet chrome fades slowly out and quickly back, like the Mac app. The status
	// bar keeps a trace: the word count and saved state are safety nets.
	const quietFade = quiet
		? "duration-[450ms] ease-in-out"
		: "duration-[200ms] ease-in-out";

	const topChromeClass = cn(
		"z-30 flex flex-col transition-[transform,opacity] duration-[var(--motion-base)] ease-[var(--ease-out)] motion-reduce:transition-none",
		zen ? "fixed inset-x-0 top-0" : "shrink-0",
		chromeHidden && "pointer-events-none -translate-y-full opacity-0",
		!zen && quietFade,
		quiet && "opacity-0",
	);
	const bottomChromeClass = cn(
		"z-30 transition-[transform,opacity] duration-[var(--motion-base)] ease-[var(--ease-out)] motion-reduce:transition-none",
		zen ? "fixed inset-x-0 bottom-0" : "shrink-0",
		chromeHidden && "pointer-events-none translate-y-full opacity-0",
		!zen && quietFade,
		quiet && "opacity-30",
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
							<span className="select-none font-[family-name:var(--font-app-serif)] text-[length:var(--text-ui)] font-semibold tracking-tight text-[var(--color-ink-secondary)]">
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
									{/* Subtle indicator: this owned doc has open reviewer
									    suggestions. Click to open the review surface. */}
									{canReview && (
										<button
											type="button"
											onClick={() => setReviewOpen(true)}
											title={`${openBranchCount} open suggestion${
												openBranchCount === 1 ? "" : "s"
											} — review`}
											aria-label="Review suggestions"
											className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-accent-wash)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--color-accent-2)] transition-colors hover:bg-[var(--color-accent-muted)]"
										>
											<GitBranch aria-hidden className="size-3" />
											{openBranchCount}
										</button>
									)}
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
							{/* Account menu rather than a bare "Sign out": guideline
							    5.1.1(v) requires in-app account deletion, and a
							    destructive action does not belong loose in the header. */}
							<Popover open={accountMenuOpen} onOpenChange={setAccountMenuOpen}>
								<PopoverTrigger
									className="px-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-ink-primary)]"
									aria-label="Account"
								>
									Account
								</PopoverTrigger>
								<PopoverContent
									align="end"
									className="w-56 gap-1 border border-[var(--color-line)] bg-[var(--color-bg-raised)] p-1"
								>
									<Button
										variant="ghost"
										size="sm"
										className="justify-start"
										onClick={() => {
											setAccountMenuOpen(false);
											void handleSignOut();
										}}
									>
										Sign out
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className="justify-start text-[var(--color-danger)] hover:text-[var(--color-danger)]"
										onClick={() => {
											setAccountMenuOpen(false);
											setDeleteAccountOpen(true);
										}}
									>
										Delete account…
									</Button>
								</PopoverContent>
							</Popover>
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
						<SyncStatusBar
							sync={activeSync}
							onOpenInMacApp={
								canOpenInMacApp
									? () => dispatchRef.current("open-in-mac-app")
									: undefined
							}
							wordCount={activeSync.wordCount}
							readingMinutes={readingTimeMinutes(activeSync.wordCount)}
							mode={activeMode}
							onModeChange={(m) => dispatchModeSwitch(m)}
							theme={settings.theme}
							onCycleTheme={() => {
								settings.cycleTheme();
								dispatchFocusEditor();
							}}
							appearance={settings.appearance}
							onCycleAppearance={() => {
								settings.cycleAppearance();
								dispatchFocusEditor();
							}}
							resolvedAppearance={resolvedAppearance}
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
							focusBlur={settings.focusBlur}
							onToggleFocusBlur={() => {
								settings.toggleFocusBlur();
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
					aiEnabled={effectiveAiEnabled}
					canManageSharing={activeDocId !== null && activeDocIsOwned}
					canReview={activeDocId !== null && canReview}
					canComment={canComment}
					darkPalettesAvailable={darkPalettes}
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
					canOpenInMacApp={canOpenInMacApp}
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

				{!showEmpty && flagState.notesOpen && (
					<NotesPanel
						flags={flagState.flags}
						pinned={settings.notesPinned}
						onTogglePin={settings.toggleNotesPinned}
						onGoTo={flagState.goToFlag}
						onResolve={flagState.resolveFlag}
						onClose={() => {
							flagState.setNotesOpen(false);
							dispatchFocusEditor();
						}}
					/>
				)}

				{flagState.draft && (
					<FlagNoteField
						key={draftKey(flagState.draft)}
						draft={flagState.draft}
						onSave={flagState.saveNote}
						onClose={flagState.closeDraft}
					/>
				)}

				{!showEmpty && (
					<OutlinePanel
						open={settings.outlineOpen}
						headings={outline}
						flaggedHeadings={flaggedHeadings}
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

				{activeDocId && activeDocIsOwned && (
					<ShareDialog
						documentId={activeDocId}
						title={activeTitle}
						open={shareDialogOpen}
						onOpenChange={(open) => {
							setShareDialogOpen(open);
							if (!open) dispatchFocusEditor();
						}}
					/>
				)}

				<DeleteAccountDialog
					open={deleteAccountOpen}
					onOpenChange={(open) => {
						setDeleteAccountOpen(open);
						if (!open) dispatchFocusEditor();
					}}
					onDeleted={() => void handleAccountDeleted()}
				/>

				{activeDocId && activeDocIsOwned && (
					<ReviewSurface
						documentId={activeDocId}
						open={reviewOpen}
						onClose={() => {
							setReviewOpen(false);
							dispatchFocusEditor();
						}}
					/>
				)}

				{activeDocId && canComment && (
					<CommentsPanel
						documentId={activeDocId}
						open={commentsOpen}
						isOwner={activeDocIsOwned}
						draft={commentDraft}
						focusedCommentId={focusedCommentId}
						onClearFocusedComment={() => setFocusedCommentId(null)}
						onClearDraft={() => setCommentDraft(null)}
						onJumpToComment={(anchor) => {
							jumpToComment(anchor);
						}}
						onClose={() => {
							setCommentsOpen(false);
							setCommentDraft(null);
							setFocusedCommentId(null);
							dispatchFocusEditor();
						}}
					/>
				)}

				{effectiveAiEnabled && (
					<>
						<AiTransformPopover
							open={aiPopover.open}
							onOpenChange={(open) => {
								setAiPopover((p) => ({ ...p, open }));
								if (!open) {
									aiTransform.reset();
									dispatchFocusEditor();
								}
							}}
							selection={aiPopover.selection}
							state={aiTransform.state}
							onRun={runAiTransform}
							onAccept={aiTransform.accept}
							onReject={aiTransform.reject}
							onCancel={aiTransform.cancel}
							onReconcile={() => void aiTransform.reconcile()}
						/>
						<AiReviewPanel
							open={aiReviewOpen}
							review={aiReview}
							onClose={() => {
								setAiReviewOpen(false);
								dispatchFocusEditor();
							}}
							onOpenReview={() => {
								setAiReviewOpen(false);
								// Surface the AI feedback where human feedback lives: the
								// comments panel for comments (Phase A), and the review surface
								// for the AI suggestion branch (Phase B). The review surface
								// (owner-only) sits on top; the comments panel underneath.
								setCommentsOpen(true);
								if (activeDocId && activeDocIsOwned) setReviewOpen(true);
							}}
						/>
						<RelatedPassagesPanel
							open={relatedOpen}
							activeDocumentId={activeDocId}
							getSourceMarkdown={getActiveMarkdown}
							getQueryText={getActiveCaretSection}
							getSourceNodeId={() =>
								activeHistoryRef.current?.currentNodeId ?? null
							}
							onOpenPassage={openRelatedPassage}
							onClose={() => {
								setRelatedOpen(false);
								dispatchFocusEditor();
							}}
						/>
					</>
				)}

				<Toaster />
				<AiConsentDialog
					open={aiConsentOpen}
					busy={aiConsentBusy}
					error={aiConsentError}
					onOpenChange={(open) => {
						setAiConsentOpen(open);
						if (!open) setAiConsentError(null);
					}}
					onAccept={() => void handleAcceptAiConsent()}
				/>
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
