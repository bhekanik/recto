import {
	commandsCtx,
	defaultValueCtx,
	Editor,
	editorViewCtx,
	rootCtx,
} from "@milkdown/core";
import type { Ctx } from "@milkdown/ctx";
import {
	blockquoteSchema,
	bulletListSchema,
	clearTextInCurrentBlockCommand,
	codeBlockSchema,
	commonmark,
	headingSchema,
	hrSchema,
	listItemSchema,
	orderedListSchema,
	paragraphSchema,
	setBlockTypeCommand,
	wrapInBlockTypeCommand,
} from "@milkdown/preset-commonmark";
import { gfm, insertTableCommand } from "@milkdown/preset-gfm";
import { replaceAll } from "@milkdown/utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	SLASH_CONTRACT,
	SLASH_ENTRIES,
	type SlashInsertion,
} from "./slash-entries";

let editor: Editor | undefined;
let container: HTMLElement | undefined;

function activeEditor(): Editor {
	if (!editor) throw new Error("Milkdown test editor is not ready");
	return editor;
}

beforeAll(async () => {
	container = document.createElement("div");
	document.body.appendChild(container);
	editor = await Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, container);
			ctx.set(defaultValueCtx, "");
		})
		.use(commonmark)
		.use(gfm)
		.create();
});

afterAll(async () => {
	await editor?.destroy();
	container?.remove();
});

describe("slash entry runtime adapters", () => {
	it("freezes the contract and derived runtime entries", () => {
		expect(Object.isFrozen(SLASH_CONTRACT)).toBe(true);
		expect(Object.isFrozen(SLASH_CONTRACT.entries)).toBe(true);
		expect(Object.isFrozen(SLASH_ENTRIES)).toBe(true);
		for (const [index, definition] of SLASH_CONTRACT.entries.entries()) {
			expect(Object.isFrozen(definition)).toBe(true);
			expect(Object.isFrozen(definition.aliases)).toBe(true);
			expect(Object.isFrozen(definition.insertion)).toBe(true);
			expect(Object.isFrozen(SLASH_ENTRIES[index])).toBe(true);
		}
	});

	for (const [index, definition] of SLASH_CONTRACT.entries.entries()) {
		it(`${definition.id} runs its serialized insertion`, () => {
			const entry = SLASH_ENTRIES[index];
			if (!entry)
				throw new Error(`missing runtime slash entry ${definition.id}`);
			const milkdownEditor = activeEditor();
			milkdownEditor.action(replaceAll("", false));

			milkdownEditor.action((ctx) => {
				const commands = ctx.get(commandsCtx);
				const view = ctx.get(editorViewCtx);
				const commandSpy = vi.spyOn(commands, "call");
				const dispatchSpy = vi.spyOn(view, "dispatch");

				try {
					entry.run(ctx);

					expect(commandSpy).toHaveBeenNthCalledWith(
						1,
						clearTextInCurrentBlockCommand.key,
					);
					const clearOrder =
						commandSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
					const effectOrder =
						definition.insertion.kind === "text"
							? (dispatchSpy.mock.invocationCallOrder.at(-1) ?? 0)
							: (commandSpy.mock.invocationCallOrder[1] ?? 0);
					expect(clearOrder).toBeLessThan(effectOrder);

					assertInsertion(ctx, definition.insertion, commandSpy, dispatchSpy);
				} finally {
					commandSpy.mockRestore();
					dispatchSpy.mockRestore();
				}
			});
		});
	}
});

function assertInsertion(
	ctx: Ctx,
	insertion: SlashInsertion,
	commandSpy: ReturnType<typeof vi.spyOn>,
	dispatchSpy: ReturnType<typeof vi.spyOn>,
): void {
	switch (insertion.kind) {
		case "heading":
			expect(commandSpy).toHaveBeenNthCalledWith(2, setBlockTypeCommand.key, {
				nodeType: headingSchema.type(ctx),
				attrs: { level: insertion.level },
			});
			return;
		case "text": {
			expect(commandSpy).toHaveBeenCalledTimes(1);
			const transaction = dispatchSpy.mock.calls.at(-1)?.[0];
			expect(transaction?.doc.textContent).toBe(insertion.text);
			return;
		}
		case "wrap": {
			const blocks = {
				"bullet-list": bulletListSchema,
				"ordered-list": orderedListSchema,
				blockquote: blockquoteSchema,
			};
			const inners = {
				"list-item": listItemSchema,
				paragraph: paragraphSchema,
			};
			expect(commandSpy).toHaveBeenNthCalledWith(
				2,
				wrapInBlockTypeCommand.key,
				{
					nodeType: blocks[insertion.block].type(ctx),
					innerNodeType: inners[insertion.inner].type(ctx),
				},
			);
			return;
		}
		case "code-block":
			expect(commandSpy).toHaveBeenNthCalledWith(2, setBlockTypeCommand.key, {
				nodeType: codeBlockSchema.type(ctx),
				attrs: { language: insertion.language },
			});
			return;
		case "divider":
			expect(commandSpy).toHaveBeenNthCalledWith(2, setBlockTypeCommand.key, {
				nodeType: hrSchema.type(ctx),
			});
			return;
		case "table":
			expect(commandSpy).toHaveBeenNthCalledWith(2, insertTableCommand.key, {
				row: insertion.rows,
				col: insertion.columns,
			});
			return;
	}
	insertion satisfies never;
}
