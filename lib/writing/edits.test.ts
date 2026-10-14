import { describe, expect, it } from "vitest";
import {
	adding,
	choosing,
	ghostContaining,
	ghosting,
	groupContaining,
	removing,
	reviving,
} from "./edits";
import { emptyWritingState } from "./state";

describe("ghost edits on the web", () => {
	it("ghosts a range, joins touching ghosts, finds and revives them", () => {
		let id = 0;
		const next = () => `g${++id}`;
		let state = ghosting(emptyWritingState(), 5, 10, next);
		expect(state?.ghosts).toEqual([{ id: "g1", location: 5, length: 5 }]);
		state = ghosting(state ?? emptyWritingState(), 10, 14, next);
		expect(state?.ghosts).toEqual([{ id: "g2", location: 5, length: 9 }]);
		const ghost = ghostContaining(state ?? emptyWritingState(), 7);
		expect(ghost?.id).toBe("g2");
		expect(reviving(state ?? emptyWritingState(), "g2").ghosts).toEqual([]);
		expect(ghosting(emptyWritingState(), 4, 4, next)).toBeNull();
	});
});

describe("alternative edits on the web, as on the Mac", () => {
	const text = "Like a thumbtack, for example, and the tension.";
	const at = (word: string) => text.indexOf(word);

	it("adds, chooses with an article, and removes", () => {
		let id = 0;
		const next = () => `id${++id}`;
		let state = adding(
			emptyWritingState(),
			"eraser",
			"human",
			"word",
			at("thumbtack"),
			at("thumbtack") + 9,
			text,
			next,
		);
		state =
			state &&
			adding(
				state,
				"pressure",
				"ai",
				"word",
				at("tension"),
				at("tension") + 7,
				text,
				next,
			);
		if (!state) throw new Error("adding failed");
		expect(
			state.alternatives.map((g) => g.candidates.map((c) => c.text)),
		).toEqual([
			["thumbtack", "eraser"],
			["tension", "pressure"],
		]);
		expect(
			adding(
				state,
				"x",
				"human",
				"word",
				at("thumbtack") + 2,
				at("thumbtack") + 5,
				text,
				next,
			),
		).toBeNull();
		const group = state.alternatives[0];
		const eraser = group?.candidates[1];
		if (!group || !eraser) throw new Error("missing group");
		const choice = choosing(state, eraser.id, group.id, text, {
			from: 5,
			to: 6,
			text: "an",
		});
		if (!choice) throw new Error("choosing failed");
		const result =
			text.slice(0, choice.from) + choice.text + text.slice(choice.to);
		expect(result).toBe("Like an eraser, for example, and the tension.");
		const [eraserGroup, tensionGroup] = choice.state.alternatives;
		expect(
			eraserGroup &&
				result.slice(
					eraserGroup.location,
					eraserGroup.location + eraserGroup.length,
				),
		).toBe("eraser");
		expect(
			tensionGroup &&
				result.slice(
					tensionGroup.location,
					tensionGroup.location + tensionGroup.length,
				),
		).toBe("tension");
		expect(removing(state, group.activeId, group.id)).toBeNull();
		expect(removing(state, eraser.id, group.id)?.alternatives).toHaveLength(1);
		expect(groupContaining(state, at("tension") + 7)?.id).toBe(
			state.alternatives[1]?.id,
		);
	});
});
