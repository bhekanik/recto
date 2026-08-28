"use client";

import type { Id } from "@/convex/_generated/dataModel";
import type { ExportSource } from "@/lib/export";
import {
	copyAsMarkdown,
	copyAsRichText,
	exportDocxFile,
	exportHtmlFile,
	exportMarkdownFile,
} from "@/lib/export";
import type { HistoryController } from "@/lib/history/use-document-history";
import type { ActionId } from "@/lib/keyboard/actions";
import {
	dispatchModeSwitch,
	resolveModeAction,
} from "@/lib/keyboard/app-shortcuts";
import type { Mode } from "@/lib/modes/types";
import type { StudioSettingsApi } from "@/lib/studio/use-studio-settings";
import type { WorkspaceActions } from "@/lib/workspace/use-workspace-persistence";

type HistoryView = "tree" | "versions";

export type ActionMapDeps = {
	settings: StudioSettingsApi;
	actions: WorkspaceActions;
	isMobile: boolean;
	/** Live active-pane lens (for the cycle-next/prev actions). */
	getActiveMode: () => Mode;
	/** The active document's history controller (for undo/redo). */
	getController: () => HistoryController | null;
	handleCreate: () => void | Promise<void>;
	handleCheckpoint: () => void;
	handleReindex: () => void | Promise<void>;
	getExportSource: () => ExportSource | null;
	openFindReplace: () => void;
	summonAiTransform: () => void;
	summonAddComment: () => void;
	effectiveAiEnabled: boolean;
	activeDocId: Id<"documents"> | null;
	activeDocIsOwned: boolean;
	canComment: boolean;
	setCommandScope: (scope: "all" | "documents" | "headings") => void;
	setCommandOpen: (open: boolean) => void;
	setHistoryPanel: (panel: { open: boolean; view: HistoryView }) => void;
	setShareDialogOpen: (open: boolean) => void;
	setReviewOpen: (open: boolean) => void;
	setCommentsOpen: (updater: (v: boolean) => boolean) => void;
	setAiReviewOpen: (open: boolean) => void;
	setRelatedOpen: (open: boolean) => void;
	setStatusVisible: (updater: (v: boolean) => boolean) => void;
	setZen: (updater: (v: boolean) => boolean) => void;
	setGoalConfigOpen: (open: boolean) => void;
};

/**
 * The single application action registry (blueprint 13 §7.3.4): one
 * `Record<ActionId, () => void>` that both surfaces call directly — the command
 * palette / menu (via `onRunAction`) and the capture-phase keyboard handler. One
 * implementation per action; the keyboard handler routes its chord actions into
 * this same map (with a handful of parameterized / chord-only behaviors it owns
 * directly: palette/switcher open, spatial focus, the un-gated split, and the
 * parameterized mode switch/cycle).
 */
