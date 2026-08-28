import { toast } from "@/lib/ui/toast";
import type { ExportSource } from "./clipboard";
import {
	DEFAULT_EXPORT_ORIGIN,
	DOCX_MIME_TYPE,
	renderDocx,
} from "./docx-render";
import { safeFilename, triggerDownload } from "./file";

export { DOCX_MIME_TYPE };

/** Origin against which root-relative URLs are absolutized for export. */
function appOrigin(): string {
	return typeof window !== "undefined"
		? window.location.origin
		: DEFAULT_EXPORT_ORIGIN;
}

/**
 * Compile canonical Markdown to a `.docx` Blob. The rendering itself lives in
 * `docx-render.ts`, shared with the Convex `export.docx` action so the native
 * apps get the same file.
 */
export async function generateDocxBlob(
	markdown: string,
	title: string,
): Promise<Blob> {
	const bytes = await renderDocx(markdown, title, appOrigin());
	return new Blob([bytes], { type: DOCX_MIME_TYPE });
}

/** Export as .docx — download + toast; never throws (matches clipboard posture). */
export async function exportDocxFile(source: ExportSource): Promise<void> {
	try {
		const blob = await generateDocxBlob(source.markdown, source.title);
		triggerDownload(blob, `${safeFilename(source.title)}.docx`);
		toast("Exported Word document", "success");
	} catch {
		toast("Couldn't export .docx", "error");
	}
}
