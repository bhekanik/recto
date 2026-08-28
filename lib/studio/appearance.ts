/**
 * The light/dark axis (ADR-20). Two consumers have to agree:
 *
 *  1. `APPEARANCE_SCRIPT` — runs in `<head>` before the first paint, so the page
 *     never flashes the wrong appearance. It also keeps listening, so an OS
 *     light/dark flip is picked up on every page, studio or not.
 *  2. `applyAppearance` — called by the studio when the setting changes.
 *
 * Both write the same thing: the `dark` class on `<html>`. Its ABSENCE is light
 * (see the `:root:not(.dark)` block in the generated token CSS).
 *
 * Not `next-themes`: it keeps the appearance under its own localStorage key and
 * its own React context, so the preference would live in a second store beside
 * `recto:studio-settings` and the two would need syncing. What it would buy us
 * over that cost is the eight lines of `APPEARANCE_SCRIPT` below.
 */
import type { Appearance } from "./use-studio-settings";

/**
 * Where `useStudioSettings` persists the whole device-local settings blob. It
 * lives here, not there, because `app/layout.tsx` is a server component and
 * cannot import a value out of a `"use client"` module.
 */
export const SETTINGS_STORAGE_KEY = "recto:studio-settings";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Resolves the stored preference against the OS to a concrete appearance. */
export function resolveAppearance(
	appearance: Appearance,
	prefersDark: boolean,
): "light" | "dark" {
	if (appearance === "system") return prefersDark ? "dark" : "light";
	return appearance;
}

/** Puts (or removes) the `dark` class on `<html>`. */
export function applyAppearance(resolved: "light" | "dark"): void {
	document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * Blocking script for `<head>`. It re-reads localStorage on every run rather
 * than capturing the setting, so the OS-change listener stays correct after the
 * writer changes the preference in the studio.
 */
export const APPEARANCE_SCRIPT = `(function(){try{
var m=matchMedia(${JSON.stringify(DARK_QUERY)});
var a=function(){
var v=null;try{var r=localStorage.getItem(${JSON.stringify(SETTINGS_STORAGE_KEY)});if(r)v=JSON.parse(r).appearance;}catch(e){}
if(v!=="light"&&v!=="dark")v="system";
document.documentElement.classList.toggle("dark",v==="dark"||(v==="system"&&m.matches));
};
a();m.addEventListener("change",a);
}catch(e){}})();`;
