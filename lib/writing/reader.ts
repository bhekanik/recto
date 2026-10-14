/** A UTF-16 range of canonical Markdown, `from` inclusive, `to` exclusive. */
export type TextRange = { from: number; to: number };

/**
 * The text a reader gets: ghosted passages removed. Where a removal leaves two
 * spaces side by side one goes, so "Keep. Cut. Keep." reads "Keep. Keep.".
 * Mirrors `WritingState.readerMarkdown` on the Mac.
 */
export function readerMarkdown(
	markdown: string,
	ghosts: readonly TextRange[],
): string {
	let text = markdown;
	const ordered = [...ghosts].sort((a, b) => b.from - a.from);
	for (const ghost of ordered) {
		if (ghost.from < 0 || ghost.to <= ghost.from || ghost.to > text.length)
			continue;
		let to = ghost.to;
		if (ghost.from > 0 && text[ghost.from - 1] === " " && text[to] === " ")
			to += 1;
		text = text.slice(0, ghost.from) + text.slice(to);
	}
	return text;
}
