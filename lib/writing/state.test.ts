import { describe, expect, it } from "vitest";
import { computePatch, encodePatch } from "@/lib/history/patch";
import cases from "./fixtures/mapping.json";
import {
	decodeWritingState,
	ghostRangesFor,
	mapWritingState,
	materializeWriting,
	type WritingNode,
	type WritingState,
} from "./state";

describe("writing state, shared with the Mac", () => {
	for (const testCase of cases) {
		it(testCase.name, () => {
			const state = testCase.state as WritingState;
			expect(
				mapWritingState(
					state,
					computePatch(testCase.before, testCase.after),
					testCase.after,
				),
			).toEqual(testCase.expected);
		});
	}

	it("derives a node's state through the patches below the nearest explicit one", () => {
		const first = cases[0];
		if (!first) throw new Error("fixture is empty");
		const nodes = new Map<string, WritingNode>([
			[
				"root",
				{
					nodeId: "root",
					parentNodeId: null,
					patch: "",
					snapshot: first.before,
				},
			],
			[
				"marked",
				{
					nodeId: "marked",
					parentNodeId: "root",
					patch: encodePatch(computePatch(first.before, first.before)),
					writing: JSON.stringify(first.state),
				},
			],
			[
				"typed",
				{
					nodeId: "typed",
					parentNodeId: "marked",
					patch: encodePatch(computePatch(first.before, first.after)),
				},
			],
		]);
		expect(materializeWriting("root", nodes)).toEqual({
			version: 1,
			alternatives: [],
			ghosts: [],
		});
		expect(materializeWriting("typed", nodes)).toEqual(first.expected);
	});

	it("treats a newer version as absent", () => {
		expect(decodeWritingState('{"version":2}')).toBeNull();
		expect(decodeWritingState("not json")).toBeNull();
	});
	it("finds the ghosts on the text a pane shows, ahead of the head", () => {
		const head = "Keep this. Maybe cut this. Keep that.";
		const from = head.indexOf("Maybe");
		const nodes = [
			{ nodeId: "root", parentNodeId: null, patch: "", snapshot: head },
			{
				nodeId: "ghosted",
				parentNodeId: "root",
				patch: encodePatch(computePatch(head, head)),
				writing: JSON.stringify({
					version: 1,
					alternatives: [],
					ghosts: [
						{ id: "g", location: from, length: "Maybe cut this.".length },
					],
				}),
			},
		];
		const history = {
			nodes,
			getHeadNodeId: () => "ghosted",
			materializeAt: () => head,
		};
		const typed = `So ${head}`;
		const ranges = ghostRangesFor(typed, history);
		expect(ranges.map((range) => typed.slice(range.from, range.to))).toEqual([
			"Maybe cut this.",
		]);
		expect(ghostRangesFor(head, null)).toEqual([]);
	});
});
