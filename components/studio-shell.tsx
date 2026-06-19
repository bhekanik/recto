"use client";

import { useClerk } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Command as CommandIcon, GitBranch } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { AiReviewPanel } from "@/components/ai/ai-review-panel";
import {
	AiTransformPopover,
	type AiTransformRequest,
} from "@/components/ai/ai-transform-popover";
import { RelatedPassagesPanel } from "@/components/ai/related-passages-panel";
import { CommandPalette } from "@/components/command-palette";
import { DocumentSwitcher } from "@/components/document-switcher";
import { EmptyState } from "@/components/empty-state";
import {
	HistoryPanel,
	type HistoryView,
} from "@/components/history/history-panel";
import { OutlinePanel } from "@/components/outline/outline-panel";
import {
	type CommentDraft,
	CommentsPanel,
} from "@/components/review/comments-panel";
import { ReviewSurface } from "@/components/review/review-surface";
import { ShareDialog } from "@/components/share-dialog";
import { StatusBar } from "@/components/status-bar";
import { Toaster } from "@/components/toaster";
import { TopFormatToolbar } from "@/components/top-format-toolbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RenderPaneNode } from "@/components/workspace/render-pane-node";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { TransformRange } from "@/lib/ai/apply-transform";
import { AI_TRANSFORM_SUMMON_EVENT, setAiEnabledMirror } from "@/lib/ai/summon";
import { useAiReview } from "@/lib/ai/use-ai-review";
import { useAiTransform } from "@/lib/ai/use-ai-transform";
import { useRag } from "@/lib/ai/use-rag";
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
import { readingTimeMinutes } from "@/lib/markdown";
import { caretAtOffset } from "@/lib/modes/caret";
import { extractOutline } from "@/lib/outline/extract";
import { scrollRootToHeadingIndex } from "@/lib/outline/scroll-to-heading";
import {
	type CommentAnchor,
	createAnchor,
	locateAnchor,
} from "@/lib/review/anchor";
import type { CommentHighlight } from "@/lib/review/comment-decorations-cm";
import type { CommentMark } from "@/lib/review/comment-decorations-pm";
import {
	ADD_COMMENT_SUMMON_EVENT,
	dispatchSetComments,
	setCommentingEnabledMirror,
	subscribeOpenComment,
} from "@/lib/review/summon";
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
	// Live mirror of the active lens for the (stable) shortcut handler, so the
	// find chord can fall through to native page find in the read-only preview
	// lens without re-subscribing the keydown listener on every mode switch.
	const activeModeRef = useRef(activeMode);
	activeModeRef.current = activeMode;
	const activeDocId = activeLeaf?.documentId ?? null;
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
	const activeDocShared = activeShareState?.shared ?? false;
	// The owner can manage sharing; a grantee cannot.
	const activeDocIsOwned =
		activeShareState === undefined || activeShareState === null
			? true
			: activeShareState.role === "owner";
	const effectiveAiEnabled = settings.aiEnabled && !activeDocShared;
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
	const [commentsOpen, setCommentsOpen] = useState(false);
	const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
	// A comment to scroll into view + flash in the panel, set when its editor
	// highlight is clicked (editor→panel). The panel clears it after the flash.
	const [focusedCommentId, setFocusedCommentId] = useState<string | null>(null);

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

	// --- AI features (plan 009) — gated behind settings.aiEnabled AND the active
	// document not being shared for review (plan 010). Keep the out-of-tree
	// selection toolbar's AI button in sync with the EFFECTIVE flag so it hides on
	// a shared document.
	useEffect(() => {
		setAiEnabledMirror(effectiveAiEnabled);
	}, [effectiveAiEnabled]);

	// Read the live markdown of the active document from its primary handle.
	const getActiveMarkdown = useCallback((): string => {
		if (!activeDocId || !workspace) return "";
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		return handle?.getCanonicalMarkdown() ?? activeSync?.markdown ?? "";
	}, [activeDocId, workspace, registry, activeSync]);

	// --- Comments (plan 010 Phase B) ---------------------------------------
	// Read comments for the active doc (reader only — never rebinds the editor's
	// document value). Keep the out-of-tree selection toolbar's "comment" button in
	// sync with whether commenting is available on the active doc.
	useEffect(() => {
		setCommentingEnabledMirror(canComment);
	}, [canComment]);

	const activeComments = useQuery(
		api.review.listComments,
		activeDocId && canComment ? { documentId: activeDocId } : "skip",
	);
	const activeCommentsRef = useRef(activeComments);
	activeCommentsRef.current = activeComments;

	// Locate each comment's anchor in the live canonical markdown and push the
	// resulting highlights to the active pane's editors. Orphaned comments (anchor
	// lost → locateAnchor returns null) carry no highlight but still render in the
	// panel. Debounced off the typing hot path; re-derived from the live editor text.
	const pushCommentHighlights = useCallback(() => {
		const comments = activeCommentsRef.current;
		if (!comments) {
			dispatchSetComments({ cm: [], pm: [] });
			return;
		}
		const markdown = getActiveMarkdown();
		const cm: CommentHighlight[] = [];
		const pm: CommentMark[] = [];
		for (const c of comments) {
			// Only top-level comments carry a highlight (replies share the thread).
			if (c.threadParentId) continue;
			const anchor = c.anchor as CommentAnchor;
			const range = locateAnchor(markdown, anchor);
			if (!range) continue; // orphaned — no highlight
			cm.push({
				commentId: c._id,
				from: range.from,
				to: range.to,
				resolved: c.resolved,
			});
			pm.push({
				commentId: c._id,
				quote: anchor.quote,
				resolved: c.resolved,
			});
		}
		dispatchSetComments({ cm, pm });
	}, [getActiveMarkdown]);

	const debouncedPushComments = useDebouncedCallback(
		pushCommentHighlights,
		250,
	);

	// Re-derive highlights whenever the comment set changes or the doc text changes
	// (the synced markdown is the change signal; the push re-reads the live handle).
	const syncedMarkdownForComments = activeSync?.markdown ?? "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeComments + the synced markdown are the change SIGNALS; the debounced push re-reads the live handle and the latest comments ref
	useEffect(() => {
		debouncedPushComments();
	}, [activeComments, syncedMarkdownForComments, debouncedPushComments]);

	// Scroll the active editor to a comment's anchor (offset-exact in CM; a
	// best-effort caret in Milkdown), mirroring jumpToHeading.
	const jumpToComment = useCallback(
		(anchor: CommentAnchor) => {
			if (!activeDocId || !workspace) return;
			const handle = registry.getPrimaryHandle(
				activeDocId,
				workspace.activePaneId,
			);
			if (!handle) return;
			const md = handle.getCanonicalMarkdown();
			const range = locateAnchor(md, anchor);
			if (!range) return; // orphaned — nothing to scroll to
			handle.importCaret(caretAtOffset(range.from, md.length));
			handle.focus();
		},
		[activeDocId, workspace, registry],
	);

	// Capture the active editor's selection into a comment draft + open the panel.
	// raw/vim: exportCaret offsets ARE markdown offsets. rich: serialize the selected
	// slice to markdown for the quote, then locate it in the canonical to get offsets
	// for prefix/suffix context. preview has no editable selection.
	const summonAddComment = useCallback(() => {
		if (!canComment || !activeDocId || !workspace) return;
		const mode = activeLeaf?.mode ?? "rich";
		if (mode === "preview") {
			setCommentsOpen(true);
			window.alert(
				"To anchor a comment, select text in Rich, Raw, or Vim. (Switch lens, select, then add a comment.)",
			);
			return;
		}
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		if (!handle) return;
		const md = handle.getCanonicalMarkdown();

		let anchor: CommentAnchor | null = null;
		if (mode === "rich") {
			const selected = handle.getSelectedMarkdown?.() ?? null;
			if (selected) {
				// Locate the selected text in the canonical to capture prefix/suffix.
				const idx = md.indexOf(selected);
				anchor =
					idx >= 0
						? createAnchor(md, idx, idx + selected.length)
						: {
								quote: selected.slice(0, 200),
								prefix: "",
								suffix: "",
								offsetHint: 0,
							};
			}
		} else {
			const caret = handle.exportCaret();
			const from = Math.min(caret.anchor, caret.head);
			const to = Math.max(caret.anchor, caret.head);
			if (from !== to) anchor = createAnchor(md, from, to);
		}

		if (!anchor?.quote.trim()) {
			setCommentsOpen(true);
			window.alert("Select some text first, then add a comment.");
			return;
		}
		setCommentDraft({ anchor });
		setCommentsOpen(true);
	}, [canComment, activeDocId, workspace, activeLeaf, registry]);

	useEffect(() => {
		const onSummon = () => summonAddComment();
		window.addEventListener(ADD_COMMENT_SUMMON_EVENT, onSummon);
		return () => window.removeEventListener(ADD_COMMENT_SUMMON_EVENT, onSummon);
	}, [summonAddComment]);

	// Clicking a comment highlight in either editor (editor→panel) opens the panel
	// and focuses that comment so the panel can scroll + flash it. Gated on
	// canComment so a non-commenter's click is a harmless no-op (the panel is
	// only rendered when canComment anyway).
	useEffect(() => {
		if (!canComment) return;
		return subscribeOpenComment((commentId) => {
			setCommentsOpen(true);
			setFocusedCommentId(commentId);
		});
	}, [canComment]);

	const aiTransform = useAiTransform({
		getController: () => activeHistoryRef.current,
		getDocMarkdown: getActiveMarkdown,
		mode: settings.aiTransformMode,
	});
	const [aiPopover, setAiPopover] = useState<{
		open: boolean;
		selection: { text: string; range: TransformRange } | null;
	}>({ open: false, selection: null });
	// AI reviewer (plan 011): on the owner's own un-shared doc, the AI leaves real
	// anchored comments through plan 010's primitives (it runs as the owner over
	// their own doc; the no-AI-on-shared gate below keeps it off shared docs).
	const aiReview = useAiReview({
		documentId: activeDocId,
		getDocMarkdown: getActiveMarkdown,
	});
	const [aiReviewOpen, setAiReviewOpen] = useState(false);
	const [relatedOpen, setRelatedOpen] = useState(false);

	const { reindexDocument } = useRag();

	// Summon the AI transform over the current selection. Works in the CodeMirror
	// lenses (raw/vim) — where exportCaret offsets ARE markdown offsets — and in the
	// rich (Milkdown) lens, where the handle serializes the selected slice to
	// markdown (no position→offset math). Preview has no editable selection.
	const summonAiTransform = useCallback(() => {
		if (!effectiveAiEnabled) return;
		const mode = activeLeaf?.mode ?? "rich";
		if (mode === "preview") {
			window.alert(
				"AI transform needs an editable selection. Switch to Rich, Raw, or Vim, select text, and try again.",
			);
			return;
		}
		if (!activeDocId || !workspace) return;
		const handle = registry.getPrimaryHandle(
			activeDocId,
			workspace.activePaneId,
		);
		if (!handle) return;

		if (mode === "rich") {
			// Rich lens: serialize the live selection to canonical markdown. The
			// offset range is unused on this path (richReplace splices via a PM
			// transaction at commit time), so carry a placeholder range.
			const text = handle.getSelectedMarkdown?.() ?? null;
			if (!text) {
				window.alert("Select some text first, then summon the AI transform.");
				return;
			}
			aiTransform.reset();
			setAiPopover({
				open: true,
				selection: { text, range: { from: 0, to: 0 } },
			});
			return;
		}

		const caret = handle.exportCaret();
		const from = Math.min(caret.anchor, caret.head);
		const to = Math.max(caret.anchor, caret.head);
		if (from === to) {
			window.alert("Select some text first, then summon the AI transform.");
			return;
		}
		const doc = handle.getCanonicalMarkdown();
		const text = doc.slice(from, to);
		aiTransform.reset();
		setAiPopover({ open: true, selection: { text, range: { from, to } } });
	}, [
		effectiveAiEnabled,
		activeLeaf,
		activeDocId,
		workspace,
		registry,
		aiTransform,
	]);

	// The selection toolbar's AI button (out of tree) summons via this event.
	useEffect(() => {
		const onSummon = () => summonAiTransform();
		window.addEventListener(AI_TRANSFORM_SUMMON_EVENT, onSummon);
		return () =>
			window.removeEventListener(AI_TRANSFORM_SUMMON_EVENT, onSummon);
	}, [summonAiTransform]);

	const runAiTransform = useCallback(
		(req: AiTransformRequest) => {
			// Rich lens: hand the transform a closure that splices the AI text into
			// the live ProseMirror selection and returns the new full canonical
			// markdown (committed once by the hook). raw/vim use the offset path.
			const mode = activeLeaf?.mode ?? "rich";
			const richReplace =
				mode === "rich"
					? (aiText: string): string | null => {
							if (!activeDocId || !workspace) return null;
							const handle = registry.getPrimaryHandle(
								activeDocId,
								workspace.activePaneId,
							);
							return handle?.replaceSelectionMarkdown?.(aiText) ?? null;
						}
					: undefined;
			void aiTransform.transform({
				instruction: req.instruction,
				instructionLabel: req.instructionLabel,
				range: req.range,
				selection: req.selection,
				richReplace,
			});
		},
		[aiTransform, activeLeaf, activeDocId, workspace, registry],
	);

	// "Re-index this draft for search" (Phase C) — chunk + embed via the Next
	// route, persist to Convex. Runs on demand, never per keystroke.
	const handleReindex = useCallback(async () => {
		if (!effectiveAiEnabled || !activeDocId) return;
		const history = activeHistoryRef.current;
		const currentNodeId = history?.currentNodeId;
		if (!currentNodeId) return;
		const markdown = getActiveMarkdown();
		try {
			const count = await reindexDocument({
				documentId: activeDocId,
				currentNodeId,
				markdown,
			});
			window.alert(`Indexed ${count} passage${count === 1 ? "" : "s"}.`);
		} catch (err) {
			window.alert(`Re-index failed: ${(err as Error).message}`);
		}
	}, [effectiveAiEnabled, activeDocId, getActiveMarkdown, reindexDocument]);

	// Open a cited related passage: switch the active pane to that doc, then jump
	// to the passage offset once the editor has mounted + seeded.
	const openRelatedPassage = useCallback(
		(documentId: Id<"documents">, charStart: number) => {
			if (!workspace?.activePaneId) return;
			actions.setPaneDocument(workspace.activePaneId, documentId);
			setRelatedOpen(false);
			// Defer the caret jump until the editor for the new doc is mounted.
			let tries = 0;
			const tryJump = () => {
				const handle = registry.getPrimaryHandle(
					documentId,
					workspace.activePaneId,
				);
				if (handle) {
					const md = handle.getCanonicalMarkdown();
					handle.importCaret(caretAtOffset(charStart, md.length));
					handle.focus();
					return;
				}
				if (tries++ < 40) requestAnimationFrame(tryJump);
			};
			requestAnimationFrame(tryJump);
		},
		[workspace, actions, registry],
	);

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
				case "manage-sharing":
					if (activeDocId && activeDocIsOwned) setShareDialogOpen(true);
					return;
				case "review-surface":
					if (activeDocId && activeDocIsOwned) setReviewOpen(true);
					return;
				case "toggle-comments":
					if (canComment) setCommentsOpen((v) => !v);
					return;
				case "add-comment":
					if (canComment) summonAddComment();
					return;
				case "toggle-ai":
					settings.toggleAiEnabled();
					return;
				case "ai-transform":
					if (effectiveAiEnabled) summonAiTransform();
					return;
				case "ai-critique":
					// `effectiveAiEnabled` already folds in the 010 no-AI-on-shared gate
					// (settings.aiEnabled && !activeDocShared), so AI review only runs on
					// the owner's own un-shared doc — never on a shared/shared-with-me doc.
					if (effectiveAiEnabled) setAiReviewOpen(true);
					return;
				case "ai-related":
					if (effectiveAiEnabled) setRelatedOpen(true);
					return;
				case "ai-reindex":
					if (effectiveAiEnabled) void handleReindex();
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
				case "toggle-smart-paste":
					settings.toggleSmartPaste();
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
				case "toggle-email-preview":
					settings.togglePreviewVariant();
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
			summonAiTransform,
			handleReindex,
			effectiveAiEnabled,
			activeDocId,
			activeDocIsOwned,
			canComment,
			summonAddComment,
		],
	);

	const dispatchRef = useRef(dispatch);
	dispatchRef.current = dispatch;

	useEffect(() => {
		if (!workspace) return;

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
							readingMinutes={readingTimeMinutes(activeSync.wordCount)}
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
					aiEnabled={effectiveAiEnabled}
					canManageSharing={activeDocId !== null && activeDocIsOwned}
					canReview={activeDocId !== null && canReview}
					canComment={canComment}
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
							getQueryText={getActiveMarkdown}
							onOpenPassage={openRelatedPassage}
							onClose={() => {
								setRelatedOpen(false);
								dispatchFocusEditor();
							}}
						/>
					</>
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
