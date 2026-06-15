import { defaultValueCtx, Editor, rootCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown, replaceAll } from "@milkdown/utils";
import { describe, expect, it } from "vitest";

import { countWords, normalizeMarkdown } from "@/lib/markdown";

const SAMPLE = `# Hello Recto

This is **bold** prose with _emphasis_.

- one
- two
`;

describe("Milkdown seed smoke", () => {
	it("seed then serialize returns canonical markdown", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const normalized = normalizeMarkdown(SAMPLE);

		const editor = await Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, container);
				ctx.set(defaultValueCtx, "");
			})
			.use(commonmark)
			.use(gfm)
			.create();

		editor.action(replaceAll(normalized, false));
		const raw = editor.action(getMarkdown());
		const out = normalizeMarkdown(raw);

		// Milkdown may insert extra blank lines in lists; canonical pipeline must round-trip stably.
		expect(normalizeMarkdown(out)).toBe(out);
		expect(out).toContain("# Hello Recto");
		expect(out).toContain("**bold**");
		expect(out).toMatch(/- one/);
		expect(out).toMatch(/- two/);
		expect(countWords(out)).toBe(countWords(normalized));

		await editor.destroy();
		container.remove();
	});
});
