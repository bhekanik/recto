import { describe, expect, it } from "vitest";

import {
	APPEARANCE_SCRIPT,
	applyAppearance,
	DARK_QUERY,
	resolveAppearance,
	SETTINGS_STORAGE_KEY,
	THEME_COLOR,
} from "./appearance";

/** Clears the head so each case starts with no `theme-color` tag. */
function clearThemeColorMeta(): void {
	for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
		m.remove();
	}
}

const themeColorOf = () =>
	document.querySelector('meta[name="theme-color"]')?.getAttribute("content");

describe("resolveAppearance", () => {
	it("follows the OS when set to system", () => {
		expect(resolveAppearance("system", true)).toBe("dark");
		expect(resolveAppearance("system", false)).toBe("light");
	});

	it("ignores the OS when the writer picked one", () => {
		expect(resolveAppearance("light", true)).toBe("light");
		expect(resolveAppearance("dark", false)).toBe("dark");
	});
});

describe("applyAppearance", () => {
	it("marks dark with the class and light with its absence", () => {
		applyAppearance("dark");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		applyAppearance("light");
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});

	it("retunes theme-color, so a stored override beats the OS", () => {
		clearThemeColorMeta();
		applyAppearance("light");
		expect(themeColorOf()).toBe(THEME_COLOR.light);
		applyAppearance("dark");
		expect(themeColorOf()).toBe(THEME_COLOR.dark);
	});

	it("creates the meta tag when it is absent, and never duplicates it", () => {
		document.querySelector('meta[name="theme-color"]')?.remove();
		applyAppearance("light");
		applyAppearance("dark");
		const tags = document.querySelectorAll('meta[name="theme-color"]');
		expect(tags).toHaveLength(1);
		expect(themeColorOf()).toBe(THEME_COLOR.dark);
	});
});

describe("APPEARANCE_SCRIPT", () => {
	/**
	 * The script is a string, so nothing type-checks it. These pin the two facts
	 * that would silently break the no-flash guarantee if they drifted: it reads
	 * the same storage key the settings hook writes, and it watches the same media
	 * query the React hook watches.
	 */
	it("reads the settings hook's storage key", () => {
		expect(APPEARANCE_SCRIPT).toContain(JSON.stringify(SETTINGS_STORAGE_KEY));
	});

	it("watches the same media query as the hook", () => {
		expect(APPEARANCE_SCRIPT).toContain(JSON.stringify(DARK_QUERY));
	});

	it("resolves the stored preference the same way resolveAppearance does", () => {
		// The script only reaches for `matchMedia`, `localStorage` and `document`, so
		// it runs with the first two shadowed by stand-ins and the real happy-dom
		// document, which is what makes the resulting class observable.
		const run = (stored: string | null, prefersDark: boolean) => {
			clearThemeColorMeta();
			const matchMedia = () => ({
				matches: prefersDark,
				addEventListener: () => {},
			});
			const localStorage = {
				getItem: () =>
					stored === null ? null : JSON.stringify({ appearance: stored }),
			};
			document.documentElement.classList.remove("dark");
			new Function("matchMedia", "localStorage", APPEARANCE_SCRIPT)(
				matchMedia,
				localStorage,
			);
			return document.documentElement.classList.contains("dark")
				? "dark"
				: "light";
		};

		expect(run("dark", false)).toBe("dark");
		// The script owns the meta tag too — a stored Dark on a light OS must not
		// leave the browser chrome painted with the Paper canvas.
		expect(themeColorOf()).toBe(THEME_COLOR.dark);
		expect(run("light", true)).toBe("light");
		expect(themeColorOf()).toBe(THEME_COLOR.light);
		expect(run("system", true)).toBe("dark");
		expect(run("system", false)).toBe("light");
		// No stored settings, or junk in them, falls back to following the OS.
		expect(run(null, true)).toBe("dark");
		expect(run("nonsense", false)).toBe("light");
	});
});
