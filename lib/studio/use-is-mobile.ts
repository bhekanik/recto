"use client";

import { useEffect, useState } from "react";

/** Below this width we collapse the workspace to a single full-screen pane and
 *  condense the chrome — splits are a desktop affordance. Matches Tailwind `md`. */
const MOBILE_QUERY = "(max-width: 767px)";

/**
 * Reactive viewport check. SSR-safe: returns `false` until mounted, then tracks
 * the media query. The studio only renders client-side (post-auth), so the
 * initial `false` never reaches the server HTML.
 */
export function useIsMobile(): boolean {
	const [isMobile, setIsMobile] = useState(false);

	useEffect(() => {
		const mql = window.matchMedia(MOBILE_QUERY);
		const update = () => setIsMobile(mql.matches);
		update();
		mql.addEventListener("change", update);
		return () => mql.removeEventListener("change", update);
	}, []);

	return isMobile;
}
