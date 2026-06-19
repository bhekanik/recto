/**
 * Shared window-event names used to decouple the editor surfaces, the studio
 * shell, and the keyboard/workspace layers (the same out-of-tree signalling
 * pattern as lib/ai/summon.ts and lib/review/summon.ts). Each constant is the
 * single source of truth for both the dispatcher and the listener of an event —
 * a typo here fails loudly instead of silently no-op-ing the pair.
 */

/** PaneEditor → studio-shell: the active pane's prose-lint issue count. */
export const LINT_COUNT_EVENT = "recto:lint-count";

/** CodeMirror (vim u) → studio-shell: route to the model-level undo tree. */
export const HISTORY_UNDO_EVENT = "recto:history-undo";

/** CodeMirror (vim Ctrl-r) → studio-shell: route to the model-level redo. */
export const HISTORY_REDO_EVENT = "recto:history-redo";

/** Keyboard shortcuts → active PaneEditor: switch the editing mode. */
export const SWITCH_MODE_EVENT = "recto:switch-mode";

/** Keyboard shortcuts → active PaneEditor: hand focus back to the editor. */
export const FOCUS_EDITOR_EVENT = "recto:focus-editor";

/** Workspace persistence → PaneEditor: move focus into the now-active pane. */
export const FOCUS_PANE_EVENT = "recto:focus-pane";
