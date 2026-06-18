"use client";

import { useCallback, useEffect, useState } from "react";

import type { FocusScope } from "@/lib/editor/focus-range";
import {
	ALL_CATEGORIES,
	type LintCategory,
	type LintOptions,
} from "@/lib/lint";
import type { GoalKind } from "@/lib/stats/streak";

export type { FocusScope, LintCategory, LintOptions };

/** The writing-body typeface — the chrome is always sans. */
export type ReadingFont = "sans" | "serif";

/** Calm/ethereal colour themes. Each is a soft-coloured dark palette (D13). */
export type Theme = "twilight" | "aurora" | "dawn" | "moonlit";

/** How the history compare diff splits text. */
export type DiffGranularity = "word" | "line";
/** How the history compare diff is laid out. */
export type DiffLayout = "inline" | "side-by-side";

/** Goal widget shape in the status bar (A/B toggle 1). */
export type GoalStyle = "ring" | "bar";
/** Which goal the status-bar widget tracks (A/B toggle 2). */
export type GoalScope = "document" | "daily";

/**
 * What the preview mode renders: the standard rendered Markdown, or the
 * inbox/email render (subject + preheader chrome + email-safe inline-CSS body).
 * A switchable variant of preview mode — not a fifth mode (plan 008).
 */
export type PreviewVariant = "rendered" | "email";

/**
 * How an accepted AI transform lands (plan 009 — switchable A/B fork, never a
 * hard pick). `"replace"`: the AI node becomes the tip immediately (reject =
 * undo). `"pending"`: the AI node still lands (reversible by construction) but
 * the UI shows an explicit accept/reject affordance and auto-undoes on reject.
 */
export type AiTransformMode = "pending" | "replace";

const GOAL_KINDS: GoalKind[] = ["at-least", "about", "at-most"];

/** Clamp a goal target to a non-negative integer (0 = no goal). */
function clampGoalTarget(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.round(value));
}

/** Ordered for the cycle control + command palette; first is the default. */
export const THEMES: { id: Theme; label: string; hint: string }[] = [
	{ id: "twilight", label: "Twilight", hint: "indigo · periwinkle" },
	{ id: "aurora", label: "Aurora", hint: "teal · aqua-mint" },
	{ id: "dawn", label: "Dawn", hint: "charcoal · rose-lavender" },
	{ id: "moonlit", label: "Moonlit", hint: "near-black · silver-cyan" },
];

const THEME_IDS = THEMES.map((t) => t.id);

export type StudioSettings = {
	/** Soft-coloured dark palette for the whole studio. */
	theme: Theme;
	/** Body typeface for the writing surface (Bear sans / Substack serif). */
	readingFont: ReadingFont;
	/** Text-zoom multiplier for the reading column (not the font size — the whole column). */
	readingScale: number;
	/** Native browser spellcheck squigglies in the editors. */
	spellcheck: boolean;
	/** Persistent top formatting toolbar visibility. */
	topToolbar: boolean;
	/** Convert pasted rich HTML (Word/Docs/web) into canonical Markdown on paste. */
	smartPaste: boolean;
	/** Granularity of the history compare diff (word = prose standard). */
	diffGranularity: DiffGranularity;
	/** Layout of the history compare diff. */
	diffLayout: DiffLayout;
	/** Per-document word goal target (0 = no goal). Per-device preference. */
	wordGoalTarget: number;
	/** Direction of the word goal (at-least / about / at-most). */
	wordGoalKind: GoalKind;
	/** Optional daily word goal target (0 = no daily goal). Per-device preference. */
	dailyGoalTarget: number;
	/** Goal widget display: ring or bar (A/B toggle 1). */
	goalStyle: GoalStyle;
	/** Which goal the status-bar widget tracks: document or daily (A/B toggle 2). */
	goalScope: GoalScope;
	/** Typewriter scrolling — keep the caret line vertically centered (plan 003). */
	typewriter: boolean;
	/** Focus dimming — fade everything but the active sentence/paragraph. */
	focusDim: boolean;
	/** Granularity of the focus-dim highlight (A/B toggle). */
	focusDimScope: FocusScope;
	/** Prose linter on/off (plan 004) — opt-in highlight-only, off by default. */
	lint: boolean;
	/** Per-category lint toggles (passive / readability / adverb / weasel). */
	lintCategories: LintOptions;
	/** Docked document-outline panel visibility (plan 005). */
	outlineOpen: boolean;
	/** Preview-mode render: rendered Markdown or the inbox/email preview (plan 008). */
	previewVariant: PreviewVariant;
	/** Master gate for all AI features (plan 009) — opt-in, OFF by default. */
	aiEnabled: boolean;
	/** How an accepted AI transform lands (switchable A/B fork; plan 009). */
	aiTransformMode: AiTransformMode;
};

