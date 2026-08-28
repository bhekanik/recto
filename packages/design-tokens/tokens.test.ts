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
 * §2.5), and measured on EVERY layer a token is used on — not just the canvas.
 * The status bar and the command palette sit on `bg-raised`, dialogs and popovers
 * on `bg-overlay`, and those are the layers that bind: a token can clear 4.5:1 on
 * `bg-app` and still fail where it is actually read.
 *
 * The one exemption — `line-strong` — is a skipped test rather than an omission,
 * so the reporter names it on every run.
 */
describe("contrast", () => {
	/** Every background a token can be read on, worst-case first in practice. */
	const LAYERS = ["bg-app", "bg-surface", "bg-raised", "bg-overlay"] as const;

	/**
	 * Aurora, Dawn and Moonlit override only part of Twilight, exactly as their
	 * CSS blocks do; the palette a user actually sees is the merge. Asserting the
	 * override sets alone would miss every inherited token.
	 */
	const effectiveDark = (overrides: Colors): Colors => ({
		...twilight,
		...overrides,
	});

	/**
	 * Compares the RAW ratio. Rounding first would let 4.496 pass a 4.5 floor;
	 * the rounded number appears only in the failure message.
	 */
	function assertRatio(fg: string, bg: string, floor: number, label: string) {
		const raw = wcagContrast(fg, bg);
		expect(
			raw,
			`${label} measures ${raw.toFixed(2)}:1, needs ${floor}:1`,
		).toBeGreaterThanOrEqual(floor);
	}

	for (const [name, colors] of [
		["Twilight (dark)", twilight],
		["Aurora (dark)", effectiveDark(tokens.palette.aurora.color)],
		["Dawn (dark)", effectiveDark(tokens.palette.dawn.color)],
		["Moonlit (dark)", effectiveDark(tokens.palette.moonlit.color)],
		["Paper (light)", paper],
	] as const) {
		describe(name, () => {
			const v = (token: string) => tokenValue(colors, token);

			/** Asserts one foreground against every background layer. */
			const onEveryLayer = (token: string, floor: number) => {
				for (const layer of LAYERS) {
					assertRatio(v(token), v(layer), floor, `${token} on ${layer}`);
				}
			};

			it("ink-primary clears AAA body text (7:1) on every layer", () => {
				onEveryLayer("ink-primary", 7);
			});

			it("ink-secondary clears AA (4.5:1) on every layer", () => {
				onEveryLayer("ink-secondary", 4.5);
			});

			it("ink-tertiary clears AA (4.5:1) on every layer", () => {
				// "Muted" never means "below threshold" — and the at-rest word count,
				// placeholders and palette hints all live on raised/overlay.
				onEveryLayer("ink-tertiary", 4.5);
			});

			/**
			 * EXEMPTION (orchestrator ruling, plan 023 review round 1). `line-strong`
			 * measures 1.87:1 on Paper and 2.52:1 on Twilight. It is a decorative
			 * hairline — the pane divider, a blockquote rule, a toolbar edge — and
			 * WCAG 1.4.11 exempts decoration, so the 3:1 non-text obligation is
			 * carried by `focus-ring` in the test below instead. Holding this token
			 * to 3:1 would put a heavy grey rule on paper AND change Twilight, whose
			 * values plan 023 locks. Skipped, not deleted: if `line-strong` ever
			 * becomes load-bearing for state, un-skip this and retune every palette.
			 */
			it.skip("line-strong clears non-text contrast (3:1) — EXEMPT", () => {
				onEveryLayer("line-strong", 3);
			});

			it("focus-ring clears non-text contrast (3:1) on every layer", () => {
				onEveryLayer("focus-ring", 3);
			});

			it("status and accent text clears AA (4.5:1) on every layer", () => {
				for (const token of [
					"success",
					"warning",
					"danger",
					"accent",
					"accent-2",
				]) {
					onEveryLayer(token, 4.5);
				}
			});

			it("on-accent clears AA (4.5:1) on the accent fill", () => {
				// shadcn --primary / --accent / --sidebar-primary are all the
				// accent-muted fill, and the default button label sits on it.
				assertRatio(
					v("on-accent"),
					v("accent-muted"),
					4.5,
					"on-accent on accent-muted",
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
					onEveryLayer(token, 3);
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

/**
 * `app/globals.css` carries two `@theme` blocks: the generated palette and
 * shadcn's `@theme inline` mapping. Tailwind emits both at `:root`, so a key in
 * BOTH resolves to whichever is written last — and the loser disappears with no
 * error anywhere. That is how `--color-accent` spent its life resolving to
 * `accent-muted` in Twilight (F1).
 *
 * This is the cheap, browser-free half of that guard: it catches the collision
 * at the source. `bun run tokens:cascade` is the other half — it proves what a
 * real CSS engine actually resolves, for every palette.
 */
describe("Tailwind theme keys", () => {
	/** The custom-property names declared directly inside one at-rule block. */
	function themeKeys(css: string, atRule: string): Set<string> {
		const head = css.indexOf(atRule);
		if (head < 0) throw new Error(`${atRule} not found`);
		const open = css.indexOf("{", head);
		let depth = 0;
		let close = open;
		for (let i = open; i < css.length; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}" && --depth === 0) {
				close = i;
				break;
			}
		}
		return new Set(
			[...css.slice(open, close).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(
				(m) => m[1] as string,
			),
		);
	}

	it("shadcn's @theme inline never claims a generated palette key", async () => {
		const [globals, generated] = await Promise.all([
			readFile(join(HERE, "..", "..", "app", "globals.css"), "utf8"),
			readFile(join(COMMITTED, "tokens.css"), "utf8"),
		]);
		const palette = themeKeys(generated, "@theme");
		const shadcn = themeKeys(globals, "@theme inline");
		const collisions = [...shadcn].filter((k) => palette.has(k)).sort();
		expect(
			collisions,
			"these keys are declared by both blocks, so the palette value is silently discarded",
		).toEqual([]);
	});
});
