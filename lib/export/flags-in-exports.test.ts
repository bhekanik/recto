import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { FLAG_GUARD } from "@/lib/markdown/flags";
import { renderPreviewHtml } from "@/lib/preview/render";
import { generateDocxBlob } from "./docx";
import { generateExportHtml } from "./html";

// A writing flag is a note to the writer: every rendered form drops it and
// keeps the prose around it, including a guarded flag at the start of a line.
const MD = `# Chapter <!--flag: better title-->

${FLAG_GUARD}<!--flag: who?--> was born in <!--flag: town--> in 1920.
`;

describe("writing flags in rendered output", () => {
	it("preview shows the prose, not the flags", () => {
		const html = renderPreviewHtml(MD);
		expect(html).not.toContain("flag");
		expect(html).toContain("was born in");
		expect(html).toContain("in 1920.");
	});

	it("HTML export drops them", () => {
		const html = generateExportHtml(MD, "T");
		expect(html).not.toContain("flag:");
		expect(html).toContain("was born in");
	});

	it("Word export drops them", async () => {
		const blob = await generateDocxBlob(MD, "T");
		const zip = await JSZip.loadAsync(await blob.arrayBuffer());
		const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
		expect(xml).toContain("was born in");
		expect(xml).not.toContain("flag");
	});
});
