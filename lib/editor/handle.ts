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
