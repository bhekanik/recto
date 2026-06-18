"use client";

import { useCallback, useEffect, useState } from "react";

/** The writing-body typeface — the chrome is always sans. */
export type ReadingFont = "sans" | "serif";

/** Calm/ethereal colour themes. Each is a soft-coloured dark palette (D13). */
export type Theme = "twilight" | "aurora" | "dawn" | "moonlit";

/** How the history compare diff splits text. */
export type DiffGranularity = "word" | "line";
/** How the history compare diff is laid out. */
export type DiffLayout = "inline" | "side-by-side";

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
	};
}
