import retextEnglish from "retext-english";
import retextIndefiniteArticle from "retext-indefinite-article";
import retextPassive from "retext-passive";
import retextReadability from "retext-readability";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import type { VFileMessage } from "vfile-message";
import { parseMarkdown } from "@/lib/markdown/parse";
import type { LintCategory, LintIssue, LintOptions } from "./types";

/**
 * write-good is loaded lazily (not a top-level import) on purpose: its transitive
 * dependency `adverb-where` builds a RegExp from a template-literal concatenation
 * at module-eval, and Turbopack's production SSR minifier corrupts that string
 * ("Invalid regular expression: Unterminated group" during prerender). Deferring
 * the import to first call keeps the module out of the SSR-evaluated graph; it
 * still runs fine unminified in the worker, the tests, and dev. retext is
 * SSR-safe and stays a top-level import.
 */
type WriteGood = typeof import("write-good")["default"];
let writeGoodPromise: Promise<WriteGood> | null = null;
function loadWriteGood(): Promise<WriteGood> {
	if (!writeGoodPromise) {
		writeGoodPromise = import("write-good").then((m) => m.default);
	}
	return writeGoodPromise;
}

/**
 * One frozen retext processor, built once at module scope and reused per call
 * (mirrors `lib/markdown/parse.ts`). retext is the unified-family standard for
 * prose analysis and yields precise character offsets into the analyzed string.
 *
 * `age: 14` is the readability threshold — `age: 18` (the textbook tolerant
 * setting) never flags ordinary long sentences, so a calm "slow down" hint needs
 * a stricter reading level. 14 ≈ a strong high-school level: it flags genuinely
 * dense sentences without lighting up normal prose.
 */
const retextProcessor = unified()
	.use(retextEnglish)
	.use(retextPassive)
	.use(retextReadability, { age: 14 })
	.use(retextIndefiniteArticle);

/** Read an inclusive `[start, end)` offset pair from a retext message, or null. */
function offsetsOf(message: VFileMessage): { from: number; to: number } | null {
	const place = message.place;
	if (!place || !("start" in place) || !("end" in place)) return null;
	const from = place.start?.offset;
	const to = place.end?.offset;
	if (typeof from !== "number" || typeof to !== "number") return null;
	return { from, to };
}

/** Map a retext message source to a lint category (or null to drop it). */
function retextCategory(source: string | undefined): LintCategory | null {
	if (source === "retext-passive") return "passive";
	if (source === "retext-readability") return "readability";
	// indefinite-article ("a apple" → "an apple") is a grammar/readability nicety.
	if (source === "retext-indefinite-article") return "readability";
	return null;
}

/** Run the retext rule plugins synchronously and collect their issues. */
function retextIssues(text: string): LintIssue[] {
	const file = new VFile(text);
	const tree = retextProcessor.parse(file);
	retextProcessor.runSync(tree, file);
	const issues: LintIssue[] = [];
	for (const message of file.messages) {
		const category = retextCategory(message.source ?? undefined);
		if (!category) continue;
		const range = offsetsOf(message);
		if (!range || range.from >= range.to) continue;
		issues.push({
			from: range.from,
			to: range.to,
			category,
			message: message.reason,
			text: text.slice(range.from, range.to),
		});
	}
	return issues;
}

/**
 * Classify a write-good suggestion. "weasel word" wins when present (write-good
 * merges overlapping checks into one reason, e.g. a word flagged as both weasel
 * and adverb); a pure "weaken meaning" reason is an adverb; everything else
 * (filler, wordiness, clichés, repetition) folds into weasel.
 */
function writeGoodCategory(reason: string): LintCategory {
	if (/weasel word/i.test(reason)) return "weasel";
	if (/weaken meaning/i.test(reason)) return "adverb";
	return "weasel";
}

/** Run write-good (adverbs + weasel/filler/cliché). retext owns passive. */
async function writeGoodIssues(text: string): Promise<LintIssue[]> {
	const writeGood = await loadWriteGood();
	const suggestions = writeGood(text, { passive: false });
	const issues: LintIssue[] = [];
	for (const s of suggestions) {
		const from = s.index;
		const to = s.index + s.offset;
		if (from >= to || from < 0 || to > text.length) continue;
		issues.push({
			from,
			to,
			category: writeGoodCategory(s.reason),
			message: s.reason,
			text: text.slice(from, to),
		});
	}
	return issues;
}

/**
 * Blank out everything that is not the writer's prose: code, raw HTML, link and
 * image destinations. retext and write-good read a plain string, so without this
 * they lint shell comments inside a fence and count a URL's syllables against the
 * sentence that links it. Each masked character becomes one space (newlines kept),
 * so every offset still points into the original string.
 */
function maskNonProse(text: string): string {
	const ranges: [number, number][] = [];
	const mask = (from: number | undefined, to: number | undefined) => {
		if (from !== undefined && to !== undefined && from < to)
			ranges.push([from, to]);
	};
	visit(parseMarkdown(text), (node) => {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (
			node.type === "code" ||
			node.type === "inlineCode" ||
			node.type === "html" ||
			node.type === "yaml" ||
			node.type === "definition" ||
			node.type === "image" ||
			node.type === "imageReference"
		) {
			mask(start, end);
			return;
		}
		if (node.type === "link") {
			const label = node.children;
			const only = label.length === 1 ? label[0] : undefined;
			// An autolink's label IS the URL, so there is no prose in it to keep.
			if (only?.type === "text" && node.url.endsWith(only.value)) {
				mask(start, end);
				return;
			}
			mask(start, label[0]?.position?.start.offset ?? end);
			mask(label.at(-1)?.position?.end.offset ?? start, end);
		}
	});
	if (ranges.length === 0) return text;
	const chars = text.split("");
	for (const [from, to] of ranges) {
		for (let i = from; i < to; i++) {
			if (chars[i] !== "\n") chars[i] = " ";
		}
	}
	return chars.join("");
}

/**
 * Analyze prose for highlightable mechanics issues (passive voice, hard-to-read
 * sentences, adverbs, weasel/filler words). Pure: text in, issues out, with
 * offsets into the exact string passed. The caller decides whether to feed the
 * full canonical Markdown (CodeMirror) or just the body (Milkdown). Async only
 * because write-good is lazily imported (see `loadWriteGood`).
 */
export async function analyze(
	text: string,
	options: LintOptions,
): Promise<LintIssue[]> {
	if (text.trim() === "") return [];

	const prose = maskNonProse(text);
	const all = [...retextIssues(prose), ...(await writeGoodIssues(prose))]
		.filter((issue) => options[issue.category])
		// A sentence-wide range can span a masked link; `text` must stay the source
		// substring because Milkdown re-finds the range by searching for it.
		.map((issue) => ({ ...issue, text: text.slice(issue.from, issue.to) }));
	all.sort((a, b) => a.from - b.from || a.to - b.to);

	// De-dupe exact [from, to, category] triples (passive can be double-reported).
	const seen = new Set<string>();
	const result: LintIssue[] = [];
	for (const issue of all) {
		const key = `${issue.from}:${issue.to}:${issue.category}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(issue);
	}
	return result;
}
