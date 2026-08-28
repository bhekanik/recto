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
import { RECTO_HEX } from "@/packages/design-tokens/generated/tokens";

import type { Appearance } from "./use-studio-settings";

/**
 * Where `useStudioSettings` persists the whole device-local settings blob. It
 * lives here, not there, because `app/layout.tsx` is a server component and
 * cannot import a value out of a `"use client"` module.
 */
export const SETTINGS_STORAGE_KEY = "recto:studio-settings";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The browser-chrome colour per appearance — `bg-app`, so the mobile address bar
 * and the PWA splash match the canvas. A media-scoped `<meta>` pair cannot be
 * used here: media queries follow the OS, and the writer's stored override beats
 * the OS. One mutable tag, written by whichever code resolved the appearance.
 *
 * The tag is CREATED by the script below rather than rendered from JSX: React
 * reconciles a JSX-rendered `<meta>` on hydration and re-inserts its own copy
 * when the script has already changed `content`, leaving two tags in the head.
 */
export const THEME_COLOR = {
	light: RECTO_HEX.light["bg-app"],
	dark: RECTO_HEX.dark["bg-app"],
} as const;

/** Resolves the stored preference against the OS to a concrete appearance. */
export function resolveAppearance(
	appearance: Appearance,
	prefersDark: boolean,
): "light" | "dark" {
	if (appearance === "system") return prefersDark ? "dark" : "light";
	return appearance;
}

/** Puts (or removes) the `dark` class on `<html>`, and retunes the meta tag. */
export function applyAppearance(resolved: "light" | "dark"): void {
	document.documentElement.classList.toggle("dark", resolved === "dark");
	// Create-if-missing rather than update-if-present: the tag is owned by the
	// blocking script, not by React (see APPEARANCE_SCRIPT), so on a page where
	// that script was blocked there is nothing to update.
	let meta = document.querySelector('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement("meta");
		meta.setAttribute("name", "theme-color");
		document.head.append(meta);
	}
	meta.setAttribute("content", THEME_COLOR[resolved]);
}

/**
 * Blocking script for `<head>`. It re-reads localStorage on every run rather
 * than capturing the setting, so the OS-change listener stays correct after the
 * writer changes the preference in the studio.
 */
export const APPEARANCE_SCRIPT = `(function(){try{
var m=matchMedia(${JSON.stringify(DARK_QUERY)});
var c=${JSON.stringify(THEME_COLOR)};
var a=function(){
var v=null;try{var r=localStorage.getItem(${JSON.stringify(SETTINGS_STORAGE_KEY)});if(r)v=JSON.parse(r).appearance;}catch(e){}
if(v!=="light"&&v!=="dark")v="system";
var d=v==="dark"||(v==="system"&&m.matches);
document.documentElement.classList.toggle("dark",d);
var t=document.querySelector('meta[name="theme-color"]');
if(!t){t=document.createElement("meta");t.setAttribute("name","theme-color");document.head.appendChild(t);}
t.setAttribute("content",d?c.dark:c.light);
};
a();m.addEventListener("change",a);
}catch(e){}})();`;
