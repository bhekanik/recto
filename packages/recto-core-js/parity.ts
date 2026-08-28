/**
 * `bun run core:parity` — checks `dist/recto-core.js` against the fixtures and,
 * on macOS, against the same fixtures inside a real `JSContext`.
 *
 * Two things are proved on every run:
 *  1. The bundle produces exactly what `lib/` produces (it IS `lib/`, but the
 *     bundler picks package entry points, so this catches a wrong one).
 *  2. Nothing on any API path touches a DOM global — the realm has none.
 *
 * `--bench` adds the whole-document timings on two ~950 kB documents. They take
 * tens of seconds and are noise on a shared CI runner, so they are opt-in; the
 * numbers they produced are recorded in the README.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { analyze } from "@/lib/lint/analyze";
import type { LintOptions } from "@/lib/lint/types";
import { markdownFromHtml } from "@/lib/markdown/from-html";
import { renderPreviewHtml } from "@/lib/preview/render";
import corpus from "@/packages/editor-fixtures/markdown-corpus.json";
import outlineFixture from "@/packages/editor-fixtures/outline.json";
import streakFixture from "@/packages/editor-fixtures/streak.json";
import wordCountFixture from "@/packages/editor-fixtures/word-count.json";

import { BUNDLE_PATH, loadCore } from "./bare-realm";

const packageDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(packageDir, "..", "editor-fixtures");
const corpusPath = join(fixturesDir, "markdown-corpus.json");
const streakPath = join(fixturesDir, "streak.json");

/** Whole-document timings are opt-in — see the module comment. */
const bench = process.argv.includes("--bench");

const failures: string[] = [];
function expect(actual: unknown, expected: unknown, what: string): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) failures.push(`${what}\n    got      ${a}\n    expected ${b}`);
}

const core = await loadCore();
const bundleBytes = Bun.file(BUNDLE_PATH).size;
console.log(
	`bundle   ${(bundleBytes / 1024).toFixed(0)} kB, RectoCore ${core.version}`,
);

for (const testCase of corpus.cases) {
	const where = `corpus case ${testCase.id} (${testCase.name})`;
	expect(
		core.normalize(testCase.input),
		testCase.normalized,
		`${where}: normalize`,
	);
	expect(
		core.normalize(testCase.normalized),
		testCase.normalized,
		`${where}: normalize is idempotent`,
	);
	expect(
		core.countWords(testCase.input),
		testCase.words,
		`${where}: countWords`,
	);
	expect(
		core.parseOutline(testCase.input),
		testCase.outline,
		`${where}: parseOutline`,
	);
}
for (const testCase of corpus.unicode) {
	const where = `unicode case ${testCase.id} (${testCase.name})`;
	expect(
		core.normalize(testCase.input),
		testCase.normalized,
		`${where}: normalize`,
	);
	expect(
		core.countWords(testCase.input),
		testCase.words,
		`${where}: countWords`,
	);
	expect(
		core.parseOutline(testCase.input),
		testCase.outline,
		`${where}: parseOutline`,
	);
}
for (const testCase of wordCountFixture.cases) {
	expect(
		core.countWords(testCase.markdown),
		testCase.words,
		`word-count "${testCase.name}"`,
	);
}
for (const testCase of outlineFixture.cases) {
	expect(
		core.parseOutline(testCase.markdown),
		testCase.outline,
		`outline "${testCase.name}"`,
	);
}

// No committed fixture covers these three — a Swift port will never reimplement
// preview rendering, smart paste or prose lint, so they are not editor fixtures.
// Their expected values come straight from `lib/`, which is the authority, and
// are written to `dist/jsc-expected.json` so the JSC gate asserts the same exact
// payloads rather than "something came back".
const richHtml = "<h1>Title</h1><p>Some <b>bold</b> text<br>and a break.</p>";
const markdownSample = corpus.cases.map((c) => c.normalized).join("\n");
const lintSample =
	"The report was written by the committee. It was very clearly quite good.";
const everyCategory: LintOptions = {
	passive: true,
	readability: true,
	adverb: true,
	weasel: true,
};

const expected = {
	$source:
		"lib/preview/render.ts, lib/markdown/from-html.ts, lib/lint/analyze.ts",
	version: core.version,
	htmlFromMarkdown: {
		markdown: markdownSample,
		html: renderPreviewHtml(markdownSample),
	},
	markdownFromHtml: { html: richHtml, markdown: markdownFromHtml(richHtml) },
	lint: {
		markdown: lintSample,
		issues: await analyze(lintSample, everyCategory),
	},
};

