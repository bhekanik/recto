import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { DOCX_MIME_TYPE, generateDocxBlob } from "./docx";

// jszip is guaranteed present as a dependency of docx (remark-docx's compiler);
// no zip dependency is added for these tests (plan 020 step 3).

const FIXTURE = `---
title: Secret Frontmatter Title
subtitle: Hidden subtitle
---

# Fixture Heading

Some **bold** and *italic* text with a [relative link](/doc/abc) and a footnote[^n].

| Left | Center | Right |
| :--- | :----: | ----: |
| l1   | c1     | r1    |

- [ ] open task
- [x] done task

![diagram alt text](/storage/diagram.png)

[^n]: The footnote body text lives here.
`;

async function unzipEntry(blob: Blob, path: string): Promise<string> {
	const zip = await JSZip.loadAsync(await blob.arrayBuffer());
	const entry = zip.file(path);
	expect(entry, `${path} missing from archive`).not.toBeNull();
	if (!entry) throw new Error(`${path} missing from archive`);
	return entry.async("string");
}

describe("generateDocxBlob", () => {
	it("produces a non-empty blob with the Word MIME type", async () => {
		const blob = await generateDocxBlob(FIXTURE, "Fallback");
		expect(blob.type).toBe(DOCX_MIME_TYPE);
		expect(blob.size).toBeGreaterThan(0);
	});

	it("emits real OOXML: heading in document.xml, footnote in footnotes.xml", async () => {
		const blob = await generateDocxBlob(FIXTURE, "Fallback");
		const documentXml = await unzipEntry(blob, "word/document.xml");
		const footnotesXml = await unzipEntry(blob, "word/footnotes.xml");

		expect(documentXml).toContain("Fixture Heading");
		// Real Word footnotes — not inline superscript-link degradation.
		expect(footnotesXml).toContain("The footnote body text lives here.");
		// GFM table alignment survives into OOXML justification values.
		for (const align of ["left", "center", "right"]) {
			expect(documentXml).toContain(`<w:jc w:val="${align}"/>`);
		}
		// Task list items render (checkbox glyphs live in word/numbering.xml).
		expect(documentXml).toContain("open task");
		expect(documentXml).toContain("done task");
	});

	it("never renders frontmatter into the document body", async () => {
		const blob = await generateDocxBlob(FIXTURE, "Fallback");
		const documentXml = await unzipEntry(blob, "word/document.xml");
		expect(documentXml).not.toContain("Secret Frontmatter Title");
		expect(documentXml).not.toContain("Hidden subtitle");
	});

	it("rewrites images to hyperlinks and absolutizes relative link urls", async () => {
		const blob = await generateDocxBlob(FIXTURE, "Fallback");
		const documentXml = await unzipEntry(blob, "word/document.xml");
		const relsXml = await unzipEntry(blob, "word/_rels/document.xml.rels");

		const origin = window.location.origin;
		// v1 image posture: alt text as hyperlink to the absolute URL.
		expect(documentXml).toContain("diagram alt text");
		expect(relsXml).toContain(
			`Target="${new URL("/storage/diagram.png", origin).href}"`,
		);
		// Root-relative links resolve against the app origin (pitfall 2.1.4).
		expect(relsXml).toContain(`Target="${new URL("/doc/abc", origin).href}"`);
	});
});
