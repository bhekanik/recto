/**
 * Strip illegal filename chars, collapse whitespace, cap length (blueprint 11 §4).
 *
 * Lives apart from `file.ts` because the Convex `export.docx` action needs it
 * and `file.ts` reaches for `document`/`Blob`/toasts.
 */
export function safeFilename(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	return cleaned || "untitled";
}
