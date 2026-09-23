/**
 * Deterministic checks on a finished AI transform, shown beside Keep / Reject.
 * The presets promise things ("correct grammar only", "preserve Markdown") that
 * nothing verified; these catch the breaches code can measure. They warn and
 * never block: the writer decides. Whether the *meaning* drifted is not
 * measurable here and is left to the writer reading the result.
 */

import { diffWords } from "diff";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";

import {
	countWords,
	countWordsFromPlainText,
} from "@/lib/markdown/count-words";
import { parseMarkdown } from "@/lib/markdown/parse";
import type { TransformPresetId } from "./instructions";

/**
 * Share of the original's words a grammar fix may replace before it counts as a
 * rewrite. Real corrections touch a few words per sentence; a third is already
 * generous. A judgment call, not a measured threshold.
 */
const GRAMMAR_REWRITE_RATIO = 1 / 3;

/** mdast node types whose loss is worth a warning, as [singular, plural]. */
const STRUCTURE_LABELS = {
	heading: ["heading", "headings"],
	code: ["code block", "code blocks"],
	inlineCode: ["inline code", "inline code"],
	link: ["link", "links"],
	image: ["image", "images"],
	list: ["list", "lists"],
	blockquote: ["blockquote", "blockquotes"],
	table: ["table", "tables"],
} as const;
type StructureType = keyof typeof STRUCTURE_LABELS;

const PREAMBLE =
	/^(here(['’]s| is| are)|sure|certainly|of course)\b[^\n]*:\s*(\n|$)/i;

function structureCounts(root: Root): Map<StructureType, number> {
	const counts = new Map<StructureType, number>();
	visit(root, (node) => {
		if (node.type in STRUCTURE_LABELS) {
			const type = node.type as StructureType;
			counts.set(type, (counts.get(type) ?? 0) + 1);
		}
	});
	return counts;
}

function droppedMarkdown(original: string, rewritten: string): string | null {
	const before = structureCounts(parseMarkdown(original));
	const after = structureCounts(parseMarkdown(rewritten));
	const dropped = [...before].flatMap(([type, count]) => {
		const lost = count - (after.get(type) ?? 0);
		if (lost <= 0) return [];
		const [one, many] = STRUCTURE_LABELS[type];
		return [`${lost} ${lost === 1 ? one : many}`];
	});
	return dropped.length > 0 ? `Dropped Markdown: ${dropped.join(", ")}.` : null;
}

/**
 * The words a reader sees, one space apart. Diffing the raw Markdown would
 * count syntax as words: dropping a link's brackets read as a full rewrite.
 */
function proseText(markdown: string): string {
	const words: string[] = [];
	visit(parseMarkdown(markdown), (node) => {
		if (node.type === "text" || node.type === "inlineCode")
			words.push(node.value);
	});
	return words.join(" ");
}

function rewrittenShare(original: string, rewritten: string): number {
	const before = proseText(original);
	const total = countWordsFromPlainText(before);
	if (total === 0) return 0;
	const removed = diffWords(before, proseText(rewritten))
		.filter((part) => part.removed)
		.reduce((sum, part) => sum + countWordsFromPlainText(part.value), 0);
	return removed / total;
}

export function transformWarnings(input: {
	presetId?: TransformPresetId;
	original: string;
	rewritten: string;
}): string[] {
	const { presetId, original, rewritten } = input;
	const warnings: string[] = [];

	if (PREAMBLE.test(rewritten.trimStart())) {
		warnings.push("Starts with a note from the model, not your text.");
	}

	if (presetId === "fix-grammar") {
		const share = rewrittenShare(original, rewritten);
		if (share > GRAMMAR_REWRITE_RATIO) {
			warnings.push(
				`Rewrote ${Math.round(share * 100)}% of the words. Fix grammar should only correct.`,
			);
		}
	}

	const before = countWords(original);
	const after = countWords(rewritten);
	if (presetId === "tighten" && after > before) {
		warnings.push(`Tighten made it longer: ${before} words became ${after}.`);
	}
	if (presetId === "expand" && after < before) {
		warnings.push(`Expand made it shorter: ${before} words became ${after}.`);
	}

	const dropped = droppedMarkdown(original, rewritten);
	if (dropped) warnings.push(dropped);

	return warnings;
}
