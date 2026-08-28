/**
 * Load `dist/recto-core.js` into a JS realm with no DOM and no host globals —
 * the closest thing to a `JSContext` that runs on Linux CI.
 *
 * This is the DOM-free gate: a bundle that reads `window`, `document`,
 * `localStorage` or `fetch` on any reachable path throws `ReferenceError` here,
 * naming the global. Grepping the bundle text cannot distinguish a live read
 * from a `typeof`-guarded one, a comment or a string literal; this can.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import type { RectoCoreApi } from "./entry";

export const BUNDLE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"dist",
	"recto-core.js",
);

export function loadCoreFromSource(code: string): RectoCoreApi {
	const context = createContext({});
	// Node/Bun seed a fresh context with `console`; a bare JSContext does not.
	// Removing it keeps this realm honest and exercises the bundle's own prelude.
	runInContext("delete globalThis.console;", context);
	runInContext(code, context);
	// SAFETY: the context object IS the realm's `globalThis`, so this reads back
	// what `entry.ts` assigned; the shape is checked on the next line rather than
	// trusted, because a bundler misconfiguration could leave it undefined.
	const api = (context as { RectoCore?: RectoCoreApi }).RectoCore;
	if (typeof api?.normalize !== "function") {
		throw new Error("bundle did not define globalThis.RectoCore");
	}
	return api;
}

export async function loadCore(
	bundlePath: string = BUNDLE_PATH,
): Promise<RectoCoreApi> {
	try {
		return loadCoreFromSource(await readFile(bundlePath, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error(
				`${bundlePath} is missing — run \`bun run core:build\` first.`,
			);
		}
		throw error;
	}
}
