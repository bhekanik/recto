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
		open: vi.fn(),
		close: vi.fn(),
		add: vi.fn(),
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

	async function render(alternatives: AlternativesController) {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(<AlternativesPanel alternatives={alternatives} />),
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
});
