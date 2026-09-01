import type { Parser } from "@milkdown/transformer";
import {
	Fragment,
	type Mark,
	type Node as ProseMirrorNode,
	Slice,
} from "prosemirror-model";
import type { Selection } from "prosemirror-state";

const OPEN_SENTINEL = "\uE000";
const CLOSE_SENTINEL = "\uE001";

function textblockAtSelection(
	doc: ProseMirrorNode,
	selection: Selection,
): { depth: number; node: ProseMirrorNode; start: number; end: number } | null {
	const $from = doc.resolve(selection.from);
	const $to = doc.resolve(selection.to);
	for (let depth = Math.min($from.depth, $to.depth); depth > 0; depth -= 1) {
		if ($from.node(depth) !== $to.node(depth)) continue;
		const node = $from.node(depth);
		if (!node.isTextblock) continue;
		return {
			depth,
			node,
			start: $from.start(depth),
			end: $from.end(depth),
		};
	}
	return null;
}

function onlyTextblock(doc: ProseMirrorNode): ProseMirrorNode | null {
	if (doc.childCount !== 1) return null;
	const child = doc.child(0);
	return child.isTextblock ? child : null;
}

function sentinelOffset(
	node: ProseMirrorNode,
	sentinel: string,
): number | null {
	let offset: number | null = null;
	node.descendants((child, position) => {
		if (!child.isText || offset !== null) return offset === null;
		const index = child.text?.indexOf(sentinel) ?? -1;
		if (index >= 0) offset = position + index;
		return offset === null;
	});
	return offset;
}

function inheritMarks(fragment: Fragment, marks: readonly Mark[]): Fragment {
	if (marks.length === 0) return fragment;
	const nodes: ProseMirrorNode[] = [];
	fragment.forEach((node) => {
		if (node.isText && node.marks.length === 0) {
			nodes.push(node.mark(marks));
			return;
		}
		if (node.content.size > 0 && !node.isText) {
			nodes.push(node.copy(inheritMarks(node.content, marks)));
			return;
		}
		nodes.push(node);
	});
	return Fragment.fromArray(nodes);
}

function partialInlineContent(
	parse: Parser,
	replacement: string,
	marks: readonly Mark[],
): Fragment | null {
	const parsed = parse(`${OPEN_SENTINEL}${replacement}${CLOSE_SENTINEL}`);
	if (!parsed) return null;
	const block = onlyTextblock(parsed);
	if (!block) return null;
	const open = sentinelOffset(block, OPEN_SENTINEL);
	const close = sentinelOffset(block, CLOSE_SENTINEL);
	if (open === null || close === null || close < open) return null;
	return inheritMarks(block.content.cut(open + 1, close), marks);
}

/**
 * Build a throwaway replacement document for Milkdown. Exact text-block
 * selections replace only that block's content, so headings, code blocks, list
 * items and blockquotes remain the same nodes. Partial selections use sentinels
 * to keep boundary spaces, parsed marks and hard breaks intact.
 */
export function replaceMarkdownSelection(args: {
	doc: ProseMirrorNode;
	selection: Selection;
	replacement: string;
	parse: Parser;
}): ProseMirrorNode | null {
	const { doc, selection, replacement, parse } = args;
	if (selection.empty) return null;
	const block = textblockAtSelection(doc, selection);
	if (block) {
		const exact = selection.from === block.start && selection.to === block.end;
		let content: Fragment | null;
		if (exact) {
			const parsed = parse(replacement);
			if (!parsed) return null;
			const parsedBlock = onlyTextblock(parsed);
			if (!parsedBlock) {
				try {
					return doc.replace(
						doc.resolve(selection.from).before(block.depth),
						doc.resolve(selection.to).after(block.depth),
						new Slice(parsed.content, 0, 0),
					);
				} catch {
					return null;
				}
			}
			content = block.node.type.spec.code
				? Fragment.from(block.node.type.schema.text(parsedBlock.textContent))
				: parsedBlock.content;
		} else {
			const $from = doc.resolve(selection.from);
			const $to = doc.resolve(selection.to);
			content = partialInlineContent(
				parse,
				replacement,
				$from.marksAcross($to) ?? $from.marks(),
			);
		}
		if (!content) return null;
		return doc.replace(selection.from, selection.to, new Slice(content, 0, 0));
	}

	const parsed = parse(replacement);
	if (!parsed) return null;
	try {
		return doc.replace(
			selection.from,
			selection.to,
			new Slice(parsed.content, 0, 0),
		);
	} catch {
		return null;
	}
}