export function createActionMap(
	deps: ActionMapDeps,
): Record<ActionId, () => void> {
	const {
		settings,
		actions,
		isMobile,
		getActiveMode,
		getController,
		handleCreate,
		handleCheckpoint,
		handleReindex,
		getExportSource,
		openFindReplace,
		summonAiTransform,
		summonAddComment,
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
	} = deps;

	return {
		"new-document": () => void handleCreate(),
		"mode-rich": () => dispatchModeSwitch("rich"),
		"mode-raw": () => dispatchModeSwitch("raw"),
		"mode-vim": () => dispatchModeSwitch("vim"),
		"mode-preview": () => dispatchModeSwitch("preview"),
		"cycle-next": () =>
			dispatchModeSwitch(resolveModeAction(getActiveMode(), "next")),
		"cycle-prev": () =>
			dispatchModeSwitch(resolveModeAction(getActiveMode(), "prev")),
		"split-v": () => {
			// Splits are hidden on mobile (only the active pane renders), so
			// creating one would silently mutate an invisible tree.
			if (isMobile) return;
			actions.splitActivePane("vertical");
		},
		"split-h": () => {
			if (isMobile) return;
			actions.splitActivePane("horizontal");
		},
		"close-pane": () => actions.closeActivePane(),
		"focus-next": () => actions.focusNextPane(),
		"focus-prev": () => actions.focusPrevPane(),
		"go-to-heading": () => {
			setCommandScope("headings");
			setCommandOpen(true);
		},
		"toggle-outline": () => settings.toggleOutline(),
		checkpoint: () => handleCheckpoint(),
		"undo-tree": () => setHistoryPanel({ open: true, view: "tree" }),
		"version-history": () => setHistoryPanel({ open: true, view: "versions" }),
		undo: () => getController()?.undo(),
		redo: () => getController()?.redo(),
		"manage-sharing": () => {
			if (activeDocId && activeDocIsOwned) setShareDialogOpen(true);
		},
		"review-surface": () => {
			if (activeDocId && activeDocIsOwned) setReviewOpen(true);
		},
		"toggle-comments": () => {
			if (canComment) setCommentsOpen((v) => !v);
		},
		"add-comment": () => {
			if (canComment) summonAddComment();
		},
		"toggle-ai": () => settings.toggleAiEnabled(),
		"toggle-transform-mode": () => settings.toggleAiTransformMode(),
		"ai-transform": () => {
			if (effectiveAiEnabled) summonAiTransform();
		},
		"ai-critique": () => {
			// `effectiveAiEnabled` already folds in the 010 no-AI-on-shared gate
			// (settings.aiEnabled && !activeDocShared), so AI review only runs on
			// the owner's own un-shared doc — never on a shared/shared-with-me doc.
			if (effectiveAiEnabled) setAiReviewOpen(true);
		},
		"ai-related": () => {
			if (effectiveAiEnabled) setRelatedOpen(true);
		},
		"ai-reindex": () => {
			if (effectiveAiEnabled) void handleReindex();
		},
		"copy-rich": () => {
			const source = getExportSource();
			if (source) void copyAsRichText(source);
		},
		"copy-markdown": () => {
			const source = getExportSource();
			if (source) void copyAsMarkdown(source);
		},
		"export-md": () => {
			const source = getExportSource();
			if (source) exportMarkdownFile(source);
		},
		"export-html": () => {
			const source = getExportSource();
			if (source) exportHtmlFile(source);
		},
		"export-docx": () => {
			const source = getExportSource();
			if (source) void exportDocxFile(source);
		},
		"find-replace": () => openFindReplace(),
		"toggle-status": () => setStatusVisible((v) => !v),
		"toggle-focus": () => setZen((v) => !v),
		"toggle-font": () => settings.toggleReadingFont(),
		"zoom-in": () => settings.zoomIn(),
		"zoom-out": () => settings.zoomOut(),
		"zoom-reset": () => settings.zoomReset(),
		"toggle-spellcheck": () => settings.toggleSpellcheck(),
		"toggle-lint-passive": () => settings.toggleLintCategory("passive"),
		"toggle-lint-readability": () => settings.toggleLintCategory("readability"),
		"toggle-lint-adverb": () => settings.toggleLintCategory("adverb"),
		"toggle-lint-weasel": () => settings.toggleLintCategory("weasel"),
		"toggle-smart-paste": () => settings.toggleSmartPaste(),
		"toggle-toolbar": () => settings.toggleTopToolbar(),
		"toggle-typewriter": () => settings.toggleTypewriter(),
		"toggle-focus-dim": () => settings.toggleFocusDim(),
		"cycle-dim-scope": () => settings.cycleFocusDimScope(),
		"toggle-email-preview": () => settings.togglePreviewVariant(),
		"set-goal": () => setGoalConfigOpen(true),
		"toggle-goal-style": () => settings.toggleGoalStyle(),
		"toggle-goal-scope": () => settings.toggleGoalScope(),
		"appearance-system": () => settings.setAppearance("system"),
		"appearance-light": () => settings.setAppearance("light"),
		"appearance-dark": () => settings.setAppearance("dark"),
		"theme-twilight": () => settings.setTheme("twilight"),
		"theme-aurora": () => settings.setTheme("aurora"),
		"theme-dawn": () => settings.setTheme("dawn"),
		"theme-moonlit": () => settings.setTheme("moonlit"),
	};
}
