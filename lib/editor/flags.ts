/**
 * Writing flags as an editor surface sees them (see `lib/markdown/flags.ts`
 * for the token). Every operation takes a flag's index in document order —
 * the same order `findFlags` returns — so a panel built from the canonical
 * Markdown can drive any editor without mapping offsets between them.
 */
export type FlagEditing = {
	/**
	 * Where a new flag would go: the caret's position (in this surface's own
	 * coordinates, only for `insertAt`) and its box in the viewport.
	 */
	caretAnchor: () => { at: number; rect: DOMRect } | null;
	/**
	 * Insert a flag with its note at an anchor's `at`, as one edit, caret
	 * after it. Returns its index, or null.
	 */
	insertAt: (at: number, note: string) => number | null;
	setNote: (index: number, note: string) => void;
	/** Resolve: remove the flag from the text. */
	remove: (index: number) => void;
	/** Caret just after the flag, scrolled into view, editor focused. */
	goTo: (index: number) => void;
	/** The flag's box in the viewport, to anchor the note field; null if unknown. */
	rect: (index: number) => DOMRect | null;
};

/** Fired on `window` when a flag glyph in the text is clicked. */
export const FLAG_CLICK_EVENT = "recto:flag-click";
export type FlagClickDetail = { index: number };

const SVG_NS = "http://www.w3.org/2000/svg";
// Lucide's `flag` icon (ISC), drawn as DOM because ProseMirror node views and
// CodeMirror widgets live outside React.
const FLAG_PATH =
	"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528";

/** The inline flag glyph: a lucide flag the colour of `--color-warning`. */
export function createFlagGlyph(note: string): HTMLElement {
	const span = document.createElement("span");
	span.className = "recto-flag";
	span.contentEditable = "false";
	updateFlagGlyph(span, note);
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", FLAG_PATH);
	svg.appendChild(path);
	span.appendChild(svg);
	return span;
}

export function updateFlagGlyph(span: HTMLElement, note: string): void {
	const label = note ? `Flag: ${note}` : "Flag";
	span.title = label;
	span.setAttribute("role", "img");
	span.setAttribute("aria-label", label);
}
