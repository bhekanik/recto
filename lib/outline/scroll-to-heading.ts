/**
 * Scroll the given editor root to its Nth rendered heading (document order),
 * matching the index from extractOutline. Best-effort: no-op if absent.
 *
 * This is the universal jump primitive — it relies only on the editor rendering
 * `<h1>`–`<h6>` DOM elements in source order (true for Milkdown/ProseMirror rich
 * mode and the rehype-rendered preview). CodeMirror (raw/vim) renders headings as
 * styled text lines, not heading elements, so this returns `false` there and the
 * caller falls back to caret placement (which is offset-exact for CodeMirror).
 */
export function scrollRootToHeadingIndex(
	root: HTMLElement | null,
	index: number,
): boolean {
	if (!root) return false;
	const headings = root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
	const el = headings[index];
	if (!el) return false;
	el.scrollIntoView({ block: "start", behavior: "smooth" });
	return true;
}
