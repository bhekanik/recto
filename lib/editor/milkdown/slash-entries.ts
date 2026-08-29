import { commandsCtx, editorViewCtx } from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import {
	blockquoteSchema,
	bulletListSchema,
	clearTextInCurrentBlockCommand,
	codeBlockSchema,
	headingSchema,
	hrSchema,
	listItemSchema,
	orderedListSchema,
	paragraphSchema,
	setBlockTypeCommand,
	wrapInBlockTypeCommand,
} from "@milkdown/preset-commonmark";
import { insertTableCommand } from "@milkdown/preset-gfm";

export type SlashInsertion =
	| { readonly kind: "heading"; readonly level: 1 | 2 | 3 }
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "wrap";
			readonly block: "bullet-list" | "ordered-list";
			readonly inner: "list-item";
	  }
	| {
			readonly kind: "wrap";
			readonly block: "blockquote";
			readonly inner: "paragraph";
	  }
	| { readonly kind: "code-block"; readonly language: string }
	| { readonly kind: "divider" }
	| { readonly kind: "table"; readonly rows: number; readonly columns: number };

export type SlashEntryDefinition = {
	readonly id: string;
	readonly label: string;
	readonly aliases: readonly string[];
	readonly insertion: SlashInsertion;
};

export type SlashContract = {
	readonly clearCurrentBlock: true;
	readonly entries: readonly SlashEntryDefinition[];
};

export type SlashEntry = Omit<SlashEntryDefinition, "insertion"> & {
	readonly run: (ctx: Ctx) => void;
};

function runSlashInsertion(ctx: Ctx, insertion: SlashInsertion): void {
	const commands = ctx.get(commandsCtx);
	if (SLASH_CONTRACT.clearCurrentBlock) {
		commands.call(clearTextInCurrentBlockCommand.key);
	}

	switch (insertion.kind) {
		case "heading":
			commands.call(setBlockTypeCommand.key, {
				nodeType: headingSchema.type(ctx),
				attrs: { level: insertion.level },
			});
			return;
		case "text": {
			const view = ctx.get(editorViewCtx);
			const tr = view.state.tr.insertText(insertion.text);
			view.dispatch(tr);
			return;
		}
		case "wrap": {
			const block = {
				"bullet-list": bulletListSchema,
				"ordered-list": orderedListSchema,
				blockquote: blockquoteSchema,
			}[insertion.block];
			const inner = {
				"list-item": listItemSchema,
				paragraph: paragraphSchema,
			}[insertion.inner];
			commands.call(wrapInBlockTypeCommand.key, {
				nodeType: block.type(ctx),
				innerNodeType: inner.type(ctx),
			});
			return;
		}
		case "code-block": {
			commands.call(setBlockTypeCommand.key, {
				nodeType: codeBlockSchema.type(ctx),
				attrs: { language: insertion.language },
			});
			return;
		}
		case "divider": {
			commands.call(setBlockTypeCommand.key, {
				nodeType: hrSchema.type(ctx),
			});
			return;
		}
		case "table": {
			commands.call(insertTableCommand.key, {
				row: insertion.rows,
				col: insertion.columns,
			});
			return;
		}
	}
	insertion satisfies never;
}

/** 17 authoritative slash entries — blueprint 13-keyboard-commands §5.1. */
const slashContract = {
	clearCurrentBlock: true,
	entries: [
		{
			id: "h1",
			label: "Heading 1",
			aliases: ["h1", "title"],
			insertion: { kind: "heading", level: 1 },
		},
		{
			id: "h2",
			label: "Heading 2",
			aliases: ["h2", "subtitle"],
			insertion: { kind: "heading", level: 2 },
		},
		{
			id: "h3",
			label: "Heading 3",
			aliases: ["h3"],
			insertion: { kind: "heading", level: 3 },
		},
		{
			id: "bold",
			label: "Bold",
			aliases: ["b", "strong"],
			insertion: { kind: "text", text: "**text**" },
		},
		{
			id: "italic",
			label: "Italic",
			aliases: ["i", "em", "emphasis"],
			insertion: { kind: "text", text: "_text_" },
		},
		{
			id: "strike",
			label: "Strikethrough",
			aliases: ["strike", "del", "s"],
			insertion: { kind: "text", text: "~~text~~" },
		},
		{
			id: "code",
			label: "Inline code",
			aliases: ["code", "mono"],
			insertion: { kind: "text", text: "`code`" },
		},
		{
			id: "bullet",
			label: "Bullet list",
			aliases: ["ul", "unordered", "list"],
			insertion: {
				kind: "wrap",
				block: "bullet-list",
				inner: "list-item",
			},
		},
		{
			id: "ordered",
			label: "Numbered list",
			aliases: ["ol", "ordered", "number"],
			insertion: {
				kind: "wrap",
				block: "ordered-list",
				inner: "list-item",
			},
		},
		{
			id: "task",
			label: "Task list",
			aliases: ["todo", "checkbox", "check"],
			insertion: { kind: "text", text: "- [ ] " },
		},
		{
			id: "quote",
			label: "Blockquote",
			aliases: ["quote", "bq"],
			insertion: {
				kind: "wrap",
				block: "blockquote",
				inner: "paragraph",
			},
		},
		{
			id: "fence",
			label: "Code block",
			aliases: ["pre", "fence", "codeblock"],
			insertion: { kind: "code-block", language: "" },
		},
		{
			id: "divider",
			label: "Divider",
			aliases: ["hr", "rule", "separator"],
			insertion: { kind: "divider" },
		},
		{
			id: "table",
			label: "Table",
			aliases: ["tbl", "grid"],
			insertion: { kind: "table", rows: 2, columns: 2 },
		},
		{
			id: "link",
			label: "Link",
			aliases: ["url", "href", "a"],
			insertion: { kind: "text", text: "[text](https://)" },
		},
		{
			id: "image",
			label: "Image",
			aliases: ["img", "picture"],
			insertion: { kind: "text", text: "![alt](https://)" },
		},
		{
			id: "footnote",
			label: "Footnote",
			aliases: ["fn", "note", "ref"],
			insertion: { kind: "text", text: "[^1]\n\n[^1]: Footnote text" },
		},
	],
} as const satisfies SlashContract;

for (const entry of slashContract.entries) {
	Object.freeze(entry.aliases);
	Object.freeze(entry.insertion);
	Object.freeze(entry);
}
Object.freeze(slashContract.entries);

export const SLASH_CONTRACT = Object.freeze(slashContract);

export const SLASH_ENTRIES: readonly SlashEntry[] = Object.freeze(
	SLASH_CONTRACT.entries.map(({ insertion, ...entry }) =>
		Object.freeze({
			...entry,
			run: (ctx: Ctx) => runSlashInsertion(ctx, insertion),
		}),
	),
);

/** Fuzzy filter over label + aliases. */
export function filterSlashEntries(query: string): readonly SlashEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return SLASH_ENTRIES;
	return SLASH_ENTRIES.filter(
		(entry) =>
			entry.label.toLowerCase().includes(q) ||
			entry.aliases.some((a) => a.includes(q) || q.includes(a)),
	);
}
