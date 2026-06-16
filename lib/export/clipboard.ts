import { toast } from "@/lib/ui/toast";
import { generateExportHtml } from "./html";

/** What every copy/export action funnels through — derived from the canonical model. */
export type ExportSource = { title: string; markdown: string };

function handleClipboardError(err: unknown): void {
	const name = err instanceof Error ? err.name : "";
	if (name === "NotAllowedError") {
		toast("Clipboard access was blocked — use Export instead.", "error");
	} else {
		toast("Couldn't copy — use Export instead.", "error");
	}
}

/**
 * Copy as rich text: ONE ClipboardItem carrying text/html (rendered) + text/plain
 * (the Markdown source). write() is the first async call in the gesture so Safari
 * keeps transient activation; falls back to Markdown-only when unsupported (D14,
 * blueprint 11 §2).
 */
export async function copyAsRichText(source: ExportSource): Promise<void> {
	const supported =
		typeof ClipboardItem !== "undefined" &&
		typeof navigator !== "undefined" &&
		typeof navigator.clipboard?.write === "function";

	if (!supported) {
		await copyAsMarkdown(source);
		return;
	}

	try {
		const html = generateExportHtml(source.markdown, source.title);
		const item = new ClipboardItem({
			"text/html": new Blob([html], { type: "text/html" }),
			"text/plain": new Blob([source.markdown], { type: "text/plain" }),
		});
		await navigator.clipboard.write([item]);
		toast("Copied as rich text", "success");
	} catch (err) {
		handleClipboardError(err);
	}
}

/** Copy as Markdown: text/plain only — never a text/html representation (§3). */
export async function copyAsMarkdown(source: ExportSource): Promise<void> {
	try {
		if (typeof navigator?.clipboard?.writeText !== "function") {
			throw new Error("Clipboard unavailable");
		}
		await navigator.clipboard.writeText(source.markdown);
		toast("Copied as Markdown", "success");
	} catch (err) {
		handleClipboardError(err);
	}
}
