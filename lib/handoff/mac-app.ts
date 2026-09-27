/**
 * The Mac app, as the web offers it: where to download it and how to tell
 * that a `recto://` handoff went nowhere.
 */

/** The latest notarized build, from this repository's public releases. */
export const MAC_APP_DOWNLOAD_URL =
	"https://github.com/bhekanik/recto/releases/latest/download/Recto.dmg";

/** What the build runs on (the app targets macOS 26, arm64 only). */
export const MAC_APP_REQUIREMENTS = "macOS 26 or later · Apple silicon";

/**
 * Hand a `recto://` link to the Mac app. Browsers stay silent when no app
 * takes a custom scheme, so a handoff that worked is read from the page
 * losing focus soon after (macOS brings the app forward); when it doesn't,
 * `onMissed` runs so the page can offer the download.
 */
export function openInMacApp(
	url: string,
	onMissed: () => void,
	timeoutMs = 1600,
): void {
	let settled = false;
	const took = () => {
		settled = true;
		cleanup();
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") took();
	};
	const cleanup = () => {
		window.removeEventListener("blur", took);
		window.removeEventListener("pagehide", took);
		document.removeEventListener("visibilitychange", onVisibility);
	};
	window.addEventListener("blur", took);
	window.addEventListener("pagehide", took);
	document.addEventListener("visibilitychange", onVisibility);
	window.setTimeout(() => {
		cleanup();
		if (!settled) onMissed();
	}, timeoutMs);
	window.location.assign(url);
}
