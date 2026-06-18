/**
 * Editor-agnostic "summon the AI transform over the current selection" signal
 * (plan 009), mirroring lib/editor/format.ts's dispatchFormat pattern. The
 * selection toolbar (mounted outside the React settings provider via a Milkdown
 * plugin view) fires this; studio-shell listens and opens the popover.
 *
 * A module-level mirror of `aiEnabled` lets the out-of-tree selection toolbar
 * decide whether to render its AI button without prop-drilling React context into
 * the ProseMirror plugin. studio-shell keeps it in sync with the setting.
 */

export const AI_TRANSFORM_SUMMON_EVENT = "recto:ai-transform";

let aiEnabledMirror = false;

/** Sync the module mirror with the live setting (called from studio-shell). */
export function setAiEnabledMirror(enabled: boolean): void {
	aiEnabledMirror = enabled;
}

/** Read the mirrored flag (for out-of-tree UI like the selection toolbar). */
export function isAiEnabled(): boolean {
	return aiEnabledMirror;
}

/** Ask the active editor's host to open the AI transform over the selection. */
export function dispatchAiTransform(): void {
	window.dispatchEvent(new CustomEvent(AI_TRANSFORM_SUMMON_EVENT));
}
