import { type WritingHistory, writingStateFor } from "./state";

/**
 * A passage the editors draw: a ghost (faded) or a passage with alternatives
 * (underlined, accented while it shows a wording other than the original).
 * `text` lets the rich editor find the passage, whose positions are not
 * Markdown offsets.
 */
export type WritingMark = {
	from: number;
	to: number;
	kind:
		| "ghost"
		| "alternative"
		| "alternative-variant"
		| "lab-cut"
		| "lab-kept"
		| "lab-finding";
	text: string;
	/** A Lab cut's index, drawn as `data-lab-cut` so a click can name it. */
	index?: number;
};

export function writingMarksFor(
	markdown: string,
	history: WritingHistory | null,
): WritingMark[] {
	const state = writingStateFor(markdown, history);
	if (!state) return [];
	const marks: WritingMark[] = [];
	for (const ghost of state.ghosts) {
		const to = ghost.location + ghost.length;
		if (to <= markdown.length)
			marks.push({
				from: ghost.location,
				to,
				kind: "ghost",
				text: markdown.slice(ghost.location, to),
			});
	}
	for (const group of state.alternatives) {
		const to = group.location + group.length;
		if (group.detached || to > markdown.length) continue;
		marks.push({
			from: group.location,
			to,
			kind:
				group.candidates[0]?.id === group.activeId
					? "alternative"
					: "alternative-variant",
			text: markdown.slice(group.location, to),
		});
	}
	return marks.sort((a, b) => a.from - b.from);
}
