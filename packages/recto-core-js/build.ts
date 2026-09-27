/**
 * Builds `dist/recto-core.js` — the single IIFE the native apps load into a
 * `JSContext` (plan 023 §1.5, §2). Run with `bun run core:build`.
 *
 * Also writes `manifest.json` next to `dist/`; the Xcode copy-resources script
 * compares the copied bundle's sha256 against it and fails on a stale hash.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { $ } from "bun";

import { loadCoreFromSource } from "./bare-realm";

const packageDir = dirname(Bun.fileURLToPath(import.meta.url));
const repoRoot = join(packageDir, "..", "..");
const outFile = join(packageDir, "dist", "recto-core.js");
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

/**
 * A bare `JSContext` has no `console`, and `debug` (reached through
 * `write-good`) reads `console.debug` at module scope — the bundle would throw
 * `ReferenceError` on load. Hosts are free to install their own `console`
 * (os_log, say) before evaluating the bundle; this only fills the gap.
 */
const CONSOLE_PRELUDE = `globalThis.console ||= { log(){}, info(){}, warn(){}, error(){}, debug(){} };\n`;

const version = await resolveVersion();
await mkdir(dirname(outFile), { recursive: true });

const result = await Bun.build({
	entrypoints: [join(packageDir, "entry.ts")],
	target: "browser",
	format: "iife",
	// `browser` alone makes packages that ship a DOM variant pick it — e.g.
	// `decode-named-character-reference` resolves to `index.dom.js`, which calls
	// `document.createElement("i")` at module scope and would throw the moment
	// JSC evaluated the bundle. `worker` is listed before `browser` in those
	// packages' `exports` maps, so it selects the DOM-free implementation
	// (`character-entities` lookup) without polyfilling anything. A JSContext is
	// exactly that: a JS realm with no DOM.
	conditions: ["worker"],
	// Minification is OFF on purpose: `write-good`'s transitive `adverb-where`
	// assembles a RegExp from concatenated template literals at module scope, and
	// minifiers have corrupted it before (see the comment in lib/lint/analyze.ts
	// about Turbopack's SSR minifier). The bundle ships inside the app, so size
	// buys us nothing that is worth re-introducing that class of bug.
	minify: false,
	sourcemap: "none",
	define: { __RECTO_CORE_VERSION__: JSON.stringify(version) },
	banner: CONSOLE_PRELUDE,
	throw: true,
});

const artifact = result.outputs[0];
if (!artifact) throw new Error("bun build produced no output");
const code = await artifact.text();
await writeFile(outFile, code);

// DOM-free gate: evaluate the fresh bundle in a bare realm and touch every API.
// A dependency that reaches for a DOM global — at module scope or on a call path
// — throws ReferenceError here and fails the build. `bun run core:parity` then
// runs the same realm over the whole fixture corpus, and the JSC spike proves it
// on the real engine.
const core = loadCoreFromSource(code);
const smoke = "# Title\n\nThe report was written by the committee.\n";
core.normalize(smoke);
core.countWords(smoke);
core.parseOutline(smoke);
core.findFlags(smoke);
core.htmlFromMarkdown(smoke);
core.markdownFromHtml("<p>hi</p>");
core.streak([{ date: "2026-08-27", words: 10 }], "2026-08-27");
await core.lint(smoke);

const sha256 = createHash("sha256").update(code).digest("hex");
await writeFile(
	manifestFile,
	`${JSON.stringify(
		{
			name: "recto-core",
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
	`recto-core ${version}: ${(Buffer.byteLength(code) / 1024).toFixed(1)} kB, sha256 ${sha256.slice(0, 16)}…`,
);