export const READING_SCALE_MIN = 0.8;
export const READING_SCALE_MAX = 2.0;
const READING_SCALE_STEP = 0.1;

const DEFAULTS: StudioSettings = {
	theme: "twilight",
	readingFont: "sans",
	readingScale: 1,
	spellcheck: true,
	topToolbar: true,
	// Smart paste defaults ON — pasting from Word/Docs/web should land as clean
	// canonical Markdown, not raw style spans (plan 007).
	smartPaste: true,
	diffGranularity: "word",
	diffLayout: "inline",
	wordGoalTarget: 0,
	wordGoalKind: "at-least",
	dailyGoalTarget: 0,
	goalStyle: "ring",
	goalScope: "document",
	// Focus mode is opt-in — off by default so the studio looks unchanged on first run.
	typewriter: false,
	focusDim: false,
	focusDimScope: "sentence",
	// Prose linter is opt-in — off by default (highlighting fights minimalism); all
	// categories on once enabled, each individually toggleable.
	lint: false,
	lintCategories: {
		passive: true,
		readability: true,
		adverb: true,
		weasel: true,
	},
	// Outline panel is closed by default — it docks over the canvas on demand.
	outlineOpen: false,
	// Preview mode shows the rendered Markdown by default; the email/inbox preview
	// is opt-in (a newsletter-specific lens), toggled per device.
	previewVariant: "rendered",
	// AI features are opt-in — OFF by default so the studio is unchanged on first
	// run and AI is never ambient (plan 009; AUGMENT, don't replace).
	aiEnabled: false,
	// Default to the safer "pending" confirm UX for AI transforms (plan 009).
	aiTransformMode: "pending",
};

const STORAGE_KEY = "recto:studio-settings";

/** Coerce a stored lint-categories blob to a complete, boolean-valued map. */
function loadLintCategories(value: unknown): LintOptions {
	const source =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const result = {} as LintOptions;
	for (const category of ALL_CATEGORIES) {
		const stored = source[category];
		// Default each category to on (the only way to turn one off is to opt out).
		result[category] = typeof stored === "boolean" ? stored : true;
	}
	return result;
}

function clampScale(value: number): number {
	const clamped = Math.min(
		READING_SCALE_MAX,
		Math.max(READING_SCALE_MIN, value),
	);
	// Avoid float drift (e.g. 0.7999999) so the displayed % is clean.
	return Math.round(clamped * 100) / 100;
}

