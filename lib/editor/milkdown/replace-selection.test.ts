import { type Node as ProseMirrorNode, Schema } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { replaceMarkdownSelection } from "./replace-selection";

const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: { content: "inline*", group: "block" },
		heading: {
			content: "inline*",
			group: "block",
			attrs: { level: { default: 2 } },
		},
		blockquote: { content: "block+", group: "block" },
		bullet_list: { content: "list_item+", group: "block" },
		list_item: { content: "paragraph block*" },
		code_block: { content: "text*", group: "block", code: true },
		text: { group: "inline" },
		hard_break: { inline: true, group: "inline", selectable: false },
	},
	marks: {
		strong: {},
		em: {},
	},
});

function paragraph(...content: ProseMirrorNode[]) {
	return schema.node("paragraph", null, content);
}

function parser(value: string): ProseMirrorNode {
	if (value.includes("\\\n")) {
		const [before = "", after = ""] = value.split("\\\n");
		return schema.node("doc", null, [
			paragraph(
				schema.text(before),
				schema.node("hard_break"),
				schema.text(after),
			),
		]);
	}
	return schema.node("doc", null, [paragraph(schema.text(value))]);
}

function replaceWholeTextblock(
	doc: ProseMirrorNode,
	start: number,
	end: number,
) {
	return replaceMarkdownSelection({
		doc,
		selection: TextSelection.create(doc, start, end),
		replacement: "replacement",
		parse: parser,
	});
}

describe("replaceMarkdownSelection", () => {
	it("keeps a heading node for a full heading selection", () => {
		const doc = schema.node("doc", null, [
			schema.node("heading", { level: 2 }, schema.text("heading")),
		]);
		const next = replaceWholeTextblock(doc, 1, 8);
		expect(next?.child(0).type.name).toBe("heading");
		expect(next?.child(0).attrs.level).toBe(2);
		expect(next?.child(0).textContent).toBe("replacement");
	});

	it("keeps code, list and blockquote containers", () => {
		const code = schema.node("doc", null, [
			schema.node("code_block", null, schema.text("code")),
		]);
		expect(replaceWholeTextblock(code, 1, 5)?.child(0).type.name).toBe(
			"code_block",
		);

		const quote = schema.node("doc", null, [
			schema.node("blockquote", null, [paragraph(schema.text("quote"))]),
		]);
		const quoted = replaceWholeTextblock(quote, 2, 7);
		expect(quoted?.child(0).type.name).toBe("blockquote");
		expect(quoted?.child(0).child(0).textContent).toBe("replacement");

		const list = schema.node("doc", null, [
			schema.node("bullet_list", null, [
				schema.node("list_item", null, [paragraph(schema.text("item"))]),
			]),
		]);
		const listed = replaceWholeTextblock(list, 3, 7);
		expect(listed?.child(0).type.name).toBe("bullet_list");
		expect(listed?.child(0).child(0).child(0).textContent).toBe("replacement");
	});

	it("keeps boundary spaces for a partial inline selection", () => {
		const doc = schema.node("doc", null, [
			paragraph(schema.text("one old two")),
		]);
		const next = replaceMarkdownSelection({
			doc,
			selection: TextSelection.create(doc, 5, 8),
			replacement: " new ",
			parse: parser,
		});
		expect(next?.textContent).toBe("one  new  two");
	});

	it("inherits surrounding marks and retains parsed hard breaks", () => {
		const strong = schema.mark("strong");
		const doc = schema.node("doc", null, [
			paragraph(schema.text("old text", [strong])),
		]);
		const marked = replaceMarkdownSelection({
			doc,
			selection: TextSelection.create(doc, 2, 4),
			replacement: "new",
			parse: parser,
		});
		expect(
			marked
				?.child(0)
				.child(0)
				.marks.map((mark) => mark.type.name),
		).toContain("strong");

		const breaks = replaceMarkdownSelection({
			doc: schema.node("doc", null, [paragraph(schema.text("old text"))]),
			selection: TextSelection.create(
				schema.node("doc", null, [paragraph(schema.text("old text"))]),
				2,
				4,
			),
			replacement: "a\\\nb",
			parse: parser,
		});
		expect(breaks?.child(0).childCount).toBe(3);
		expect(breaks?.child(0).child(1).type.name).toBe("hard_break");
	});

	it("uses the captured selection when the live selection later moves", () => {
		const doc = schema.node("doc", null, [
			paragraph(schema.text("old and old")),
		]);
		const captured = TextSelection.create(doc, 9, 12);
		TextSelection.create(doc, 1, 4);
		const next = replaceMarkdownSelection({
			doc,
			selection: captured,
			replacement: "new",
			parse: parser,
		});
		expect(next?.textContent).toBe("old and new");
	});
});
