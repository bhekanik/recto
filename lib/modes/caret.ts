import type { CaretPosition } from "./types";

/** Clamp offset into document bounds. */
export function clampOffset(offset: number, length: number): number {
	return Math.max(0, Math.min(offset, length));
}

export function caretAtOffset(offset: number, length: number): CaretPosition {
	const clamped = clampOffset(offset, length);
	return { offset: clamped, anchor: clamped, head: clamped };
}

export function importCaretToCm(
	docLength: number,
	caret: CaretPosition,
): { anchor: number; head: number } {
	return {
		anchor: clampOffset(caret.anchor, docLength),
		head: clampOffset(caret.head, docLength),
	};
}

/** Best-effort export from CodeMirror selection. */
export function exportCaretFromCm(anchor: number, head: number): CaretPosition {
	return { offset: head, anchor, head };
}

/** Best-effort export from Milkdown — uses head offset only. */
export function exportCaretFromOffset(head: number): CaretPosition {
	return { offset: head, anchor: head, head };
}
