import { Schema } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import { caretSectionRange } from "./caret-section";

const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: { content: "inline*", group: "block" },
		heading: {
			content: "inline*",
			group: "block",
			attrs: { level: { default: 1 } },
		},
		text: { group: "inline" },
	},
});

const p = (text: string) => schema.node("paragraph", null, [schema.text(text)]);
const h = (level: number, text: string) =>
	schema.node("heading", { level }, [schema.text(text)]);

const doc = schema.node("doc", null, [
	p("intro"),
	h(1, "One"),
	p("first"),
	h(2, "Sub"),
	p("nested"),
	h(1, "Two"),
	p("second"),
]);

/** Text of the top-level blocks inside a range, for readable assertions. */
function blocksIn(range: { from: number; to: number }): string[] {
	const out: string[] = [];
	doc.forEach((node, offset) => {
		if (offset >= range.from && offset + node.nodeSize <= range.to)
			out.push(node.textContent);
	});
	return out;
}

function posInside(text: string): number {
	let found = -1;
	doc.descendants((node, pos) => {
		if (node.isText && node.text === text) found = pos + 1;
	});
	return found;
}

describe("caretSectionRange", () => {
	it("covers the heading's section, nested subsections included", () => {
		expect(blocksIn(caretSectionRange(doc, posInside("first")))).toEqual([
			"One",
			"first",
			"Sub",
			"nested",
		]);
	});

	it("stops a subsection at the next heading of the same or higher level", () => {
		expect(blocksIn(caretSectionRange(doc, posInside("nested")))).toEqual([
			"Sub",
			"nested",
		]);
	});

	it("covers the blocks before the first heading", () => {
		expect(blocksIn(caretSectionRange(doc, posInside("intro")))).toEqual([
			"intro",
		]);
	});

	it("runs the last section to the end of the document", () => {
		expect(blocksIn(caretSectionRange(doc, posInside("second")))).toEqual([
			"Two",
			"second",
		]);
	});

	it("treats a caret in the heading as inside that section", () => {
		expect(blocksIn(caretSectionRange(doc, posInside("Two")))).toEqual([
			"Two",
			"second",
		]);
	});
});
