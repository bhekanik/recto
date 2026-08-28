/**
 * Load `dist/recto-vim.js` into a JS realm with no DOM and no host globals —
 * the closest thing to a `JSContext` that runs on Linux CI.
 *
 * This is the DOM-free gate. The vim core does need four host things
 * (`document.createElement`, timers, `navigator.clipboard`, `navigator.platform`)
 * and `src/dom-shim.js` installs exactly those onto the realm's global when a
 * session starts. Anything *else* it reaches for — `window.getComputedStyle`,
 * `requestAnimationFrame`, a real `Element` — is absent here and throws by name.
 *
 * Grepping the bundle text cannot tell a live read from a `typeof` guard, a
 * comment or a string literal; running it can.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import type { RectoVimApi } from "./types";

export const BUNDLE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"dist",
	"recto-vim.js",
);

export function loadVimFromSource(code: string): RectoVimApi {
	const context = createContext({});
	// Node/Bun seed a fresh context with `console`; a bare JSContext does not.
	// Removing it keeps this realm honest — the vim bundle must not need one.
	runInContext("delete globalThis.console;", context);
	runInContext(code, context);
	// SAFETY: the context object IS the realm's `globalThis`, so this reads back
	// what `src/index.js` assigned. The shape is checked rather than trusted,
	// because a bundler misconfiguration would leave it undefined.
	const api = (context as { RectoVim?: RectoVimApi }).RectoVim;
	if (typeof api?.handleKey !== "function") {
		throw new Error("bundle did not define globalThis.RectoVim");
	}
	return api;
}

export async function loadVim(
	bundlePath: string = BUNDLE_PATH,
): Promise<RectoVimApi> {
	try {
		return loadVimFromSource(await readFile(bundlePath, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error(
				`${bundlePath} is missing — run \`bun run vim:build\` first.`,
			);
		}
		throw error;
	}
}
