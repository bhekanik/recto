/**
 * Pure active-range logic for focus mode (plan 003). Given a flat document
 * string and a caret offset, returns the `[from, to)` character range of the
 * active sentence or paragraph. Both editors (CodeMirror + Milkdown/ProseMirror)
 * call this so segmentation rules live in exactly one place.
 *
 * Offsets are plain character offsets over a flat string. Sentence boundaries
 * use the platform `Intl.Segmenter` (no custom tokenizer) restricted to the
 * containing paragraph so a sentence never spans a blank line.
 */

export type FocusScope = "sentence" | "paragraph";
export type FocusRange = { from: number; to: number };

/** A paragraph block (split on blank lines) with its document offsets. */
type ParagraphBlock = { from: number; to: number; text: string };

/** Blank-line separator: a newline, optional inline whitespace, another newline. */
const BLANK_LINE = /\n[ \t]*\r?\n/g;

/**
 * Split `text` into paragraph blocks on blank lines, tracking each block's
 * document offsets. Whitespace-only blocks are skipped. The returned blocks are
 * trimmed of leading/trailing whitespace (offsets adjusted accordingly).
 */
function paragraphBlocks(text: string): ParagraphBlock[] {
	const blocks: ParagraphBlock[] = [];
	BLANK_LINE.lastIndex = 0;
	let cursor = 0;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
	while ((match = BLANK_LINE.exec(text)) !== null) {
		pushBlock(blocks, text, cursor, match.index);
		cursor = match.index + match[0].length;
	}
	pushBlock(blocks, text, cursor, text.length);
	return blocks;
}

/** Trim a `[rawFrom, rawTo)` slice and push it as a block if non-empty. */
function pushBlock(
	blocks: ParagraphBlock[],
	text: string,
	rawFrom: number,
	rawTo: number,
): void {
	const slice = text.slice(rawFrom, rawTo);
	const leading = slice.length - slice.trimStart().length;
	const trailing = slice.length - slice.trimEnd().length;
	const from = rawFrom + leading;
	const to = rawTo - trailing;
	if (to <= from) return;
	blocks.push({ from, to, text: text.slice(from, to) });
}

/**
 * The paragraph block containing `caret`. Prefers the block the caret sits at
 * the START of when on a boundary; falls back to the last block when the caret
 * is past every block (e.g. trailing blank lines).
 */
function blockAtCaret(
	blocks: ParagraphBlock[],
	caret: number,
): ParagraphBlock | null {
	if (blocks.length === 0) return null;
	for (const block of blocks) {
		// Inclusive of `to` so a caret at the end of a paragraph still maps to it.
		if (caret >= block.from && caret <= block.to) return block;
		// Caret falls in the gap before this block's start — claim it for this block.
		if (caret < block.from) return block;
	}
	return blocks[blocks.length - 1] ?? null;
}

// A single shared segmenter — locale-default sentence rules. Created lazily so a
// runtime without Intl.Segmenter fails only when sentence scope is actually used.
let sentenceSegmenter: Intl.Segmenter | null = null;
function getSentenceSegmenter(): Intl.Segmenter {
	if (!sentenceSegmenter) {
		sentenceSegmenter = new Intl.Segmenter(undefined, {
			granularity: "sentence",
		});
	}
	return sentenceSegmenter;
}

/**
 * The sentence range within `block` containing the (block-relative) caret.
 * Returns document-coordinate `[from, to)`, trimmed of trailing whitespace.
 */
function sentenceRangeInBlock(
	block: ParagraphBlock,
	caretInBlock: number,
): FocusRange {
	const segments = getSentenceSegmenter().segment(block.text);
	let chosen: { index: number; segment: string } | null = null;
	let last: { index: number; segment: string } | null = null;
	for (const { index, segment } of segments) {
		last = { index, segment };
		const start = index;
		const end = index + segment.length;
		// Prefer the sentence the caret is at the START of: [start, end).
		if (caretInBlock >= start && caretInBlock < end) {
			chosen = { index, segment };
			break;
		}
	}
	// Caret at the very end of the block lands on no half-open segment — use the
	// last sentence.
	const pick = chosen ?? last;
	if (!pick) return { from: block.from, to: block.to };
	const trailing = pick.segment.length - pick.segment.trimEnd().length;
	const from = block.from + pick.index;
	const to = block.from + pick.index + pick.segment.length - trailing;
	return { from, to: Math.max(from, to) };
}

/**
 * Char range `[from, to)` of the active unit (sentence or paragraph) containing
 * `caret` within the flat document `text`. Returns `null` when `text` is empty
 * or whitespace-only. `caret` is clamped into `[0, text.length]`.
 */
export function activeFocusRange(
	text: string,
	caret: number,
	scope: FocusScope,
): FocusRange | null {
	if (text.trim().length === 0) return null;
	const clamped = Math.min(Math.max(caret, 0), text.length);

	const blocks = paragraphBlocks(text);
	const block = blockAtCaret(blocks, clamped);
	if (!block) return null;

	if (scope === "paragraph") {
		return { from: block.from, to: block.to };
	}

	// Sentence scope: segment within the containing paragraph only.
	const caretInBlock = Math.min(
		Math.max(clamped - block.from, 0),
		block.text.length,
	);
	return sentenceRangeInBlock(block, caretInBlock);
}
