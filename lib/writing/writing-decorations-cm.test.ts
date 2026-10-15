import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import {
	setLabMarks,
	setWritingMarks,
	writingMarksExtension,
} from "./writing-decorations-cm";

describe("writing and Lab marks on the source surfaces", () => {
	let view: EditorView | null = null;
	afterEach(() => {
		view?.destroy();
		view = null;
	});

	it("draws the Lab on its own layer, a cut naming its index", () => {
		const doc = "Keep this. Cut me. Ghost.";
		view = new EditorView({
			state: EditorState.create({ doc, extensions: writingMarksExtension() }),
			parent: document.body,
		});
		const ghost = { from: 19, to: 25, kind: "ghost" as const, text: "Ghost." };
		view.dispatch({ effects: setWritingMarks.of([ghost]) });
		view.dispatch({
			effects: setLabMarks.of([
				{ from: 11, to: 18, kind: "lab-cut", text: "Cut me.", index: 3 },
			]),
		});
		const dom = view.contentDOM;
		expect(dom.querySelector(".recto-writing-ghost")?.textContent).toBe(
			"Ghost.",
		);
		const cut = dom.querySelector("[data-lab-cut]");
		expect(cut?.textContent).toBe("Cut me.");
		expect(cut?.getAttribute("data-lab-cut")).toBe("3");
		expect(cut?.className).toContain("recto-writing-lab-cut");

		// A fresh writing push leaves the Lab's marks alone, and vice versa.
		view.dispatch({ effects: setWritingMarks.of([]) });
		expect(dom.querySelector("[data-lab-cut]")).not.toBeNull();
		view.dispatch({ effects: setLabMarks.of([]) });
		expect(dom.querySelector("[data-lab-cut]")).toBeNull();
	});
});
