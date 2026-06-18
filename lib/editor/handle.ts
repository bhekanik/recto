import type { FormatCommand } from "@/lib/editor/format";
import type { CaretPosition } from "@/lib/modes/types";

/** Shared editor surface API for sync and mode switching. */
export type EditorHandle = {
	seed: (markdown: string, opts?: { programmatic?: boolean }) => void;
	getCanonicalMarkdown: () => string;
	exportCaret: () => CaretPosition;
	importCaret: (caret: CaretPosition) => void;
	focus: () => void;
	isFocused: () => boolean;
	getRootElement: () => HTMLElement | null;
	/** Apply a formatting command (from the top toolbar / floating bar). */
	runFormat: (command: FormatCommand, opts?: { href?: string }) => void;
	/**
	 * Serialize the current selection to canonical Markdown, or `null` when the
	 * selection is empty. Rich (Milkdown) editors implement this so the AI
	 * transform can read the selected text without a ProseMirror-position →
	 * markdown-offset map; CodeMirror surfaces use plain-text offsets instead and
	 * may omit it.
	 */
	getSelectedMarkdown?: () => string | null;
	/**
	 * Compute the full canonical Markdown with the current selection replaced by
	 * `replacement` (an arbitrary Markdown string), WITHOUT mutating the live
	 * editor — the replacement is fitted into a throwaway ProseMirror transaction
	 * and the result serialized. Returns `null` when there is no usable selection.
	 * The caller commits the returned markdown once via `commitProgrammatic`, so
	 * the edit lands as a single reversible undo-tree node and is never
	 * double-applied. Rich-only; CodeMirror uses the offset splice path.
	 */
	replaceSelectionMarkdown?: (replacement: string) => string | null;
};

/** Read-only preview — no editing surface. */
export function createPreviewHandle(getMarkdown: () => string): EditorHandle {
	return {
		seed() {},
		getCanonicalMarkdown: getMarkdown,
		exportCaret: () => ({ offset: 0, anchor: 0, head: 0 }),
		importCaret() {},
		focus() {},
		isFocused: () => false,
		getRootElement: () => null,
		runFormat() {},
	};
}
