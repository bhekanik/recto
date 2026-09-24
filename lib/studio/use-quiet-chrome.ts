"use client";

import { useEffect, useState } from "react";

/** The editors' typing surfaces: Milkdown's ProseMirror and CodeMirror's content. */
const EDITOR_SELECTOR = ".ProseMirror, .cm-content";

/**
 * Whether a key press is writing in an editor: not a chord (⌘K should find the
 * chrome where the writer left it), and aimed at an editor, not a field in
 * the chrome.
 */
export function isWritingKey(event: KeyboardEvent): boolean {
	if (event.metaKey || event.ctrlKey) return false;
	const target = event.target;
	return target instanceof Element && target.closest(EDITOR_SELECTOR) !== null;
}

/**
 * Quiet chrome (after the Mac app): typing in an editor quiets the toolbar and
 * status bar; moving, clicking or touching brings them back. Scrolling leaves
 * it as it is — a scroll is reading, not reaching for a control — and so do the
 * synthetic zero-distance mouse moves a browser sends when content scrolls
 * under a still pointer (typewriter scrolling does that on every line).
 */
export function useQuietChrome(enabled: boolean): boolean {
	const [quiet, setQuiet] = useState(false);

	useEffect(() => {
		if (!enabled) {
			setQuiet(false);
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (isWritingKey(event)) setQuiet(true);
		};
		const onMouseMove = (event: MouseEvent) => {
			if (event.movementX !== 0 || event.movementY !== 0) setQuiet(false);
		};
		const wake = () => setQuiet(false);
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("mousemove", onMouseMove, { passive: true });
		window.addEventListener("pointerdown", wake, true);
		window.addEventListener("touchstart", wake, { passive: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("pointerdown", wake, true);
			window.removeEventListener("touchstart", wake);
		};
	}, [enabled]);

	return quiet;
}
