import { analyze } from "@/lib/lint/analyze";
import type { AlternativeGroup } from "./state";

export type Scope = AlternativeGroup["scope"];
export type Range = { from: number; to: number };
export type AlternativeTargets = {
	ranges: Partial<Record<Scope, Range>>;
	initial: Scope;
};

function trimmed(text: string, from: number, to: number): Range {
	let start = from;
	let end = to;
	while (start < end && /\s/.test(text[start] ?? "")) start += 1;
	while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
	return { from: start, to: end };
}

/** The paragraph around `caret`: the run between blank lines, trimmed. */
export function paragraphAt(text: string, caret: number): Range | null {
	const before = text.lastIndexOf("\n\n", Math.max(0, caret - 1));
	const after = text.indexOf("\n\n", caret);
	const range = trimmed(
		text,
		before === -1 ? 0 : before + 2,
		after === -1 ? text.length : after,
	);
	return range.to > range.from ? range : null;
}

/** The sentence around `caret` inside its paragraph, by `Intl.Segmenter`. */
export function sentenceAt(text: string, caret: number): Range | null {
	const paragraph = paragraphAt(text, caret);
	if (!paragraph) return null;
	const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
	for (const part of segmenter.segment(
		text.slice(paragraph.from, paragraph.to),
	)) {
		const from = paragraph.from + part.index;
		const to = from + part.segment.length;
		if (from <= caret && caret <= to) {
			const range = trimmed(text, from, to);
			return range.to > range.from ? range : null;
		}
	}
	return null;
}

/** The word around `caret`, letters, digits and inner apostrophes. */
export function wordAt(text: string, caret: number): Range | null {
	const isWord = (ch: string | undefined) =>
		ch !== undefined && /[\p{L}\p{N}'’]/u.test(ch);
	let from = caret;
	let to = caret;
	while (from > 0 && isWord(text[from - 1])) from -= 1;
	while (to < text.length && isWord(text[to])) to += 1;
	return to > from ? { from, to } : null;
}

/**
 * The passages the panel can work on: the selection when there is one (a word
 * when it holds no whitespace, otherwise a sentence), else the word, sentence
 * and paragraph around the caret.
 */
export function alternativeTargets(
	text: string,
	selection: Range,
): AlternativeTargets | null {
	const caret = selection.from;
	const ranges: Partial<Record<Scope, Range>> = {};
	const word = wordAt(text, caret);
	const sentence = sentenceAt(text, caret);
	const paragraph = paragraphAt(text, caret);
	if (word) ranges.word = word;
	if (sentence) ranges.sentence = sentence;
	if (paragraph) ranges.paragraph = paragraph;
	if (selection.to > selection.from) {
		const scope: Scope = /\s/.test(text.slice(selection.from, selection.to))
			? "sentence"
			: "word";
		ranges[scope] = selection;
		return { ranges, initial: scope };
	}
	if (!word && !sentence && !paragraph) return null;
	return {
		ranges,
		initial: word ? "word" : sentence ? "sentence" : "paragraph",
	};
}

/**
 * The a/an to use before `wording` where the passage at `from` follows one, as
 * the prose linter's indefinite-article rule judges it. Null when nothing
 * changes.
 */
export async function articleFix(
	text: string,
	from: number,
	wording: string,
): Promise<{ from: number; to: number; text: string } | null> {
	const match = /(?:^|[^\p{L}\p{N}])(an?|AN?|An)(\s+)$/u.exec(
		text.slice(0, from),
	);
	const article = match?.[1];
	if (!match || article === undefined) return null;
	const at = from - (match[2]?.length ?? 0) - article.length;
	const issues = await analyze(`${article} ${wording}`, {
		passive: false,
		readability: true,
		adverb: false,
		weasel: false,
	});
	const issue = issues.find(
		(candidate) => candidate.from === 0 && candidate.to === article.length,
	);
	const expected = issue?.message.match(/expected `([^`]+)`/)?.[1];
	return expected
		? { from: at, to: at + article.length, text: expected }
		: null;
}
