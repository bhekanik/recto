/**
 * Paragraph-windowed chunking for RAG over the writer's own drafts (plan 009,
 * Phase C). Pure + deterministic so it can be unit-tested and run identically on
 * client and server. Splits canonical Markdown on blank lines, then greedily
 * packs paragraphs into ~1–2k-char windows with ~1-paragraph overlap. Paragraph
 * boundaries are natural prose units and map cleanly to "scroll to this passage"
 * citations (each chunk carries exact `charStart`/`charEnd` offsets into the
 * source).
 */

export type Chunk = {
	charStart: number;
	charEnd: number;
	text: string;
};

/** Target window size in characters (greedy upper bound). */
export const CHUNK_TARGET_CHARS = 1500;

type Paragraph = { start: number; end: number; text: string };

/** Split into paragraphs on blank-line boundaries, keeping source offsets. */
function splitParagraphs(markdown: string): Paragraph[] {
	const paras: Paragraph[] = [];
	const len = markdown.length;
	let i = 0;
	while (i < len) {
		// Skip whitespace between paragraphs (blank lines, leading newlines).
		while (i < len && /\s/.test(markdown[i] as string)) i++;
		if (i >= len) break;
		const start = i;
		// Consume until a blank line (a newline whose following line is whitespace
		// only) or EOF.
		while (i < len) {
			if (markdown[i] === "\n") {
				let j = i + 1;
				while (
					j < len &&
					markdown[j] !== "\n" &&
					/\s/.test(markdown[j] as string)
				) {
					j++;
				}
				if (j >= len || markdown[j] === "\n") break; // paragraph boundary
			}
			i++;
		}
		const end = i;
		const text = markdown.slice(start, end);
		if (text.trim().length > 0) paras.push({ start, end, text });
	}
	return paras;
}

/**
 * Greedily pack paragraphs into windows of up to ~CHUNK_TARGET_CHARS, overlapping
 * by one paragraph so a passage that straddles a boundary is still retrievable.
 */
export function chunk(markdown: string): Chunk[] {
	const paras = splitParagraphs(markdown);
	if (paras.length === 0) return [];

	const chunks: Chunk[] = [];
	let i = 0;
	while (i < paras.length) {
		const windowStart = paras[i]?.start ?? 0;
		// Always include at least one paragraph, even if it exceeds the target.
		let windowEnd = paras[i]?.end ?? 0;
		let j = i + 1;
		while (j < paras.length) {
			const next = paras[j];
			if (!next) break;
			if (next.end - windowStart > CHUNK_TARGET_CHARS) break;
			windowEnd = next.end;
			j++;
		}
		chunks.push({
			charStart: windowStart,
			charEnd: windowEnd,
			text: markdown.slice(windowStart, windowEnd),
		});
		if (j >= paras.length) break;
		// Overlap by one paragraph: the last paragraph of this window opens the
		// next. Guard against no-progress when a window held a single paragraph.
		i = j - 1 > i ? j - 1 : j;
	}
	return chunks;
}
