import { describe, expect, it } from "vitest";
import { ghostContaining, ghosting, reviving } from "./edits";
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