expect(
	core.htmlFromMarkdown(markdownSample),
	expected.htmlFromMarkdown.html,
	"htmlFromMarkdown matches lib/preview/render",
);
expect(
	core.markdownFromHtml(richHtml),
	expected.markdownFromHtml.markdown,
	"markdownFromHtml matches lib/markdown/from-html",
);
expect(
	await core.lint(lintSample),
	expected.lint.issues,
	"lint matches lib/lint/analyze",
);
// The probe has to actually produce issues, or the JSC gate would be asserting
// that two empty arrays match.
expect(
	expected.lint.issues.length > 0,
	true,
	"the lint probe produces at least one issue",
);
for (const testCase of streakFixture.cases) {
	expect(
		core.streak(testCase.days, testCase.today),
		testCase.streak,
		`streak "${testCase.name}"`,
	);
}

/**
 * Prose at four sizes plus one adversarial document. Prose is what a writer
 * actually has open and is what the ms/kB figure comes from; the corpus
 * concatenation is the pathological shape (thousands of duplicate footnote and
 * link-reference definitions, which remark resolves super-linearly). All of them
 * are written next to the bundle so the Swift spike times the exact same bytes,
 * and every number quoted in the README comes from this function.
 */
function benchDocuments(): { name: string; markdown: string }[] {
	const vocabulary =
		"the quick brown fox jumps over a lazy dog while writing prose about rivers valleys storms and the quiet hum of an old machine".split(
			" ",
		);
	// Deterministic pseudo-random word picks (mulberry32) so timings are comparable
	// run to run and between the two runtimes.
	let seed = 0x9e3779b9;
	const next = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	let prose = "";
	for (let i = 0; prose.length < 950_000; i++) {
		if (i % 12 === 0) prose += `## Section ${i}\n\n`;
		const length = 40 + Math.floor(next() * 50);
		const words = Array.from(
			{ length },
			() => vocabulary[Math.floor(next() * vocabulary.length)],
		);
		prose += `${words.join(" ")}.\n\n`;
	}
	// A quarter the size on purpose: this document is about shape, not scale, and
	// at 950 kB it costs ~25 s per call in JSC.
	let adversarial = "";
	while (adversarial.length < 250_000) {
		for (const testCase of corpus.cases) adversarial += `${testCase.input}\n`;
	}
	// Prefixes of the same prose, so the size sweep varies one thing only.
	return [
		{ name: "bench-prose-64k.md", markdown: prose.slice(0, 64_000) },
		{ name: "bench-prose-256k.md", markdown: prose.slice(0, 256_000) },
		{ name: "bench-prose-512k.md", markdown: prose.slice(0, 512_000) },
		{ name: "bench-prose-950k.md", markdown: prose },
		{ name: "bench-corpus-250k.md", markdown: adversarial },
	];
}

/**
 * One run per document: at ~950 kB a single call already takes seconds, so
 * repeating it buys noise reduction nothing here needs. The numbers quoted in
 * the README are best-of-3 from a quiet machine.
 */
function callMs(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

const documentPaths: string[] = [];
if (bench) {
	for (const { name, markdown } of benchDocuments()) {
		const path = join(packageDir, "dist", name);
		await writeFile(path, markdown);
		documentPaths.push(path);
		const label = `${name} (${(markdown.length / 1024).toFixed(0)} kB)`.padEnd(
			34,
		);
		console.log(
			`call     ${label} normalize ${callMs(() => core.normalize(markdown))
				.toFixed(3)
				.padStart(8)} ms · ` +
				`countWords ${callMs(() => core.countWords(markdown))
					.toFixed(3)
					.padStart(8)} ms · ` +
				`parseOutline ${callMs(() => core.parseOutline(markdown))
					.toFixed(3)
					.padStart(8)} ms (node:vm realm under bun)`,
		);
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} parity failure(s):`);
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(
	`parity   ${corpus.cases.length}/${corpus.cases.length} corpus cases + idempotence sweep, ` +
		`${corpus.unicode.length} unicode, ${wordCountFixture.cases.length} word-count, ` +
		`${outlineFixture.cases.length} outline, ${streakFixture.cases.length} streak, ` +
		"and all 7 globals green in a DOM-free realm",
);

if (process.platform !== "darwin") {
	console.log("jsc      skipped — JavaScriptCore parity needs macOS");
	process.exit(0);
}

const expectedPath = join(packageDir, "dist", "jsc-expected.json");
await writeFile(expectedPath, `${JSON.stringify(expected, null, "\t")}\n`);

console.log("");
await $`swift run --package-path ${join(packageDir, "jsc")} -c release recto-core-parity ${BUNDLE_PATH} ${corpusPath} ${streakPath} ${expectedPath} ${documentPaths}`;
