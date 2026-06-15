import type { Mode } from "@/lib/modes/types";
import { MODE_RING, nextMode, prevMode } from "@/lib/modes/types";

export type AppShortcutAction =
	| { type: "open-palette" }
	| { type: "switch-mode"; mode: Mode };

/** ⌘K / Ctrl+K — standard palette chord. */
export function isCommandPaletteKey(event: KeyboardEvent): boolean {
	const key = event.key.toLowerCase();
	if (key !== "k") return false;
	return event.metaKey || event.ctrlKey;
}

/** Alt+1–4 direct mode jumps — avoids browser/OS Ctrl+Shift conflicts. */
export function matchAltModeShortcut(event: KeyboardEvent): Mode | null {
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return null;
	}
	const idx = Number.parseInt(event.key, 10);
	if (idx < 1 || idx > MODE_RING.length) return null;
	return MODE_RING[idx - 1] ?? null;
}

/** Capture-phase handler for app-level shortcuts. */
export function createAppShortcutHandler(
	onAction: (action: AppShortcutAction) => void,
): (event: KeyboardEvent) => void {
	return (event: KeyboardEvent) => {
		if (isCommandPaletteKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "open-palette" });
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
