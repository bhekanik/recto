import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type LabProposal, proposalFor, toggleCut } from "@/lib/writing/lab";
import type { LabController } from "@/lib/writing/use-lab";
import { LabBar } from "./lab-bar";

const base = "So, basically, the plan works. It really does work well.";
const cut = (text: string, reason: string) => ({
	from: base.indexOf(text),
	to: base.indexOf(text) + text.length,
	reason,
});

function made(): LabProposal {
	const proposal = proposalFor(
		20,
		base,
		[cut("So, basically, ", "throat-clearing"), cut(" really", "")],
		2,
	);
	if (!proposal) throw new Error("no proposal");
	return proposal;
}

type BarLab = Parameters<typeof LabBar>[0]["lab"];

function lab(overrides: Partial<BarLab> = {}): BarLab {
	return {
		busy: null,
		proposal: null,
		makeCuts: vi.fn(async () => {}),
		walk: vi.fn(),
		decide: vi.fn(),
		dismissProposal: vi.fn(),
		...overrides,
	} satisfies Partial<LabController>;
}

describe("the Lab bar", () => {
	let root: ReturnType<typeof createRoot> | null = null;
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

	afterEach(async () => {
		await act(async () => root?.unmount());
		root = null;
		document.body.replaceChildren();
	});

	async function render(props: BarLab) {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () => root?.render(<LabBar lab={props} />));
		const button = (label: string) =>
			[...host.querySelectorAll("button")].find((b) => b.textContent === label);
		return { host, button };
	}

	it("is absent while the Lab has nothing to show", async () => {
		const { host } = await render(lab());
		expect(host.textContent).toBe("");
	});

	it("says which pass is reading the draft", async () => {
		const trimming = await render(lab({ busy: { kind: "trim", target: 30 } }));
		expect(trimming.host.textContent).toContain(
			"Even sharper · Reading the draft…",
		);
	});

	it("sums up the proposal and offers the three choices", async () => {
		const props = lab({ proposal: made() });
		const { host, button } = await render(props);
		expect(host.textContent).toContain("Tighten more · 10 → 7 words · −30%");
		expect(host.textContent).toContain(
			"Faded words would go. Click one to keep it. 2 suggestions could not be placed exactly and were left out.",
		);
		await act(async () => button("Make the cuts")?.click());
		await act(async () => button("Walk through")?.click());
		await act(async () => button("Done")?.click());
		expect(props.makeCuts).toHaveBeenCalledTimes(1);
		expect(props.walk).toHaveBeenCalledTimes(1);
		expect(props.dismissProposal).toHaveBeenCalledTimes(1);
	});

	it("holds Make the cuts once every cut is kept", async () => {
		const all = toggleCut(toggleCut(made(), 0), 1);
		const { button } = await render(lab({ proposal: all }));
		expect(button("Make the cuts")?.disabled).toBe(true);
	});

	it("walks through one cut at a time with its reason", async () => {
		const props = lab({ proposal: { ...made(), walking: 1, kept: [1] } });
		const { host, button } = await render(props);
		expect(host.textContent).toContain("Cut 2 of 2 · kept");
		expect(host.textContent).toContain("No reason given.");
		await act(async () => button("Keep the words")?.click());
		await act(async () => button("Cut them")?.click());
		expect(props.decide).toHaveBeenNthCalledWith(1, true);
		expect(props.decide).toHaveBeenNthCalledWith(2, false);
	});
});
