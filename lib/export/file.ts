import { toast } from "@/lib/ui/toast";
import type { ExportSource } from "./clipboard";
import { safeFilename } from "./filename";
import { generateExportHtml } from "./html";

export { safeFilename };

/** Download a blob via a synthetic <a>, revoking the object URL after the click. */
export function triggerDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/** Export as .md — the canonical Markdown string. No BOM. */
export function exportMarkdownFile(source: ExportSource): void {
	const blob = new Blob([source.markdown], {
		type: "text/markdown;charset=utf-8",
	});
	triggerDownload(blob, `${safeFilename(source.title)}.md`);
	toast("Exported Markdown", "success");
}

/** Export as rich text — self-contained HTML from the canonical model. */
export function exportHtmlFile(source: ExportSource): void {
	const html = generateExportHtml(source.markdown, source.title);
	const blob = new Blob([html], { type: "text/html;charset=utf-8" });
	triggerDownload(blob, `${safeFilename(source.title)}.html`);
	toast("Exported HTML", "success");
}
