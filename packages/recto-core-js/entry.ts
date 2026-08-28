/**
 * DOM-free entry point for the shared JS core (plan 023 D-N3, §1.5).
 *
 * Bundled by `build.ts` into `dist/recto-core.js` (IIFE) and loaded once per
 * process into a `JSContext` by the native apps. Everything here re-exports
 * `lib/` — no logic lives in this file, so the native clients and the web run
 * byte-identical code. Anything that touches `window`/`document`/`fetch` is
 * deliberately NOT reachable from here (see README).
 */

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

	/** Current writing streak in days, counting back from `today` ("YYYY-MM-DD"). */
	streak(days: readonly DailyStat[], today: string): number {
		if (!Array.isArray(days)) {
			throw new TypeError("RectoCore.streak: days must be an array");
		}
		return currentStreak([...days], requireString(today, "streak", "today"));
	},
} as const;

export type RectoCoreApi = typeof RectoCore;

// The bundle is an IIFE loaded into a bare JSContext; the global is the API.
(globalThis as { RectoCore?: RectoCoreApi }).RectoCore = RectoCore;
