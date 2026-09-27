/**
 * The caret as a UTF-16 offset into the canonical Markdown, for surfaces
 * whose own positions are not Markdown offsets (ProseMirror's tree, or a
 * CodeMirror buffer that canonicalisation may still reshape). A private-use
 * character is written at the caret in a throwaway copy, the copy is turned
 * into canonical Markdown, and the character is found again. It is never
 * escaped or dropped, and it never touches the live document.
 */
export const CARET_SENTINEL = "";

/** The sentinel's offset in `marked` canonical Markdown, or null if lost. */
export function caretOffsetIn(marked: string): number | null {
	const at = marked.indexOf(CARET_SENTINEL);
	return at < 0 ? null : at;
}