function loadSettings(): StudioSettings {
	if (typeof window === "undefined") return DEFAULTS;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return DEFAULTS;
		const parsed = JSON.parse(raw) as Partial<StudioSettings>;
		return {
			theme:
				parsed.theme && THEME_IDS.includes(parsed.theme)
					? parsed.theme
					: DEFAULTS.theme,
			readingFont: parsed.readingFont === "serif" ? "serif" : "sans",
			readingScale:
				typeof parsed.readingScale === "number"
					? clampScale(parsed.readingScale)
					: DEFAULTS.readingScale,
			spellcheck:
				typeof parsed.spellcheck === "boolean"
					? parsed.spellcheck
					: DEFAULTS.spellcheck,
			topToolbar:
				typeof parsed.topToolbar === "boolean"
					? parsed.topToolbar
					: DEFAULTS.topToolbar,
			smartPaste:
				typeof parsed.smartPaste === "boolean"
					? parsed.smartPaste
					: DEFAULTS.smartPaste,
			diffGranularity: parsed.diffGranularity === "line" ? "line" : "word",
			diffLayout:
				parsed.diffLayout === "side-by-side" ? "side-by-side" : "inline",
			wordGoalTarget:
				typeof parsed.wordGoalTarget === "number"
					? clampGoalTarget(parsed.wordGoalTarget)
					: DEFAULTS.wordGoalTarget,
			wordGoalKind:
				parsed.wordGoalKind && GOAL_KINDS.includes(parsed.wordGoalKind)
					? parsed.wordGoalKind
					: DEFAULTS.wordGoalKind,
			dailyGoalTarget:
				typeof parsed.dailyGoalTarget === "number"
					? clampGoalTarget(parsed.dailyGoalTarget)
					: DEFAULTS.dailyGoalTarget,
			goalStyle: parsed.goalStyle === "bar" ? "bar" : "ring",
			goalScope: parsed.goalScope === "daily" ? "daily" : "document",
			typewriter:
				typeof parsed.typewriter === "boolean"
					? parsed.typewriter
					: DEFAULTS.typewriter,
			focusDim:
				typeof parsed.focusDim === "boolean"
					? parsed.focusDim
					: DEFAULTS.focusDim,
			focusDimScope:
				parsed.focusDimScope === "paragraph" ? "paragraph" : "sentence",
			lint: typeof parsed.lint === "boolean" ? parsed.lint : DEFAULTS.lint,
			lintCategories: loadLintCategories(parsed.lintCategories),
			outlineOpen:
				typeof parsed.outlineOpen === "boolean"
					? parsed.outlineOpen
					: DEFAULTS.outlineOpen,
			previewVariant: parsed.previewVariant === "email" ? "email" : "rendered",
			aiEnabled:
				typeof parsed.aiEnabled === "boolean"
					? parsed.aiEnabled
					: DEFAULTS.aiEnabled,
			aiTransformMode:
				parsed.aiTransformMode === "replace" ? "replace" : "pending",
		};
	} catch {
		return DEFAULTS;
	}
}

export type StudioSettingsApi = StudioSettings & {
	setTheme: (theme: Theme) => void;
	cycleTheme: () => void;
	toggleReadingFont: () => void;
	setReadingFont: (font: ReadingFont) => void;
	zoomIn: () => void;
	zoomOut: () => void;
	zoomReset: () => void;
	toggleSpellcheck: () => void;
	toggleTopToolbar: () => void;
	toggleSmartPaste: () => void;
	setDiffGranularity: (g: DiffGranularity) => void;
	toggleDiffGranularity: () => void;
	setDiffLayout: (l: DiffLayout) => void;
	toggleDiffLayout: () => void;
	setWordGoalTarget: (target: number) => void;
	setWordGoalKind: (kind: GoalKind) => void;
	setDailyGoalTarget: (target: number) => void;
	setGoalStyle: (style: GoalStyle) => void;
	toggleGoalStyle: () => void;
	setGoalScope: (scope: GoalScope) => void;
	toggleGoalScope: () => void;
	toggleTypewriter: () => void;
	toggleFocusDim: () => void;
	setFocusDimScope: (scope: FocusScope) => void;
	cycleFocusDimScope: () => void;
	toggleLint: () => void;
	toggleLintCategory: (category: LintCategory) => void;
	toggleOutline: () => void;
	setOutlineOpen: (open: boolean) => void;
	setPreviewVariant: (variant: PreviewVariant) => void;
	togglePreviewVariant: () => void;
	setAiEnabled: (enabled: boolean) => void;
	toggleAiEnabled: () => void;
	setAiTransformMode: (mode: AiTransformMode) => void;
	toggleAiTransformMode: () => void;
};

