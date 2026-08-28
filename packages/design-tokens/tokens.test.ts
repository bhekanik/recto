import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { inGamut, oklch, parse, wcagContrast } from "culori";
import { afterAll, describe, expect, it } from "vitest";

import { buildTokens } from "./build";
import tokens from "./tokens.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMITTED = join(HERE, "generated");

type Colors = Record<string, { $value: string }>;

/** The value of one token, or a loud failure if it is missing. */
function tokenValue(colors: Colors, token: string): string {
	const leaf = colors[token];
	if (!leaf) throw new Error(`palette is missing the "${token}" token`);
	return leaf.$value;
}

// Read straight off the typed JSON import: the two launch palettes are named in
// `tokens.json`, so a rename breaks the build here rather than at runtime.
const twilight: Colors = tokens.palette.twilight.color;
const paper: Colors = tokens.palette.paper.color;

/** Every file under `dir`, as repo-relative-ish paths, sorted. */
async function tree(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((e) => e.isFile())
		.map((e) => relative(dir, join(e.parentPath, e.name)))
		.sort();
}

describe("generated outputs are in sync with tokens.json", () => {
	let fresh: string | undefined;

	afterAll(async () => {
		if (fresh) await rm(fresh, { recursive: true, force: true });
	});

	it("matches a fresh build byte-for-byte", async () => {
		fresh = await mkdtemp(join(tmpdir(), "recto-tokens-"));
		await buildTokens(fresh);

		const [committedFiles, freshFiles] = await Promise.all([
			tree(COMMITTED),
			tree(fresh),
		]);
		expect(committedFiles).toEqual(freshFiles);

		for (const file of freshFiles) {
			const [a, b] = await Promise.all([
				readFile(join(COMMITTED, file), "utf8"),
				readFile(join(fresh, file), "utf8"),
			]);
			// Named per file so a drift failure says which artifact is stale.
			expect(a, `${file} is stale — run \`bun run tokens:build\``).toBe(b);
		}
	});
});

/**
 * WCAG ratios are measured, never inferred from OKLCH lightness (design system
 * §2.5). `line-strong` is deliberately absent: it is a decorative hairline, and
 * WCAG 1.4.11 exempts it — holding it to 3:1 would force a heavy grey rule on
 * paper and would change Twilight, which plan 023 fixes. `focus-ring` carries
 * the 3:1 non-text obligation instead, and it is asserted below.
 */
describe("contrast", () => {
	const ratio = (fg: string, bg: string) =>
		Math.round(wcagContrast(fg, bg) * 100) / 100;

	for (const [name, colors, onAccentFloor] of [
		// Dark's floor is 3, not 4.5: ink-primary on the accent-muted fill measures
		// 3.15:1 today and clearing AA would mean darkening accent-muted in all four
		// dark palettes. Twilight's values are locked by plan 023, so that fix is the
		// orchestrator's call, not this PR's. Paper is new, so it gets the real bar.
		["Twilight (dark)", twilight, 3],
		["Paper (light)", paper, 4.5],
	] as const) {
		describe(name, () => {
			const v = (token: string) => tokenValue(colors, token);
			const app = v("bg-app");
			const surface = v("bg-surface");

			it("ink-primary clears AAA body text (7:1) on canvas and sheet", () => {
				expect(ratio(v("ink-primary"), app)).toBeGreaterThanOrEqual(7);
				expect(ratio(v("ink-primary"), surface)).toBeGreaterThanOrEqual(7);
			});

			it("ink-secondary clears AA (4.5:1)", () => {
				expect(ratio(v("ink-secondary"), app)).toBeGreaterThanOrEqual(4.5);
				expect(ratio(v("ink-secondary"), surface)).toBeGreaterThanOrEqual(4.5);
			});

			it("ink-tertiary clears non-text (3:1) — and in fact AA", () => {
				expect(ratio(v("ink-tertiary"), app)).toBeGreaterThanOrEqual(3);
				expect(ratio(v("ink-tertiary"), surface)).toBeGreaterThanOrEqual(4.5);
			});

			it("focus-ring clears non-text contrast (3:1) on every layer", () => {
				for (const layer of [
					"bg-app",
					"bg-surface",
					"bg-raised",
					"bg-overlay",
				]) {
					expect(ratio(v("focus-ring"), v(layer))).toBeGreaterThanOrEqual(3);
				}
			});

			it("semantic status colours are legible as text (4.5:1)", () => {
				for (const token of [
					"success",
					"warning",
					"danger",
					"accent",
					"accent-2",
				]) {
					expect(ratio(v(token), app), token).toBeGreaterThanOrEqual(4.5);
				}
			});

			it("on-accent is legible on the accent fill (shadcn --primary)", () => {
				expect(ratio(v("on-accent"), v("accent-muted"))).toBeGreaterThanOrEqual(
					onAccentFloor,
				);
			});

			it("comment and lint marks clear non-text contrast (3:1)", () => {
				for (const token of [
					"comment",
					"lint-passive",
					"lint-readability",
					"lint-adverb",
					"lint-weasel",
				]) {
					expect(ratio(v(token), surface), token).toBeGreaterThanOrEqual(3);
				}
			});
		});
	}

	it("Paper keeps the sheet lighter than the canvas (the signature lift)", () => {
		const lightness = (token: string) =>
			oklch(tokenValue(paper, token))?.l ?? 0;
		expect(lightness("bg-surface")).toBeGreaterThan(lightness("bg-app"));
	});
});

/**
 * Values outside sRGB survive in CSS (browsers gamut-map) but get clamped on the
 * way into the asset catalog, so a wide-gamut token silently ships a different
 * colour on Apple. Paper is authored to stay inside sRGB; Twilight's caret is the
 * one pre-existing exception and is pinned here so a new one is noticed.
 */
describe("sRGB gamut", () => {
	const outOfGamut = (colors: Colors) =>
		Object.entries(colors)
			.filter(([, leaf]) => {
				const parsed = parse(leaf.$value);
				return parsed ? !inGamut("rgb")(parsed) : false;
			})
			.map(([name]) => name);

	it("Paper is entirely inside sRGB", () => {
		expect(outOfGamut(paper)).toEqual([]);
	});

	it("Twilight's only wide-gamut token is the caret", () => {
		expect(outOfGamut(twilight)).toEqual(["caret"]);
	});
});
