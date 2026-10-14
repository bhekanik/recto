import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { computePatch, encodePatch } from "@/lib/history/patch";
import { writingMarksFor } from "./marks";
import {
	setWritingMarks,
	writingMarksExtension,
} from "./writing-decorations-cm";

const text = "Much of the tension. Maybe cut this.";

function history(state: object) {
	return {
		nodes: [
			{ nodeId: "root", parentNodeId: null, patch: "", snapshot: text },
			{
				nodeId: "marked",
				parentNodeId: "root",
				patch: encodePatch(computePatch(text, text)),
				writing: JSON.stringify(state),
			},
		],
		getHeadNodeId: () => "marked",
		materializeAt: () => text,
	};
}

describe("writing marks", () => {
	it("marks ghosts and passages with alternatives, accenting a variant", () => {
		const tension = text.indexOf("tension");
		const cut = text.indexOf("Maybe cut this.");
		const marks = writingMarksFor(
			text,
			history({
				version: 1,
				alternatives: [
					{
						id: "g",
						scope: "word",
						location: tension,
						length: 7,
						candidates: [
							{ id: "o", text: "tension", author: "human" },
							{ id: "p", text: "pressure", author: "ai" },
						],
						activeId: "o",
						detached: false,
					},
				],
				ghosts: [{ id: "h", location: cut, length: 15 }],
			}),
		);
		expect(marks.map((mark) => [mark.kind, mark.text])).toEqual([
			["alternative", "tension"],
			["ghost", "Maybe cut this."],
		]);
		expect(writingMarksFor(text, null)).toEqual([]);
	});

	it("draws marks in CodeMirror at their offsets", () => {
		const view = new EditorView({
			state: EditorState.create({
				doc: text,
				extensions: [writingMarksExtension()],
			}),
		});
		view.dispatch({
			effects: setWritingMarks.of([
				{ from: 12, to: 19, kind: "ghost", text: "tension" },
			]),
		});
		expect(view.dom.querySelector(".recto-writing-ghost")?.textContent).toBe(
			"tension",
		);
		view.destroy();
	});
});
