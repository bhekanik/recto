import type { Mode } from "@/lib/modes/types";
import { MODE_RING, nextMode, prevMode } from "@/lib/modes/types";

export type AppShortcutAction =
	| { type: "open-palette" }
	| { type: "open-document-switcher" }
	| { type: "new-document" }
	| { type: "switch-mode"; mode: Mode }
	| { type: "cycle-mode"; direction: "next" | "prev" }
	| { type: "split-pane"; direction: "vertical" | "horizontal" }
	| { type: "close-pane" }
	| { type: "focus-pane"; direction: "next" | "prev" }
	| { type: "focus-spatial"; direction: "left" | "right" | "up" | "down" }
	| { type: "undo" }
	| { type: "redo" }
	| { type: "checkpoint" }
	| { type: "open-undo-tree" }
	| { type: "open-version-history" }
	| { type: "copy-rich" }
	| { type: "copy-markdown" }
	| { type: "export" }
	| { type: "toggle-status" }
	| { type: "toggle-focus" }
	| { type: "toggle-typewriter" }
	| { type: "toggle-focus-dim" }
	| { type: "open-go-to-heading" }
	| { type: "toggle-outline" }
	| { type: "find-replace" };

const isMac =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** ⌘K / Ctrl+K — mode command palette. */
export function isCommandPaletteKey(event: KeyboardEvent): boolean {
	const key = event.key.toLowerCase();
	if (key !== "k") return false;
	return event.metaKey || event.ctrlKey;
}

/** Cmd/Ctrl+P — document switcher. */
export function isDocumentSwitcherKey(event: KeyboardEvent): boolean {
	const key = event.key.toLowerCase();
	if (key !== "p") return false;
	return event.metaKey || event.ctrlKey;
}

/** Cmd+N (mac) / Ctrl+Alt+N (win) — new document. */
export function isNewDocumentKey(event: KeyboardEvent): boolean {
	const key = event.key.toLowerCase();
	if (key !== "n") return false;
	if (isMac) return event.metaKey && !event.altKey && !event.shiftKey;
	return event.ctrlKey && event.altKey && !event.shiftKey;
}

function matchCtrlShift(event: KeyboardEvent, key: string): boolean {
	return (
		event.ctrlKey &&
		event.shiftKey &&
		!event.metaKey &&
		!event.altKey &&
		event.key.toLowerCase() === key
	);
}

/** Alt+1–4 direct mode jumps. */
export function matchAltModeShortcut(event: KeyboardEvent): Mode | null {
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return null;
	}
	const idx = Number.parseInt(event.key, 10);
	if (idx < 1 || idx > MODE_RING.length) return null;
	return MODE_RING[idx - 1] ?? null;
}

/** True when focus is in an overlay/plain input — where undo/redo stay native. */
function inOverlayOrInput(): boolean {
	if (typeof document === "undefined") return false;
	const ae = document.activeElement;
	if (!ae) return false;
	if (ae.closest('[role="dialog"]')) return true;
	const tag = ae.tagName;
	return tag === "INPUT" || tag === "TEXTAREA";
}

/** Cmd/Ctrl+S — checkpoint (manual tagged version). */
function isCheckpointKey(event: KeyboardEvent): boolean {
	return (
		event.key.toLowerCase() === "s" &&
		(event.metaKey || event.ctrlKey) &&
		!event.shiftKey &&
		!event.altKey
	);
}

/** Cmd/Ctrl+F — open find & replace in the active editor. */
function isFindKey(event: KeyboardEvent): boolean {
	return (
		event.key.toLowerCase() === "f" &&
		(event.metaKey || event.ctrlKey) &&
		!event.shiftKey &&
		!event.altKey
	);
}

function isUndoKey(event: KeyboardEvent): boolean {
	return (
		event.key.toLowerCase() === "z" &&
		(event.metaKey || event.ctrlKey) &&
		!event.shiftKey &&
		!event.altKey
	);
}

function isRedoKey(event: KeyboardEvent): boolean {
	const mod = event.metaKey || event.ctrlKey;
	if (!mod || event.altKey) return false;
	const key = event.key.toLowerCase();
	if (key === "z" && event.shiftKey) return true; // Cmd/Ctrl+Shift+Z
	if (key === "y" && !event.shiftKey) return true; // Ctrl+Y
	return false;
}

