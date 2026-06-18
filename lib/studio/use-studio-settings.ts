"use client";

import { useCallback, useEffect, useState } from "react";

import type { GoalKind } from "@/lib/stats/streak";

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
	diffGranularity: "word",
	diffLayout: "inline",
	wordGoalTarget: 0,
	wordGoalKind: "at-least",
	dailyGoalTarget: 0,
	goalStyle: "ring",
	goalScope: "document",
};

const STORAGE_KEY = "recto:studio-settings";

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
	};
}
