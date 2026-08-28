/**
 * Writes the canonical Markdown corpus out as one `.md` file per case, for the
 * Swift snapshot tests to read.
 *
 * The source is `packages/editor-fixtures/markdown-corpus.json` (W3), which is
 * itself generated from `lib/markdown/corpus/cases.ts` — so the Swift tests and
 * the JS parity tests read the same cases. Swift cannot import either, hence
 * the checked-in `.md` files. Regenerate them whenever a case changes:
 *
 *     bun apple/Packages/RectoEditor/Tools/make-corpus.ts
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import corpus from "../../../../packages/editor-fixtures/markdown-corpus.json";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "Tests", "RectoEditorTests", "Corpus");

const slug = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

await mkdir(outDir, { recursive: true });
for (const stale of await readdir(outDir)) {
	if (stale.endsWith(".md")) await rm(join(outDir, stale));
}

for (const testCase of corpus.cases) {
	const file = `${String(testCase.id).padStart(2, "0")}-${slug(testCase.name)}.md`;
	await writeFile(join(outDir, file), testCase.input, "utf8");
}

console.log(`wrote ${corpus.cases.length} cases to ${outDir}`);
