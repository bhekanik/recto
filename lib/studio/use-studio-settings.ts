"use client";

import { useCallback, useState } from "react";
import type { GoalKind } from "@/lib/stats/streak";
import { SETTINGS_STORAGE_KEY } from "@/lib/studio/appearance";
import type {
	AiTransformMode,
	Appearance,
	DiffGranularity,
	DiffLayout,
	FocusScope,
	GoalScope,
	GoalStyle,
	LintCategory,
	PreviewVariant,
	ReadingFont,
	StudioSettings,
	Theme,
} from "@/lib/studio/settings-schema";
import {
	APPEARANCE_IDS,
	clampGoalTarget,
	clampScale,
	coerceSettings,
	DEFAULTS,
	READING_SCALE_STEP,
	THEME_IDS,
} from "@/lib/studio/settings-schema";
import { useSettingsSync } from "@/lib/studio/use-settings-sync";

export type {
	AiTransformMode,
	Appearance,
	DiffGranularity,
	DiffLayout,
	FocusScope,
	GoalScope,
	GoalStyle,
	LintCategory,
	LintOptions,
	PreviewVariant,
	ReadingFont,
	StudioSettings,
	Theme,
} from "@/lib/studio/settings-schema";
export {
	APPEARANCES,
	READING_SCALE_MAX,
	READING_SCALE_MIN,
	THEMES,
} from "@/lib/studio/settings-schema";

/**
 * Read this device's settings out of localStorage. Device storage stays the
 * source of truth for the first paint even when signed in: it is synchronous,
 * so the studio never flashes defaults while a Convex query is in flight, and
 * it is the whole story while signed out or offline.
 */
function loadSettings(): StudioSettings {
	if (typeof window === "undefined") return DEFAULTS;
	try {
		const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
		if (!raw) return DEFAULTS;
		return coerceSettings(JSON.parse(raw), DEFAULTS);
	} catch {
		return DEFAULTS;
	}
}
export type StudioSettingsApi = StudioSettings & {
	setAppearance: (appearance: Appearance) => void;
	cycleAppearance: () => void;
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
	toggleFocusBlur: () => void;
	toggleQuietChrome: () => void;
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
 *
 * Every setting is written to this device's localStorage; the subset that
 * belongs to the writer rather than to the screen is also synced through Convex
 * (`useSettingsSync`, ADR-21) so a new machine arrives already set up.
 */
export function useStudioSettings(): StudioSettingsApi {
	// Studio only renders client-side (after auth), so a lazy initializer reading
	// localStorage is safe and avoids a settings flash on mount.
	const [settings, setSettings] = useState<StudioSettings>(loadSettings);

	useSettingsSync(settings, setSettings);

	const setAppearance = useCallback((appearance: Appearance) => {
		setSettings((s) => ({ ...s, appearance }));
	}, []);

	const cycleAppearance = useCallback(() => {
		setSettings((s) => {
			const i = APPEARANCE_IDS.indexOf(s.appearance);
			const next =
				APPEARANCE_IDS[(i + 1) % APPEARANCE_IDS.length] ?? s.appearance;
			return { ...s, appearance: next };
		});
	}, []);

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

	const toggleFocusBlur = useCallback(() => {
		setSettings((s) => ({ ...s, focusBlur: !s.focusBlur }));
	}, []);

	const toggleQuietChrome = useCallback(() => {
		setSettings((s) => ({ ...s, quietChrome: !s.quietChrome }));
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
		setAppearance,
		cycleAppearance,
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
		toggleFocusBlur,
		toggleQuietChrome,
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
