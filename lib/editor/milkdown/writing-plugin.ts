import type { Node as PMNode } from "@milkdown/prose/model";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { WritingMark } from "@/lib/writing/marks";

export const writingPluginKey = new PluginKey<DecorationSet>("RECTO_WRITING");
/** Transaction meta key carrying fresh `WritingMark[]` for the rich editor. */
export const setWritingMeta = "recto-set-writing";
/** The Lab's cuts and findings: a layer of their own, pushed by the shell. */
export const labPluginKey = new PluginKey<DecorationSet>("RECTO_LAB");
export const setLabMeta = "recto-set-lab";

/**
 * Rich-mode positions are tree positions, not Markdown offsets, so each mark
 * is found by its text, in document order, within a single text leaf. Display
 * only: a passage that cannot be found this way is simply not drawn here; raw
 * and vim draw it exactly.
 */
function decorate(doc: PMNode, marks: WritingMark[]): DecorationSet {
	const segments: { text: string; pos: number }[] = [];
	doc.descendants((node, pos) => {
		if (node.isText && node.text) segments.push({ text: node.text, pos });
		return true;
	});
	const decorations: Decoration[] = [];
	let segment = 0;
	let offset = 0;
	for (const mark of marks) {
		if (mark.text.length === 0) continue;
		for (let index = segment; index < segments.length; index++) {
			const current = segments[index];
			if (!current) break;
			const at = current.text.indexOf(
				mark.text,
				index === segment ? offset : 0,
			);
			if (at === -1) continue;
			decorations.push(
				Decoration.inline(
					current.pos + at,
					current.pos + at + mark.text.length,
					{
						class: `recto-writing-${mark.kind}`,
						...(mark.index === undefined
							? {}
							: { "data-lab-cut": String(mark.index) }),
					},
				),
			);
			segment = index;
			offset = at + mark.text.length;
			break;
		}
	}
	return DecorationSet.create(doc, decorations);
}

export function writingPlugin(
	key = writingPluginKey,
	meta = setWritingMeta,
): Plugin<DecorationSet> {
	return new Plugin<DecorationSet>({
		key,
		state: {
			init: () => DecorationSet.empty,
			apply(tr, set) {
				const marks = tr.getMeta(meta) as WritingMark[] | undefined;
				if (marks) return decorate(tr.doc, marks);
				return set.map(tr.mapping, tr.doc);
			},
		},
		props: {
			decorations(state) {
				return key.getState(state) ?? null;
			},
		},
	});
}
