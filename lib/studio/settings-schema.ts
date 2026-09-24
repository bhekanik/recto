import type { FocusScope } from "@/lib/editor/focus-range";
import {
	ALL_CATEGORIES,
	type LintCategory,
	type LintOptions,
} from "@/lib/lint";
import type { GoalKind } from "@/lib/stats/streak";

export type { FocusScope, LintCategory, LintOptions };

/**
 * The shape of the studio's settings, its defaults, and the coercion that
 * turns any stored blob back into a complete, valid settings object.
 *
 * Split out of `use-studio-settings.ts` because two very different callers need
 * it: the React hook, and the Convex sync layer that has to validate a settings
 * object written by another device (or another app version) before trusting it.
 */

/** The writing-body typeface — the chrome is always sans. */
export type ReadingFont = "sans" | "serif";

/** Calm/ethereal colour themes. Each is a soft-coloured DARK palette (ADR-20). */
export type Theme = "twilight" | "aurora" | "dawn" | "moonlit";

/**
 * Light/dark axis (ADR-20, reverses D13). `system` follows
 * `prefers-color-scheme`. Orthogonal to `theme`: the dark palettes above apply
 * only while this resolves to dark; light is always Paper.
 */
export type Appearance = "system" | "light" | "dark";

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
export function clampGoalTarget(value: number): number {
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

export const THEME_IDS = THEMES.map((t) => t.id);

/** Ordered for the cycle control + command palette; first is the default. */
export const APPEARANCES: { id: Appearance; label: string; hint: string }[] = [
	{ id: "system", label: "System", hint: "follow the OS" },
	{ id: "light", label: "Light", hint: "Paper" },
	{ id: "dark", label: "Dark", hint: "Twilight & friends" },
];

export const APPEARANCE_IDS = APPEARANCES.map((a) => a.id);

export type StudioSettings = {
	/** Light/dark axis; `system` follows the OS (ADR-20). Device-local. */
	appearance: Appearance;
	/** Soft-coloured dark palette for the whole studio. Ignored while light. */
	theme: Theme;
	/** Body typeface for the writing surface (Bear sans / Substack serif). */
	readingFont: ReadingFont;
	/** Text-zoom multiplier for the reading column (not the font size — the whole column). Device-local. */
	readingScale: number;
	/** Native browser spellcheck squigglies in the editors. */
	spellcheck: boolean;
	/** Persistent top formatting toolbar visibility. Device-local. */
	topToolbar: boolean;
	/** Convert pasted rich HTML (Word/Docs/web) into canonical Markdown on paste. */
	smartPaste: boolean;
	/** Granularity of the history compare diff (word = prose standard). */
	diffGranularity: DiffGranularity;
	/** Layout of the history compare diff. */
	diffLayout: DiffLayout;
	/** Per-document word goal target (0 = no goal). */
	wordGoalTarget: number;
	/** Direction of the word goal (at-least / about / at-most). */
	wordGoalKind: GoalKind;
	/** Optional daily word goal target (0 = no daily goal). */
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
	/**
	 * Focus blur — the caret's block sharp and centred, every other block blurred
	 * more the further away it is. Brings typewriter scrolling with it while on.
	 */
	focusBlur: boolean;
	/** Fade the toolbar and status bar while typing; the pointer brings them back. */
	quietChrome: boolean;
	/** Prose linter on/off (plan 004) — opt-in highlight-only, off by default. */
	lint: boolean;
	/** Per-category lint toggles (passive / readability / adverb / weasel). */
	lintCategories: LintOptions;
	/** Docked document-outline panel visibility (plan 005). Device-local. */
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
export const READING_SCALE_STEP = 0.1;

export const DEFAULTS: StudioSettings = {
	// Follow the OS by default — the writer's machine already knows the answer.
	appearance: "system",
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
	focusBlur: false,
	// On, as in the Mac app: while the writer is in the sentence, the chrome is not.
	quietChrome: true,
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

/**
 * Settings that stay on the device and are never synced (ADR-21).
 *
 * The test is whether the setting is about the *writer* or about the *screen in
 * front of them*. `appearance` answers "is this room dark right now" and already
 * defaults to following the OS, which is a per-device answer. `readingScale` is
 * calibrated against one display's size and viewing distance — a comfortable
 * 1.6× on a phone is unreadable zoom on a 27" monitor. `topToolbar` and
 * `outlineOpen` are window furniture: a phone has no room for either, and
 * syncing them would let a desktop session close a panel on a tablet.
 *
 * Everything else — theme, typeface, goals, focus mode, linter, AI posture —
 * is a preference about how the writer works, and should follow them onto a new
 * machine without being set up twice.
 */
export const DEVICE_LOCAL_KEYS = [
	"appearance",
	"readingScale",
	"topToolbar",
	"outlineOpen",
] as const satisfies readonly (keyof StudioSettings)[];

export type DeviceLocalKey = (typeof DEVICE_LOCAL_KEYS)[number];
export type SyncedKey = Exclude<keyof StudioSettings, DeviceLocalKey>;

const DEVICE_LOCAL_SET = new Set<string>(DEVICE_LOCAL_KEYS);

export const SYNCED_KEYS = (
	Object.keys(DEFAULTS) as (keyof StudioSettings)[]
).filter((key): key is SyncedKey => !DEVICE_LOCAL_SET.has(key));

/** Coerce a stored lint-categories blob to a complete, boolean-valued map. */
function coerceLintCategories(value: unknown): LintOptions {
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

export function clampScale(value: number): number {
	const clamped = Math.min(
		READING_SCALE_MAX,
		Math.max(READING_SCALE_MIN, value),
	);
	// Avoid float drift (e.g. 0.7999999) so the displayed % is clean.
	return Math.round(clamped * 100) / 100;
}

/**
 * Turn an arbitrary parsed blob into a complete settings object, falling back
 * to `base` per key. The blob can come from this device's localStorage, from
 * another device via Convex, or from a version of the app that spelled a value
 * differently — none of them are trusted, and a single bad key must not cost
 * the writer every other setting.
 */
export function coerceSettings(
	value: unknown,
	base: StudioSettings = DEFAULTS,
): StudioSettings {
	const parsed =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Partial<StudioSettings>)
			: {};

	return {
		appearance:
			parsed.appearance && APPEARANCE_IDS.includes(parsed.appearance)
				? parsed.appearance
				: base.appearance,
		theme:
			parsed.theme && THEME_IDS.includes(parsed.theme)
				? parsed.theme
				: base.theme,
		readingFont:
			parsed.readingFont === "serif"
				? "serif"
				: parsed.readingFont === "sans"
					? "sans"
					: base.readingFont,
		readingScale:
			typeof parsed.readingScale === "number"
				? clampScale(parsed.readingScale)
				: base.readingScale,
		spellcheck:
			typeof parsed.spellcheck === "boolean"
				? parsed.spellcheck
				: base.spellcheck,
		topToolbar:
			typeof parsed.topToolbar === "boolean"
				? parsed.topToolbar
				: base.topToolbar,
		smartPaste:
			typeof parsed.smartPaste === "boolean"
				? parsed.smartPaste
				: base.smartPaste,
		diffGranularity:
			parsed.diffGranularity === "line"
				? "line"
				: parsed.diffGranularity === "word"
					? "word"
					: base.diffGranularity,
		diffLayout:
			parsed.diffLayout === "side-by-side"
				? "side-by-side"
				: parsed.diffLayout === "inline"
					? "inline"
					: base.diffLayout,
		wordGoalTarget:
			typeof parsed.wordGoalTarget === "number"
				? clampGoalTarget(parsed.wordGoalTarget)
				: base.wordGoalTarget,
		wordGoalKind:
			parsed.wordGoalKind && GOAL_KINDS.includes(parsed.wordGoalKind)
				? parsed.wordGoalKind
				: base.wordGoalKind,
		dailyGoalTarget:
			typeof parsed.dailyGoalTarget === "number"
				? clampGoalTarget(parsed.dailyGoalTarget)
				: base.dailyGoalTarget,
		goalStyle:
			parsed.goalStyle === "bar"
				? "bar"
				: parsed.goalStyle === "ring"
					? "ring"
					: base.goalStyle,
		goalScope:
			parsed.goalScope === "daily"
				? "daily"
				: parsed.goalScope === "document"
					? "document"
					: base.goalScope,
		typewriter:
			typeof parsed.typewriter === "boolean"
				? parsed.typewriter
				: base.typewriter,
		focusDim:
			typeof parsed.focusDim === "boolean" ? parsed.focusDim : base.focusDim,
		focusDimScope:
			parsed.focusDimScope === "paragraph"
				? "paragraph"
				: parsed.focusDimScope === "sentence"
					? "sentence"
					: base.focusDimScope,
		focusBlur:
			typeof parsed.focusBlur === "boolean" ? parsed.focusBlur : base.focusBlur,
		quietChrome:
			typeof parsed.quietChrome === "boolean"
				? parsed.quietChrome
				: base.quietChrome,
		lint: typeof parsed.lint === "boolean" ? parsed.lint : base.lint,
		lintCategories:
			parsed.lintCategories === undefined
				? base.lintCategories
				: coerceLintCategories(parsed.lintCategories),
		outlineOpen:
			typeof parsed.outlineOpen === "boolean"
				? parsed.outlineOpen
				: base.outlineOpen,
		previewVariant:
			parsed.previewVariant === "email"
				? "email"
				: parsed.previewVariant === "rendered"
					? "rendered"
					: base.previewVariant,
		aiEnabled:
			typeof parsed.aiEnabled === "boolean" ? parsed.aiEnabled : base.aiEnabled,
		aiTransformMode:
			parsed.aiTransformMode === "replace"
				? "replace"
				: parsed.aiTransformMode === "pending"
					? "pending"
					: base.aiTransformMode,
	};
}

/** The synced subset, as the object stored in `settings.json` on Convex. */
export function pickSynced(settings: StudioSettings): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of SYNCED_KEYS) picked[key] = settings[key];
	return picked;
}

/**
 * Properties in a stored settings object that this client does not know about.
 *
 * `SYNCED_KEYS` is compiled from this build's `DEFAULTS`, so an older web
 * client's idea of "the whole object" is missing every setting a newer native
 * client added. Writing that object back would delete those settings for every
 * device — a silent downgrade that the writer would experience as their iPad's
 * preferences resetting whenever they opened the web app.
 *
 * The fix is a sidecar: unknown properties are carried alongside, untouched,
 * and written back with every save. Chosen over making `settings.save` a
 * key-level patch on the server because the offline path already has to merge
 * per key on the client (only the keys this device actually changed win a
 * conflict), so the client is doing key-level reasoning either way — and
 * `save` keeps the whole-object contract W10-W12 were given.
 */
export function pickUnknown(json: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const known = new Set<string>(SYNCED_KEYS);
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		// Device-local keys are dropped rather than preserved: they must never
		// travel, and a buggy client putting one in the blob should not make it
		// permanent.
		if (known.has(key) || DEVICE_LOCAL_SET.has(key)) continue;
		extras[key] = value;
	}
	return extras;
}

