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

export type SlashEntry = {
	id: string;
	label: string;
	aliases: string[];
	run: (ctx: Ctx) => void;
};

function clearAndInsertText(ctx: Ctx, text: string): void {
	const commands = ctx.get(commandsCtx);
	commands.call(clearTextInCurrentBlockCommand.key);
	const view = ctx.get(editorViewCtx);
	const tr = view.state.tr.insertText(text);
	view.dispatch(tr);
}

function setHeading(ctx: Ctx, level: number): void {
	const commands = ctx.get(commandsCtx);
	commands.call(clearTextInCurrentBlockCommand.key);
	commands.call(setBlockTypeCommand.key, {
		nodeType: headingSchema.type(ctx),
		attrs: { level },
	});
}

function wrapBlock(
	ctx: Ctx,
	wrap: ReturnType<typeof bulletListSchema.type>,
	inner: ReturnType<typeof listItemSchema.type>,
): void {
	const commands = ctx.get(commandsCtx);
	commands.call(clearTextInCurrentBlockCommand.key);
	commands.call(wrapInBlockTypeCommand.key, {
		nodeType: wrap,
		innerNodeType: inner,
	});
}

/** 17 authoritative slash entries — blueprint 13-keyboard-commands §5.1. */
export const SLASH_ENTRIES: SlashEntry[] = [
	{
		id: "h1",
		label: "Heading 1",
		aliases: ["h1", "title"],
		run: (ctx) => setHeading(ctx, 1),
	},
	{
		id: "h2",
		label: "Heading 2",
		aliases: ["h2", "subtitle"],
		run: (ctx) => setHeading(ctx, 2),
	},
	{
		id: "h3",
		label: "Heading 3",
		aliases: ["h3"],
		run: (ctx) => setHeading(ctx, 3),
	},
	{
		id: "bold",
		label: "Bold",
		aliases: ["b", "strong"],
		run: (ctx) => clearAndInsertText(ctx, "**text**"),
	},
	{
		id: "italic",
		label: "Italic",
		aliases: ["i", "em", "emphasis"],
		run: (ctx) => clearAndInsertText(ctx, "_text_"),
	},
	{
		id: "strike",
		label: "Strikethrough",
		aliases: ["strike", "del", "s"],
		run: (ctx) => clearAndInsertText(ctx, "~~text~~"),
	},
	{
		id: "code",
		label: "Inline code",
		aliases: ["code", "mono"],
		run: (ctx) => clearAndInsertText(ctx, "`code`"),
	},
	{
		id: "bullet",
		label: "Bullet list",
		aliases: ["ul", "unordered", "list"],
		run: (ctx) =>
			wrapBlock(ctx, bulletListSchema.type(ctx), listItemSchema.type(ctx)),
	},
	{
		id: "ordered",
		label: "Numbered list",
		aliases: ["ol", "ordered", "number"],
		run: (ctx) =>
			wrapBlock(ctx, orderedListSchema.type(ctx), listItemSchema.type(ctx)),
	},
	{
		id: "task",
		label: "Task list",
		aliases: ["todo", "checkbox", "check"],
		run: (ctx) => clearAndInsertText(ctx, "- [ ] "),
	},
	{
		id: "quote",
		label: "Blockquote",
		aliases: ["quote", "bq"],
		run: (ctx) =>
			wrapBlock(ctx, blockquoteSchema.type(ctx), paragraphSchema.type(ctx)),
	},
	{
		id: "fence",
		label: "Code block",
		aliases: ["pre", "fence", "codeblock"],
		run: (ctx) => {
			const commands = ctx.get(commandsCtx);
			commands.call(clearTextInCurrentBlockCommand.key);
			commands.call(setBlockTypeCommand.key, {
				nodeType: codeBlockSchema.type(ctx),
				attrs: { language: "" },
			});
		},
	},
	{
		id: "divider",
		label: "Divider",
		aliases: ["hr", "rule", "separator"],
		run: (ctx) => {
			const commands = ctx.get(commandsCtx);
			commands.call(clearTextInCurrentBlockCommand.key);
			commands.call(setBlockTypeCommand.key, {
				nodeType: hrSchema.type(ctx),
			});
		},
	},
	{
		id: "table",
		label: "Table",
		aliases: ["tbl", "grid"],
		run: (ctx) => {
			const commands = ctx.get(commandsCtx);
			commands.call(clearTextInCurrentBlockCommand.key);
			commands.call(insertTableCommand.key, { row: 2, col: 2 });
		},
	},
	{
		id: "link",
		label: "Link",
		aliases: ["url", "href", "a"],
		run: (ctx) => clearAndInsertText(ctx, "[text](https://)"),
	},
	{
		id: "image",
		label: "Image",
		aliases: ["img", "picture"],
		run: (ctx) => clearAndInsertText(ctx, "![alt](https://)"),
	},
	{
		id: "footnote",
		label: "Footnote",
		aliases: ["fn", "note", "ref"],
		run: (ctx) => clearAndInsertText(ctx, "[^1]\n\n[^1]: Footnote text"),
	},
];

/** Fuzzy filter over label + aliases. */
export function filterSlashEntries(query: string): SlashEntry[] {
	const q = query.trim().toLowerCase();
	if (!q) return SLASH_ENTRIES;
	return SLASH_ENTRIES.filter(
		(entry) =>
			entry.label.toLowerCase().includes(q) ||
			entry.aliases.some((a) => a.includes(q) || q.includes(a)),
	);
}
