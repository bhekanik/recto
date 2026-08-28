/**
 * Builds `dist/recto-vim.js` — the single IIFE `RectoVim` loads into a
 * `JSContext` (plan 023 §1.4, §2). Run with `bun run vim:build`.
 *
 * Three steps, in order, because each gates the next:
 *   1. re-extract the upstream core (`scripts/extract-core.ts`), which fails
 *      loudly if `initVim`'s seam has moved;
 *   2. bundle;
 *   3. evaluate the fresh bundle in a realm with no DOM and drive a real
 *      keystroke through it, so a dependency that reaches for a browser global
 *      fails the build rather than the app.
 *
 * `manifest.json` records the sha256 the Xcode copy-resources script checks, so
 * a stale bundle in `Resources/` is a build error and not a subtly old vim.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { $ } from "bun";

import { loadVimFromSource } from "./bare-realm";

const packageDir = dirname(Bun.fileURLToPath(import.meta.url));
const repoRoot = join(packageDir, "..", "..");
const outFile = join(packageDir, "dist", "recto-vim.js");
const manifestFile = join(packageDir, "manifest.json");

/** `<pkg version>+<short sha>`, or `+unknown` outside a git checkout. */
async function resolveVersion(): Promise<string> {
	// SAFETY: this package's own package.json, committed next to this file, and
	// `version` is required by the JSON schema every package.json follows.
	const pkg = (await Bun.file(join(packageDir, "package.json")).json()) as {
		version: string;
	};
	const sha = await $`git -C ${repoRoot} rev-parse --short HEAD`
		.quiet()
		.nothrow()
		.text();
	return `${pkg.version}+${sha.trim() || "unknown"}`;
}

// Running the extractor as an import keeps one copy of the anchor logic; it is
// a top-level script, so importing it is what runs it.
await import("./scripts/extract-core");

const version = await resolveVersion();
await mkdir(dirname(outFile), { recursive: true });

const result = await Bun.build({
	entrypoints: [join(packageDir, "src", "index.js")],
	target: "browser",
	format: "iife",
	// Minified, unlike `recto-core.js`. The core is unminified because
	// `write-good`'s transitive `adverb-where` assembles a RegExp from
	// concatenated template literals and minifiers have corrupted it; nothing in
	// the vim core does that, and the 100-case keystroke suite runs against
	// these exact bytes in both Bun and JavaScriptCore, so a minifier bug would
	// fail the build rather than ship. 119 kB against 257 kB is worth it inside
	// an app bundle that also carries the 1.3 MB core.
	minify: true,
	// No `sourceMappingURL` in a shipped bundle: the App Store scan in
	// `apple/scripts/copy-js-bundles.sh` rejects one.
	sourcemap: "none",
	define: { __RECTO_VIM_VERSION__: JSON.stringify(version) },
	throw: true,
});

const artifact = result.outputs[0];
if (!artifact) throw new Error("bun build produced no output");
const code = await artifact.text();
await writeFile(outFile, code);

// DOM-free gate: a realm with no `document`, `window`, `navigator` or timers.
// `installDomShim` puts back the four the core actually needs; a reach for
// anything else throws ReferenceError here, naming the global.
const vim = loadVimFromSource(code);
vim.init("the quick brown fox\nsecond line\n", null);
vim.setCursor(0, 0);
for (const key of ["d", "w", "i", "x", "Escape", "u"]) {
	vim.handleKey(key, 0);
}
if (typeof vim.getText() !== "string") {
	throw new Error("smoke script did not leave a readable buffer");
}

const sha256 = createHash("sha256").update(code).digest("hex");
await writeFile(
	manifestFile,
	`${JSON.stringify(
		{
			name: "recto-vim",
			version,
			file: relative(packageDir, outFile),
			bytes: Buffer.byteLength(code),
			sha256,
		},
		null,
		"\t",
	)}\n`,
);

console.log(
	`recto-vim ${version}: ${(Buffer.byteLength(code) / 1024).toFixed(1)} kB, sha256 ${sha256.slice(0, 16)}…`,
);