/**
 * Serialize the synced subset, carrying `unknown` properties through untouched.
 * Stable key order, so equal state compares equal.
 */
export function serializeSynced(
	settings: StudioSettings,
	unknown: Record<string, unknown> = {},
): string {
	// Known keys last: this client's values win for the settings it understands.
	const merged: Record<string, unknown> = {
		...unknown,
		...pickSynced(settings),
	};
	// Sorted, so two clients holding the same settings produce byte-identical
	// JSON. The sync hook compares these strings to decide whether a change is
	// worth a mutation, and insertion order differs between a client that knows
	// a key and one that carried it through as unknown.
	const canonical: Record<string, unknown> = {};
	for (const key of Object.keys(merged).sort()) canonical[key] = merged[key];
	return JSON.stringify(canonical);
}

/**
 * Apply a settings object from the server over the local one.
 *
 * Only synced keys are taken, so the server can never reach across and change
 * this device's appearance or zoom. Keys the server does not carry keep their
 * local value, which is what makes adding a setting safe: an older client that
 * writes the object back does not erase a key it has never heard of on this
 * device, and a newer client's unknown key survives the round trip because the
 * server stores the object whole.
 */
export function mergeSyncedJson(
	current: StudioSettings,
	json: string,
	/**
	 * Keys this device has changed and not yet had accepted. They keep their
	 * local value instead of taking the server's, which is what makes a lost
	 * compare-and-set recoverable: the writer's own change survives, and only
	 * the settings they did not touch adopt the other device's values.
	 */
	keepLocal: ReadonlySet<string> = new Set(),
): StudioSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return current;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return current;
	}
	const incoming = parsed as Record<string, unknown>;
	const synced: Record<string, unknown> = {};
	for (const key of SYNCED_KEYS) {
		if (keepLocal.has(key)) continue;
		if (key in incoming) synced[key] = incoming[key];
	}
	return coerceSettings({ ...current, ...synced }, current);
}

/** Which synced settings differ between two states. */
export function changedSyncedKeys(
	before: StudioSettings,
	after: StudioSettings,
): SyncedKey[] {
	return SYNCED_KEYS.filter(
		(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
	);
}
