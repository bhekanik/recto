"use client";

import { useCallback, useEffect, useState } from "react";

/** The writing-body typeface — the chrome is always sans. */
export type ReadingFont = "sans" | "serif";

export type StudioSettings = {
	/** Body typeface for the writing surface (Bear sans / Substack serif). */
	readingFont: ReadingFont;
	/** Text-zoom multiplier for the reading column (not the font size — the whole column). */
	readingScale: number;
	/** Native browser spellcheck squigglies in the editors. */
	spellcheck: boolean;
	/** Persistent top formatting toolbar visibility. */
	topToolbar: boolean;
};

export const READING_SCALE_MIN = 0.8;
export const READING_SCALE_MAX = 2.0;
const READING_SCALE_STEP = 0.1;

const DEFAULTS: StudioSettings = {
	readingFont: "sans",
	readingScale: 1,
	spellcheck: true,
	topToolbar: true,
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
		};
	} catch {
		return DEFAULTS;
	}
}

export type StudioSettingsApi = StudioSettings & {
	toggleReadingFont: () => void;
	setReadingFont: (font: ReadingFont) => void;
	zoomIn: () => void;
	zoomOut: () => void;
	zoomReset: () => void;
	toggleSpellcheck: () => void;
	toggleTopToolbar: () => void;
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

	return {
		...settings,
		toggleReadingFont,
		setReadingFont,
		zoomIn,
		zoomOut,
		zoomReset,
		toggleSpellcheck,
		toggleTopToolbar,
	};
}
