/**
 * Computed-value regression test for the Tailwind theme-key collision (F1).
 *
 * `app/globals.css` declares palette tokens in one `@theme` (generated) and
 * shadcn's semantic mapping in a second `@theme inline`. Both are emitted at
 * `:root` with equal specificity, so a key present in BOTH silently resolves to
 * whichever comes last. That is invisible in the source, invisible in the token
 * JSON, and only shows up once a browser has resolved the cascade — which is why
 * this runs the real compiled CSS through a real CSS engine.
 *
 * It reads `--color-accent` back for every palette × appearance and compares it
 * to the value `tokens.json` designed, so any future token that collides with a
 * Tailwind or shadcn key fails here instead of quietly dimming the UI.
 *
 * Run: `bun run tokens:cascade` (needs `bunx playwright install chromium`).
 * Kept out of `bun run test` on purpose: the blocking CI job has no browser, so
 * this gets its own job, like `core:parity`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import tailwind from "@tailwindcss/postcss";
import { differenceEuclidean, parse } from "culori";
import postcss from "postcss";

import tokens from "./tokens.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS = join(HERE, "..", "..", "app", "globals.css");

/** How each palette is selected on `<html>` at runtime, and its designed accent. */
const CASES = [
	{
		name: "Twilight (dark, default)",
		className: "dark",
		theme: null,
		expected: tokens.palette.twilight.color.accent.$value,
	},
	{
		// The studio always writes `data-theme`, and there is no
		// `:root[data-theme="twilight"]` rule — so this is the case the collision
		// actually broke in production.
		name: "Twilight (dark, data-theme set)",
		className: "dark",
		theme: "twilight",
		expected: tokens.palette.twilight.color.accent.$value,
	},
	{
		name: "Aurora (dark)",
		className: "dark",
		theme: "aurora",
		expected: tokens.palette.aurora.color.accent.$value,
	},
	{
		name: "Dawn (dark)",
		className: "dark",
		theme: "dawn",
		expected: tokens.palette.dawn.color.accent.$value,
	},
	{
		name: "Moonlit (dark)",
		className: "dark",
		theme: "moonlit",
		expected: tokens.palette.moonlit.color.accent.$value,
	},
	{
		name: "Paper (light)",
		className: "",
		theme: null,
		expected: tokens.palette.paper.color.accent.$value,
	},
] as const;

/** Compiles `app/globals.css` exactly as the app's PostCSS pipeline does. */
async function compileGlobals(): Promise<string> {
	const source = await Bun.file(GLOBALS).text();
	const result = await postcss([tailwind()]).process(source, { from: GLOBALS });
	return result.css;
}

const distance = differenceEuclidean("oklch");

/** Same colour, whatever the browser chose to serialize it as. */
function sameColour(a: string, b: string): boolean {
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return false;
	return distance(x, y) < 1e-4;
}

async function main() {
	const css = await compileGlobals();
	const browser = await chromium.launch();
	const page = await browser.newPage();
	await page.setContent(
		`<!doctype html><html><head><style>${css}</style></head><body></body></html>`,
	);

	const failures: string[] = [];
	for (const c of CASES) {
		const actual = await page.evaluate(
			([className, theme]) => {
				const html = document.documentElement;
				html.className = className ?? "";
				if (theme) html.dataset.theme = theme;
				else delete html.dataset.theme;
				return getComputedStyle(html).getPropertyValue("--color-accent").trim();
			},
			[c.className, c.theme] as const,
		);
		const ok = sameColour(actual, c.expected);
		if (!ok) failures.push(`${c.name}: got ${actual}, want ${c.expected}`);
		console.log(
			`  ${ok ? "ok  " : "FAIL"} ${c.name.padEnd(32)} --color-accent = ${actual}`,
		);
	}
	await browser.close();

	if (failures.length > 0) {
		console.error(
			`\n${failures.length} palette(s) resolve --color-accent to the wrong value:`,
		);
		for (const f of failures) console.error(`  ${f}`);
		console.error(
			"\nSomething is redefining --color-accent at :root — check `@theme inline`\nin app/globals.css for a key that collides with a generated token.",
		);
		process.exit(1);
	}
	console.log(`\n${CASES.length} palettes resolve --color-accent as designed.`);
}

await main();
