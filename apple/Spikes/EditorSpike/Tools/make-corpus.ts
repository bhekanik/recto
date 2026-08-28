// Writes the 25 canonical corpus cases and a generated 10k-word document into
// apple/Spikes/EditorSpike/Corpus/ so the spike can open them without a JS runtime.
// Run: bun apple/Spikes/EditorSpike/Tools/make-corpus.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS_CASES } from "../../../../lib/markdown/corpus/cases";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "Corpus");
mkdirSync(out, { recursive: true });

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

for (const c of CORPUS_CASES) {
	const name = `${String(c.id).padStart(2, "0")}-${slug(c.name)}.md`;
	writeFileSync(join(out, name), c.input);
}
console.log(`corpus cases: ${CORPUS_CASES.length}`);

// ── 10k-word document ────────────────────────────────────────────────────────
// Deterministic (seeded LCG) so every run of the spike measures the same bytes.
let seed = 20260828;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(xs: T[]): T => {
	const value = xs[Math.floor(rand() * xs.length)];
	if (value === undefined) throw new Error("pick called with an empty array");
	return value;
};

const WORDS =
	`the writing surface keeps every marker in the string so nothing is lost when a draft moves between
	 devices a paragraph is only text until someone reads it aloud and hears the rhythm break we cut the
	 sentence and the meaning stays revision is not deletion it is compression the editor should never
	 argue with the writer about where the caret belongs a page is a promise that the next line will be
	 worth the scroll drafts accumulate like sediment and the best ones are dug out later prose that
	 explains itself twice trusts the reader once markdown is a compromise everyone agreed to stop
	 negotiating`.split(/\s+/);

const sentence = () => {
	const n = 8 + Math.floor(rand() * 14);
	const ws: string[] = [];
	for (let i = 0; i < n; i++) {
		let w = pick(WORDS);
		const r = rand();
		if (r < 0.05) w = `**${w}**`;
		else if (r < 0.1) w = `*${w}*`;
		else if (r < 0.12) w = `\`${w}\``;
		else if (r < 0.14) w = `[${w}](https://recto.app/${w})`;
		else if (r < 0.15) w = `~~${w}~~`;
		ws.push(w);
	}
	return `${ws.join(" ")}.`;
};
const para = () => Array.from({ length: 3 + Math.floor(rand() * 3) }, sentence).join(" ");

const CODE = `func styleAttributes(text: String, scoped: [NSRange]?) -> [StyledRange] {
    let ast = DocumentAST.parse(text, scopedRanges: scoped)
    return ast.blocks.flatMap { style($0) }
}`;

const TABLE = `| Lens | Markers | Caret |
| --- | --- | --- |
| Rich | hidden | reveals the active block |
| Raw | visible | plain |
| Preview | hidden | none |`;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const parts: string[] = [
	"---",
	"title: Ten Thousand Words",
	"subtitle: A generated load document for the editor spike",
	"---",
	"",
	"# Ten Thousand Words",
	"",
];
let count = words(parts.join(" "));
let section = 0;
while (count < 10000) {
	section++;
	const chunk: string[] = [];
	chunk.push(`## Section ${section}`, "");
	chunk.push(para(), "");
	chunk.push(`### Notes for section ${section}`, "");
	chunk.push(para(), "");
	chunk.push(`- ${sentence()}`, `- ${sentence()}`, `  - ${sentence()}`, "");
	chunk.push(`1. ${sentence()}`, `2. ${sentence()}`, "");
	chunk.push(`- [ ] ${sentence()}`, `- [x] ${sentence()}`, "");
	chunk.push(`> ${sentence()}`, "");
	if (section % 3 === 0) chunk.push("```swift", CODE, "```", "");
	if (section % 4 === 0) chunk.push(TABLE, "");
	if (section % 5 === 0)
		chunk.push(`![A generated figure](https://recto.app/figure-${section}.png)`, "");
	chunk.push(para(), "");
	parts.push(...chunk);
	count += words(chunk.join(" "));
}

const doc = parts.join("\n");
writeFileSync(join(out, "load-10k.md"), doc);
console.log(
	`load-10k.md: ${words(doc)} words, ${doc.length} chars, ${doc.split("\n").length} lines`,
);
