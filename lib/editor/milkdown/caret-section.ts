import type { Node as ProseMirrorNode } from "prosemirror-model";

/**
 * ProseMirror twin of `lib/outline/section.ts`: the range of top-level blocks in
 * the section holding `pos`. Rich mode has no Markdown offset for the caret, so
 * the section is found on the node tree and serialized from this range.
 */
export function caretSectionRange(
	doc: ProseMirrorNode,
	pos: number,
): { from: number; to: number } {
	const blocks: { node: ProseMirrorNode; from: number }[] = [];
	doc.forEach((node, from) => {
		blocks.push({ node, from });
	});
	const isHeading = (block: { node: ProseMirrorNode }) =>
		block.node.type.name === "heading";
	const caretIndex = blocks.findLastIndex((block) => block.from <= pos);
	const startIndex = blocks.findLastIndex(
		(block, index) => index <= caretIndex && isHeading(block),
	);
	const level: number | undefined = blocks[startIndex]?.node.attrs.level;
	const end = blocks.find(
		(block, index) =>
			index > caretIndex &&
			isHeading(block) &&
			(level === undefined || block.node.attrs.level <= level),
	);
	return {
		from: blocks[startIndex]?.from ?? 0,
		to: end?.from ?? doc.content.size,
	};
}