/** Capture-phase handler for app-level shortcuts. */
export function createAppShortcutHandler(
	onAction: (action: AppShortcutAction) => void,
): (event: KeyboardEvent) => void {
	return (event: KeyboardEvent) => {
		// History — model-level undo tree (engine bypass). Stay native in overlays.
		if (isCheckpointKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "checkpoint" });
			return;
		}
		// Find & replace — only when the editor body (not the panel's own inputs or
		// a dialog) has focus, so re-pressing ⌘F inside the panel stays native.
		if (isFindKey(event) && !inOverlayOrInput()) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "find-replace" });
			return;
		}
		if (!inOverlayOrInput()) {
			if (isRedoKey(event)) {
				event.preventDefault();
				event.stopPropagation();
				onAction({ type: "redo" });
				return;
			}
			if (isUndoKey(event)) {
				event.preventDefault();
				event.stopPropagation();
				onAction({ type: "undo" });
				return;
			}
		}
		if (matchCtrlShift(event, "u")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "open-undo-tree" });
			return;
		}
		if (matchCtrlShift(event, "h")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "open-version-history" });
			return;
		}

		// Copy / Export (document-scope; bare Cmd/Ctrl+C stays native selection copy).
		{
			const key = event.key.toLowerCase();
			const mod = event.metaKey || event.ctrlKey;
			if (mod && event.shiftKey && !event.altKey && key === "c") {
				event.preventDefault();
				event.stopPropagation();
				onAction({ type: "copy-rich" });
				return;
			}
			if (mod && event.altKey && !event.shiftKey && key === "c") {
				event.preventDefault();
				event.stopPropagation();
				onAction({ type: "copy-markdown" });
				return;
			}
		}
		if (matchCtrlShift(event, "e")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "export" });
			return;
		}
		if (matchCtrlShift(event, "s")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "toggle-status" });
			return;
		}
		if (matchCtrlShift(event, "f")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "toggle-focus" });
			return;
		}
		if (matchCtrlShift(event, "o")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "open-go-to-heading" });
			return;
		}
		if (matchCtrlShift(event, "t")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "toggle-typewriter" });
			return;
		}
		if (matchCtrlShift(event, "d")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "toggle-focus-dim" });
			return;
		}

		if (isCommandPaletteKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "open-palette" });
			return;
		}

		if (isDocumentSwitcherKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "open-document-switcher" });
			return;
		}

		if (isNewDocumentKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "new-document" });
			return;
		}

		if (matchCtrlShift(event, "r")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "switch-mode", mode: "rich" });
			return;
		}
		if (matchCtrlShift(event, "m")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "switch-mode", mode: "raw" });
			return;
		}
		if (matchCtrlShift(event, "v")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "switch-mode", mode: "vim" });
			return;
		}
		if (matchCtrlShift(event, "p")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "switch-mode", mode: "preview" });
			return;
		}
		if (matchCtrlShift(event, "]")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "cycle-mode", direction: "next" });
			return;
		}
		if (matchCtrlShift(event, "[")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "cycle-mode", direction: "prev" });
			return;
		}
		if (matchCtrlShift(event, "arrowright")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "focus-spatial", direction: "right" });
			return;
		}
		if (matchCtrlShift(event, "arrowleft")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "focus-spatial", direction: "left" });
			return;
		}
		if (matchCtrlShift(event, "arrowup")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "focus-spatial", direction: "up" });
			return;
		}
		if (matchCtrlShift(event, "arrowdown")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "focus-spatial", direction: "down" });
			return;
		}
		if (matchCtrlShift(event, "w")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "close-pane" });
			return;
		}

		if (isMac && event.metaKey && !event.shiftKey && event.key === "\\") {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "split-pane", direction: "vertical" });
			return;
		}
		if (
			!isMac &&
			event.ctrlKey &&
			!event.shiftKey &&
			!event.metaKey &&
			event.key === "\\"
		) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "split-pane", direction: "vertical" });
			return;
		}
		if (isMac && event.metaKey && event.shiftKey && event.key === "\\") {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "split-pane", direction: "horizontal" });
			return;
		}
		if (
			!isMac &&
			event.ctrlKey &&
			event.shiftKey &&
			!event.metaKey &&
			event.key === "\\"
		) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "split-pane", direction: "horizontal" });
			return;
		}

		const mode = matchAltModeShortcut(event);
		if (mode) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "switch-mode", mode });
		}
	};
}

export function resolveModeAction(
	current: Mode,
	action: Mode | "next" | "prev",
): Mode {
	if (action === "next") return nextMode(current);
	if (action === "prev") return prevMode(current);
	return action;
}

/** Dispatch mode switch to active pane editors. */
export function dispatchModeSwitch(mode: Mode): void {
	window.dispatchEvent(
		new CustomEvent("recto:switch-mode", { detail: { mode } }),
	);
}

/**
 * Ask the active pane's editor to take focus back. Writing is the primary action,
 * so chrome interactions (toolbar, zoom, mode, overlays) hand focus back here.
 */
export function dispatchFocusEditor(): void {
	window.dispatchEvent(new CustomEvent("recto:focus-editor"));
}
