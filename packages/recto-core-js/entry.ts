/**
 * DOM-free entry point for the shared JS core (plan 023 D-N3, §1.5).
 *
 * Bundled by `build.ts` into `dist/recto-core.js` (IIFE) and loaded once per
 * process into a `JSContext` by the native apps. Everything here re-exports
 * `lib/` — no logic lives in this file, so the native clients and the web run
 * byte-identical code. Anything that touches `window`/`document`/`fetch` is
 * deliberately NOT reachable from here (see README).
 */

import { type Chunk, chunk } from "@/lib/ai/chunk";
import type { TransformPresetId } from "@/lib/ai/instructions";
import { transformWarnings } from "@/lib/ai/transform-checks";
import { analyze } from "@/lib/lint/analyze";
import { ALL_CATEGORIES, type LintOptions } from "@/lib/lint/types";
import { countWords } from "@/lib/markdown/count-words";
import { markdownFromHtml } from "@/lib/markdown/from-html";
import { normalizeMarkdown } from "@/lib/markdown/normalize";
import { extractOutline, type OutlineHeading } from "@/lib/outline/extract";
import { renderPreviewHtml } from "@/lib/preview/render";
import { currentStreak, type DailyStat } from "@/lib/stats/streak";

/**
 * Replaced at build time with the package version + git sha. Declared (not
 * imported) so the bundle carries no build-tool code.
 */
declare const __RECTO_CORE_VERSION__: string;

/**
 * JavaScriptCore passes a missing Swift argument as `undefined`, which would
 * reach remark as a cryptic "cannot read property of undefined" deep inside
 * unified. Fail at the boundary with a message that names the call instead.
 */
function requireString(value: unknown, fn: string, arg: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`RectoCore.${fn}: ${arg} must be a string`);
	}
	return value;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Streak arithmetic walks backwards a calendar day at a time by string key, so
 * a malformed key does not throw — it silently matches nothing and returns a
 * streak of 0. Reject it here instead of handing back a plausible wrong number.
 */
function requireDateKey(value: unknown, fn: string, arg: string): string {
	const key = requireString(value, fn, arg);
	if (!DATE_KEY.test(key)) {
		throw new TypeError(`RectoCore.${fn}: ${arg} must be "YYYY-MM-DD"`);
	}
	return key;
}

/** JSC bridges a Swift `Int` as a JS number; anything else is a caller bug. */
function requireFiniteNumber(value: unknown, fn: string, arg: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`RectoCore.${fn}: ${arg} must be a finite number`);
	}
	return value;
}

const CATEGORY_SET = new Set<string>(ALL_CATEGORIES);

/**
 * Accept the Swift-friendly `[String]` form (or `null`/omitted for "all") and
 * widen it to the `LintOptions` record `lib/lint` expects. Spelling the keys out
 * keeps this cast-free: adding a category to `LintCategory` breaks compilation
 * here until it is handled.
 */
function toLintOptions(
	categories: readonly string[] | null | undefined,
): LintOptions {
	const enabled =
		categories == null ? new Set<string>(ALL_CATEGORIES) : new Set(categories);
	for (const name of enabled) {
		if (!CATEGORY_SET.has(name)) {
			throw new TypeError(`RectoCore.lint: unknown category "${name}"`);
		}
	}
	return {
		passive: enabled.has("passive"),
		readability: enabled.has("readability"),
		adverb: enabled.has("adverb"),
		weasel: enabled.has("weasel"),
	};
}

const RectoCore = {
	version: __RECTO_CORE_VERSION__,

	/** Canonical `serialize(parse(md))` — the single MDAST↔string crossing. */
	normalize(markdown: string): string {
		return normalizeMarkdown(requireString(markdown, "normalize", "markdown"));
	},

	/** Prose word count (markdown syntax excluded). */
	countWords(markdown: string): number {
		return countWords(requireString(markdown, "countWords", "markdown"));
	},

	/** Flat heading outline in document order. */
	parseOutline(markdown: string): OutlineHeading[] {
		return extractOutline(requireString(markdown, "parseOutline", "markdown"));
	},

	/** Sanitized preview HTML (`lib/preview/render.ts`). */
	htmlFromMarkdown(markdown: string): string {
		return renderPreviewHtml(
			requireString(markdown, "htmlFromMarkdown", "markdown"),
		);
	},

	/** Smart paste: `text/html` → canonical Markdown, no DOM involved. */
	markdownFromHtml(html: string): string {
		return markdownFromHtml(requireString(html, "markdownFromHtml", "html"));
	},

	/**
	 * Prose lint. Returns a **Promise** — `lib/lint/analyze` imports `write-good`
	 * lazily, so this is the one async call in the API. The import target is
	 * inside the bundle, so the promise settles on the first microtask drain
	 * (see README for the JSC calling convention).
	 */
	lint(markdown: string, categories?: readonly string[] | null) {
		return analyze(
			requireString(markdown, "lint", "markdown"),
			toLintOptions(categories),
		);
	},

	/** Paragraph windows for related-passage search (`lib/ai/chunk.ts`), UTF-16 offsets. */
	chunk(markdown: string): Chunk[] {
		return chunk(requireString(markdown, "chunk", "markdown"));
	},

	/**
	 * `lib/ai/transform-checks`: what a finished AI transform broke, as plain
	 * sentences. `presetId` is null for a free-text instruction.
	 */
	transformWarnings(
		original: string,
		rewritten: string,
		presetId?: string | null,
	): string[] {
		return transformWarnings({
			original: requireString(original, "transformWarnings", "original"),
			rewritten: requireString(rewritten, "transformWarnings", "rewritten"),
			// SAFETY: an unknown id only means no preset-specific check applies,
			// which is exactly the free-text behaviour.
			presetId: (presetId ?? undefined) as TransformPresetId | undefined,
		});
	},

	/** Current writing streak in days, counting back from `today` ("YYYY-MM-DD"). */
	streak(days: readonly DailyStat[], today: string): number {
		if (!Array.isArray(days)) {
			throw new TypeError("RectoCore.streak: days must be an array");
		}
		const stats: DailyStat[] = days.map((day, i) => {
			if (day === null || typeof day !== "object") {
				throw new TypeError(`RectoCore.streak: days[${i}] must be an object`);
			}
			// SAFETY: `day` is a non-null object (checked above) and the assertion
			// only widens both fields to `unknown`; the two `require*` calls below
			// are what actually establish their types.
			const { date, words } = day as { date: unknown; words: unknown };
			return {
				date: requireDateKey(date, "streak", `days[${i}].date`),
				words: requireFiniteNumber(words, "streak", `days[${i}].words`),
			};
		});
		return currentStreak(stats, requireDateKey(today, "streak", "today"));
	},
} as const;

export type RectoCoreApi = typeof RectoCore;

// The bundle is an IIFE loaded into a bare JSContext; the global is the API.
(globalThis as { RectoCore?: RectoCoreApi }).RectoCore = RectoCore;
