import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WritingState } from "@/lib/writing/state";
import type { AlternativesController } from "@/lib/writing/use-alternatives";
import { AlternativesPanel } from "./alternatives-panel";

const state: WritingState = {
	version: 1,
	ghosts: [],
	alternatives: [
		{
			id: "g",
			scope: "word",
			location: 12,
			length: 7,
			detached: false,
			activeId: "o",
			candidates: [
				{ id: "o", text: "tension", author: "human" },
				{ id: "p", text: "pressure", author: "human" },
				{ id: "s", text: "strain", author: "ai" },
			],
		},
	],
};

function controller(): AlternativesController {
	return {
		targets: { ranges: { word: { from: 12, to: 19 } }, initial: "word" },
		previewShownId: null,
		writing: () => state,
		open: vi.fn(() => null),
		openAt: vi.fn(),
		close: vi.fn(),
		add: vi.fn(),
		addSuggested: vi.fn(() => true),
		show: vi.fn(),
		keep: vi.fn(async () => {}),
		restore: vi.fn(),
		remove: vi.fn(),
	};
}

describe("alternatives panel", () => {
	let root: ReturnType<typeof createRoot> | null = null;
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

	afterEach(async () => {
		await act(async () => root?.unmount());
		document.body.replaceChildren();
	});

	async function render(
		alternatives: AlternativesController,
		ai: {
			suggest?: (range: { from: number; to: number }, scope: string) => void;
			suggesting?: boolean;
		} = {},
	) {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AlternativesPanel
					alternatives={alternatives}
					suggest={ai.suggest}
					suggesting={ai.suggesting}
				/>,
			),
		);
		const field = host.querySelector<HTMLInputElement>(
			'input[aria-label="Add a wording"]',
		);
		if (!field) throw new Error("no field");
		return { host, field };
	}

	const press = (field: HTMLInputElement, key: string) =>
		act(async () => {
			field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
		});

	it("lists wordings, marks the AI's, and steps through them with the arrows", async () => {
		const alternatives = controller();
		const { host, field } = await render(alternatives);
		expect(
			[...host.querySelectorAll("li button:not([aria-label])")].map(
				(b) => b.textContent,
			),
		).toEqual(["tension", "pressure", "strain"]);
		expect(host.querySelector('[aria-label="Suggested by AI"]')).not.toBeNull();
		await press(field, "ArrowDown");
		expect(alternatives.show).toHaveBeenCalledWith("p", "g");
		await press(field, "ArrowUp");
		expect(alternatives.show).toHaveBeenCalledWith("s", "g");
	});

	it("keeps on Return with an empty field and restores on Escape", async () => {
		const alternatives = controller();
		const { field } = await render(alternatives);
		await press(field, "Enter");
		expect(alternatives.close).toHaveBeenCalledTimes(1);
		await press(field, "Escape");
		expect(alternatives.restore).toHaveBeenCalledTimes(1);
	});

	const suggestButton = (host: HTMLElement) =>
		[...host.querySelectorAll("button")].find(
			(b) => b.textContent === "Suggest with AI",
		);

	it("asks the AI for wordings of the passage on show, only while AI is on", async () => {
		const suggest = vi.fn();
		const { host } = await render(controller(), { suggest });
		const button = suggestButton(host);
		expect(button?.disabled).toBe(false);
		await act(async () => button?.click());
		expect(suggest).toHaveBeenCalledWith({ from: 12, to: 19 }, "word");
		await act(async () => root?.unmount());
		root = null;
		document.body.replaceChildren();
		const off = await render(controller());
		expect(suggestButton(off.host)).toBeUndefined();
	});

	it("says the AI is being asked and holds the button meanwhile", async () => {
		const { host } = await render(controller(), {
			suggest: vi.fn(),
			suggesting: true,
		});
		expect(host.textContent).toContain("Asking the AI…");
		expect(suggestButton(host)?.disabled).toBe(true);
	});
});