/**
 * Persisted, user-tunable writing-surface settings. The user prefers knobs over
 * fixed picks (font, zoom, spellcheck, chrome) — each is a remembered toggle.
 */
export function useStudioSettings(): StudioSettingsApi {
	// Studio only renders client-side (after auth), so a lazy initializer reading
	// localStorage is safe and avoids a settings flash on mount.
	const [settings, setSettings] = useState<StudioSettings>(loadSettings);

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch {
			// Private mode / quota — settings simply won't persist.
		}
	}, [settings]);

	const setTheme = useCallback((theme: Theme) => {
		setSettings((s) => ({ ...s, theme }));
	}, []);

	const cycleTheme = useCallback(() => {
		setSettings((s) => {
			const i = THEME_IDS.indexOf(s.theme);
			const next = THEME_IDS[(i + 1) % THEME_IDS.length] ?? s.theme;
			return { ...s, theme: next };
		});
	}, []);

	const setReadingFont = useCallback((readingFont: ReadingFont) => {
		setSettings((s) => ({ ...s, readingFont }));
	}, []);

	const toggleReadingFont = useCallback(() => {
		setSettings((s) => ({
			...s,
			readingFont: s.readingFont === "sans" ? "serif" : "sans",
		}));
	}, []);

	const zoomIn = useCallback(() => {
		setSettings((s) => ({
			...s,
			readingScale: clampScale(s.readingScale + READING_SCALE_STEP),
		}));
	}, []);

	const zoomOut = useCallback(() => {
		setSettings((s) => ({
			...s,
			readingScale: clampScale(s.readingScale - READING_SCALE_STEP),
		}));
	}, []);

	const zoomReset = useCallback(() => {
		setSettings((s) => ({ ...s, readingScale: 1 }));
	}, []);

	const toggleSpellcheck = useCallback(() => {
		setSettings((s) => ({ ...s, spellcheck: !s.spellcheck }));
	}, []);

	const toggleTopToolbar = useCallback(() => {
		setSettings((s) => ({ ...s, topToolbar: !s.topToolbar }));
	}, []);

	const toggleSmartPaste = useCallback(() => {
		setSettings((s) => ({ ...s, smartPaste: !s.smartPaste }));
	}, []);

	const setDiffGranularity = useCallback((diffGranularity: DiffGranularity) => {
		setSettings((s) => ({ ...s, diffGranularity }));
	}, []);

	const toggleDiffGranularity = useCallback(() => {
		setSettings((s) => ({
			...s,
			diffGranularity: s.diffGranularity === "word" ? "line" : "word",
		}));
	}, []);

	const setDiffLayout = useCallback((diffLayout: DiffLayout) => {
		setSettings((s) => ({ ...s, diffLayout }));
	}, []);

	const toggleDiffLayout = useCallback(() => {
		setSettings((s) => ({
			...s,
			diffLayout: s.diffLayout === "inline" ? "side-by-side" : "inline",
		}));
	}, []);

	const setWordGoalTarget = useCallback((target: number) => {
		setSettings((s) => ({ ...s, wordGoalTarget: clampGoalTarget(target) }));
	}, []);

	const setWordGoalKind = useCallback((wordGoalKind: GoalKind) => {
		setSettings((s) => ({ ...s, wordGoalKind }));
	}, []);

	const setDailyGoalTarget = useCallback((target: number) => {
		setSettings((s) => ({ ...s, dailyGoalTarget: clampGoalTarget(target) }));
	}, []);

	const setGoalStyle = useCallback((goalStyle: GoalStyle) => {
		setSettings((s) => ({ ...s, goalStyle }));
	}, []);

	const toggleGoalStyle = useCallback(() => {
		setSettings((s) => ({
			...s,
			goalStyle: s.goalStyle === "ring" ? "bar" : "ring",
		}));
	}, []);

	const setGoalScope = useCallback((goalScope: GoalScope) => {
		setSettings((s) => ({ ...s, goalScope }));
	}, []);

	const toggleGoalScope = useCallback(() => {
		setSettings((s) => ({
			...s,
			goalScope: s.goalScope === "document" ? "daily" : "document",
		}));
	}, []);

	const toggleTypewriter = useCallback(() => {
		setSettings((s) => ({ ...s, typewriter: !s.typewriter }));
	}, []);

	const toggleFocusDim = useCallback(() => {
		setSettings((s) => ({ ...s, focusDim: !s.focusDim }));
	}, []);

	const setFocusDimScope = useCallback((focusDimScope: FocusScope) => {
		setSettings((s) => ({ ...s, focusDimScope }));
	}, []);

	const cycleFocusDimScope = useCallback(() => {
		setSettings((s) => ({
			...s,
			focusDimScope: s.focusDimScope === "sentence" ? "paragraph" : "sentence",
		}));
	}, []);

	const toggleLint = useCallback(() => {
		setSettings((s) => ({ ...s, lint: !s.lint }));
	}, []);

	const toggleLintCategory = useCallback((category: LintCategory) => {
		setSettings((s) => ({
			...s,
			lintCategories: {
				...s.lintCategories,
				[category]: !s.lintCategories[category],
			},
		}));
	}, []);

	const toggleOutline = useCallback(() => {
		setSettings((s) => ({ ...s, outlineOpen: !s.outlineOpen }));
	}, []);

	const setOutlineOpen = useCallback((outlineOpen: boolean) => {
		setSettings((s) => ({ ...s, outlineOpen }));
	}, []);

	const setPreviewVariant = useCallback((previewVariant: PreviewVariant) => {
		setSettings((s) => ({ ...s, previewVariant }));
	}, []);

	const togglePreviewVariant = useCallback(() => {
		setSettings((s) => ({
			...s,
			previewVariant: s.previewVariant === "rendered" ? "email" : "rendered",
		}));
	}, []);

	const setAiEnabled = useCallback((aiEnabled: boolean) => {
		setSettings((s) => ({ ...s, aiEnabled }));
	}, []);

	const toggleAiEnabled = useCallback(() => {
		setSettings((s) => ({ ...s, aiEnabled: !s.aiEnabled }));
	}, []);

	const setAiTransformMode = useCallback((aiTransformMode: AiTransformMode) => {
		setSettings((s) => ({ ...s, aiTransformMode }));
	}, []);

	const toggleAiTransformMode = useCallback(() => {
		setSettings((s) => ({
			...s,
			aiTransformMode: s.aiTransformMode === "pending" ? "replace" : "pending",
		}));
	}, []);

	return {
		...settings,
		setTheme,
		cycleTheme,
		toggleReadingFont,
		setReadingFont,
		zoomIn,
		zoomOut,
		zoomReset,
		toggleSpellcheck,
		toggleTopToolbar,
		toggleSmartPaste,
		setDiffGranularity,
		toggleDiffGranularity,
		setDiffLayout,
		toggleDiffLayout,
		setWordGoalTarget,
		setWordGoalKind,
		setDailyGoalTarget,
		setGoalStyle,
		toggleGoalStyle,
		setGoalScope,
		toggleGoalScope,
		toggleTypewriter,
		toggleFocusDim,
		setFocusDimScope,
		cycleFocusDimScope,
		toggleLint,
		toggleLintCategory,
		toggleOutline,
		setOutlineOpen,
		setPreviewVariant,
		togglePreviewVariant,
		setAiEnabled,
		toggleAiEnabled,
		setAiTransformMode,
		toggleAiTransformMode,
	};
}
