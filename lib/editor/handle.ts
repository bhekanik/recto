import type { FormatCommand } from "@/lib/editor/format";
import type { CaretPosition } from "@/lib/modes/types";

/** Shared editor surface API for sync and mode switching. */
export type EditorHandle = {
	/**
	 * True when `seed` is a no-op because this surface cannot hold text — the
	 * preview lens. Callers that need a projection to actually land (remote
	 * reconciliation) must defer rather than believe they seeded it.
	 */
	readOnly?: boolean;
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
	 * Markdown of the heading-bounded section holding the caret. Related-passage
	 * search queries with it: what the writer is working on now, not the head of
	 * the document.
	 */
	getCaretSectionMarkdown?: () => string | null;
	/** Capture selected Markdown and its replacement transaction from one editor state. */
	captureAiSelection?: () => {
		markdown: string;
		replace: (replacement: string) => string | null;
	} | null;
};

/** Read-only preview — no editing surface. */
export function createPreviewHandle(getMarkdown: () => string): EditorHandle {
	return {
		readOnly: true,
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
