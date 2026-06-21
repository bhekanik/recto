"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ChromeHoverProps = {
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
};

export type UseZenModeResult = {
	zen: boolean;
	setZen: React.Dispatch<React.SetStateAction<boolean>>;
	chromeRevealed: boolean;
	/** Hover props for the chrome wrappers; empty object when not in zen. */
	chromeHoverProps: ChromeHoverProps;
};

/**
 * Zen mode: hide all chrome but the canvas; reveal on mouse move, re-hide on idle
 * (and stay revealed while the pointer is over the chrome). Zen also takes the page
 * fullscreen; leaving fullscreen by Esc / F11 leaves zen.
 */
export function useZenMode(): UseZenModeResult {
	const [zen, setZen] = useState(false);
	const [chromeRevealed, setChromeRevealed] = useState(false);
	const overChromeRef = useRef(false);
	const revealTimerRef = useRef<number | null>(null);

	const clearRevealTimer = useCallback(() => {
		if (revealTimerRef.current !== null) {
			window.clearTimeout(revealTimerRef.current);
			revealTimerRef.current = null;
		}
	}, []);

	const scheduleHide = useCallback(() => {
		clearRevealTimer();
		revealTimerRef.current = window.setTimeout(() => {
			if (!overChromeRef.current) setChromeRevealed(false);
		}, 2200);
	}, [clearRevealTimer]);

	useEffect(() => {
		if (!zen) {
			setChromeRevealed(false);
			clearRevealTimer();
			return;
		}
		const onMove = () => {
			setChromeRevealed(true);
			scheduleHide();
		};
		window.addEventListener("mousemove", onMove);
		// Touch has no mousemove — reveal the chrome (and its exit control) on tap.
		window.addEventListener("touchstart", onMove, { passive: true });
		// Reveal briefly on entering zen so the exit control is discoverable.
		setChromeRevealed(true);
		scheduleHide();
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("touchstart", onMove);
			clearRevealTimer();
		};
	}, [zen, scheduleHide, clearRevealTimer]);

	const chromeHoverProps: ChromeHoverProps = zen
		? {
				onMouseEnter: () => {
					overChromeRef.current = true;
					clearRevealTimer();
					setChromeRevealed(true);
				},
				onMouseLeave: () => {
					overChromeRef.current = false;
					scheduleHide();
				},
			}
		: {};

	// Zen takes the page fullscreen too. Requested from a user gesture (toggle /
	// shortcut), so the browser allows it; failures degrade to plain zen.
	useEffect(() => {
		if (typeof document === "undefined") return;
		if (zen) {
			if (!document.fullscreenElement) {
				document.documentElement.requestFullscreen?.().catch(() => {});
			}
		} else if (document.fullscreenElement) {
			document.exitFullscreen?.().catch(() => {});
		}
	}, [zen]);

	// Leaving fullscreen by Esc / F11 should also leave zen.
	useEffect(() => {
		const onFullscreenChange = () => {
			if (!document.fullscreenElement) setZen(false);
		};
		document.addEventListener("fullscreenchange", onFullscreenChange);
		return () =>
			document.removeEventListener("fullscreenchange", onFullscreenChange);
	}, []);

	return { zen, setZen, chromeRevealed, chromeHoverProps };
}
