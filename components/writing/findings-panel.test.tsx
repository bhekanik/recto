import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LabReview } from "@/lib/writing/lab";
import { FindingsPanel } from "./findings-panel";

const text = "My first line opens. A muddled bit here. The end.";
const span = (passage: string) => ({
	from: text.indexOf(passage),
	to: text.indexOf(passage) + passage.length,
});

const review: LabReview = {
	pass: "opening",
	assessment: "The opening says what the piece is about.",
	findings: [
		{ ...span("A muddled bit here."), reason: "Hard to follow." },
		{ ...span("The end."), reason: "Abrupt.", suggestion: "That is all." },
	],
	opening: span("My first line opens."),
	openings: ["Here is how it starts.", "Another start."],
	dropped: 1,
	text,
};

function lab() {
	return {
		dismissReview: vi.fn(),
		dismissFinding: vi.fn(),
		showFinding: vi.fn(),
		compareFinding: vi.fn(async () => {}),
		compareOpenings: vi.fn(async () => {}),
	};
}

describe("the findings panel", () => {
	let root: ReturnType<typeof createRoot> | null = null;
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

	afterEach(async () => {
		await act(async () => root?.unmount());
		root = null;
		document.body.replaceChildren();
	});

	async function render(shown: LabReview, actions: ReturnType<typeof lab>) {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(<FindingsPanel review={shown} lab={actions} />),
		);
		const buttons = (label: string) =>
			[...host.querySelectorAll("button")].filter(
				(b) => b.textContent === label,
			);
		return { host, buttons };
	}

	it("shows the assessment and quotes each finding with its reason", async () => {
		const { host } = await render(review, lab());
		expect(host.querySelector("h2")?.textContent).toBe("Improve the opening");
		expect(host.textContent).toContain(
			"The opening says what the piece is about.",
		);
		expect([...host.querySelectorAll("q")].map((q) => q.textContent)).toEqual([
			"A muddled bit here.",
			"The end.",
		]);
		expect(host.textContent).toContain(
			"1 point could not be matched to exact words in the draft and were left out.",
		);
	});

	it("offers Compare wording only where there is a suggestion, and applies nothing itself", async () => {
		const actions = lab();
		const { buttons } = await render(review, actions);
		expect(buttons("Compare wording")).toHaveLength(1);
		await act(async () => buttons("Compare wording")[0]?.click());
		expect(actions.compareFinding).toHaveBeenCalledWith(1);
		await act(async () => buttons("Show")[0]?.click());
		expect(actions.showFinding).toHaveBeenCalledWith(0);
		await act(async () => buttons("Dismiss")[1]?.click());
		expect(actions.dismissFinding).toHaveBeenCalledWith(1);
		await act(async () => buttons("Compare 2 openings")[0]?.click());
		expect(actions.compareOpenings).toHaveBeenCalledTimes(1);
	});

	it("says so when there is nothing to point at, and has no openings to compare off the opening pass", async () => {
		const { host, buttons } = await render(
			{
				...review,
				pass: "voice",
				findings: [],
				opening: null,
				openings: [],
				dropped: 0,
			},
			lab(),
		);
		expect(host.textContent).toContain("No passages to point at.");
		expect(buttons("Compare 2 openings")).toHaveLength(0);
	});
});
