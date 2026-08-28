"use client";

import { useEffect, useState } from "react";

import { applyAppearance, DARK_QUERY, resolveAppearance } from "./appearance";
import type { Appearance } from "./use-studio-settings";

/**
 * Resolves the stored appearance against the OS and writes it to `<html>`.
 *
 * The blocking script in `app/layout.tsx` already did this before the first
 * paint and keeps tracking OS changes on its own; this hook exists so that (a)
 * changing the setting in the studio takes effect immediately and (b) the chrome
 * can render the resolved value — which palette picker to offer, which label to
 * show.
 */
export function useResolvedAppearance(
	appearance: Appearance,
): "light" | "dark" {
	// Lazily seeded from the real media query so the first client render is
	// already correct (the studio renders client-side, post-auth, so this never
	// reaches the server HTML).
	const [prefersDark, setPrefersDark] = useState(
		() =>
			typeof window === "undefined" || window.matchMedia(DARK_QUERY).matches,
	);

	useEffect(() => {
		const mql = window.matchMedia(DARK_QUERY);
		const update = () => setPrefersDark(mql.matches);
		update();
		mql.addEventListener("change", update);
		return () => mql.removeEventListener("change", update);
	}, []);

	const resolved = resolveAppearance(appearance, prefersDark);

	useEffect(() => {
		applyAppearance(resolved);
	}, [resolved]);

	return resolved;
}

/**
 * Reads the appearance that is actually applied to `<html>`, wherever it was set
 * from (the blocking script, an OS change, the studio toggle). Use this outside
 * the studio, where the settings hook is not mounted — `Providers` needs it to
 * theme Clerk's widgets.
 */
export function useAppliedAppearance(): "light" | "dark" {
	const [applied, setApplied] = useState<"light" | "dark">(() =>
		typeof document === "undefined" ||
		document.documentElement.classList.contains("dark")
			? "dark"
			: "light",
	);

	useEffect(() => {
		const html = document.documentElement;
		const update = () =>
			setApplied(html.classList.contains("dark") ? "dark" : "light");
		update();
		const observer = new MutationObserver(update);
		observer.observe(html, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	return applied;
}
