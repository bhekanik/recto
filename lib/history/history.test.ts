import { describe, expect, it } from "vitest";

import { GroupingController } from "./grouping";
import {
	type DocNode,
	indexNodes,
	materialize,
	unionMerge,
} from "./materialize";
import { applyPatch, computePatch, encodePatch } from "./patch";
import { computePrunable } from "./retention";

describe("patch codec (blueprint 03 §4.2)", () => {
	it("round-trips applyPatch(parent, computePatch(parent, next)) === next", () => {
		const cases: [string, string][] = [
			["", "hello"],
			["hello world", "hello brave world"],
			["# Title\n\nBody.\n", "# Title\n\nBody edited.\n"],
			["abcdef", "abXYZef"],
			["keep this", "keep"],
		];
		for (const [parent, next] of cases) {
			expect(applyPatch(parent, encodePatch(computePatch(parent, next)))).toBe(
				next,
			);
		}
	});
});

describe("materialize (G2 — nearest-snapshot replay)", () => {
	const nodes: DocNode[] = [
		{ nodeId: "root", parentNodeId: null, patch: "", snapshot: "A" },
		{
			nodeId: "n1",
			parentNodeId: "root",
			patch: encodePatch(computePatch("A", "AB")),
		},
		{
			nodeId: "n2",
			parentNodeId: "n1",
			patch: encodePatch(computePatch("AB", "ABC")),
			snapshot: "ABC",
		},
		{
			nodeId: "n3",
			parentNodeId: "n2",
			patch: encodePatch(computePatch("ABC", "ABCD")),
		},
	];
	const byId = indexNodes(nodes);

	it("replays from root snapshot", () => {
		expect(materialize("n1", byId)).toBe("AB");
	});

	it("replays across a mid-branch snapshot boundary", () => {
		expect(materialize("n3", byId)).toBe("ABCD");
	});

	it("returns a snapshot node's snapshot directly", () => {
		expect(materialize("n2", byId)).toBe("ABC");
	});
});

describe("unionMerge (G1 — conflict-free node-set union)", () => {
	it("unions two divergent offline branches with no conflict", () => {
		const base: DocNode[] = [
			{ nodeId: "root", parentNodeId: null, patch: "", snapshot: "" },
			{ nodeId: "n2", parentNodeId: "root", patch: "{}" },
		];
		const deviceA: DocNode[] = [
			...base,
			{ nodeId: "a3", parentNodeId: "n2", patch: "{}" },
			{ nodeId: "a4", parentNodeId: "a3", patch: "{}" },
		];
		const deviceB: DocNode[] = [
			...base,
			{ nodeId: "b3", parentNodeId: "n2", patch: "{}" },
		];
		const merged = unionMerge(deviceA, deviceB);
		const ids = new Set(merged.map((n) => n.nodeId));
		expect(ids).toEqual(new Set(["root", "n2", "a3", "a4", "b3"]));
		// n2 now has two children — the branch was preserved, nothing dropped.
		expect(merged.filter((n) => n.parentNodeId === "n2").length).toBe(2);
	});
});

/** A controllable clock + commit sink for deterministic grouping tests. */
function makeController(rootMarkdown = "") {
	const commits: { markdown: string; snapshot?: string }[] = [];
	let t = 1000;
	const controller = new GroupingController({
		rootNodeId: "root",
		rootMarkdown,
		schedule: false,
		now: () => t,
		onCommit: (c) =>
			commits.push({ markdown: c.markdown, snapshot: c.snapshot }),
	});
	return {
		controller,
		commits,
		at(time: number) {
			t = time;
			return controller;
		},
	};
}

describe("grouping (G4 — boundary heuristics)", () => {
	it("coalesces a typing burst into one node", () => {
		const { controller, commits, at } = makeController("");
		at(1000).record("h", null);
		at(1010).record("he", null);
		at(1020).record("hel", null);
		controller.flush();
		expect(commits).toHaveLength(1);
		expect(commits[0]?.markdown).toBe("hel");
	});

	it("commits a boundary on a >500ms typing pause", () => {
		const { controller, commits, at } = makeController("");
		at(1000).record("a", null);
		at(1010).record("ab", null);
		at(1700).record("abc", null); // 690ms gap → boundary commits "ab" first
		controller.flush();
		expect(commits.map((c) => c.markdown)).toEqual(["ab", "abc"]);
	});

	it("commits a boundary on an adjacency break (caret jump)", () => {
		const { controller, commits, at } = makeController("");
		at(1000).record("hello", null);
		at(1010).record("hello world", null); // appended at end
		at(1020).record("Xhello world", null); // inserted at start → adjacency break
		controller.flush();
		expect(commits.map((c) => c.markdown)).toEqual([
			"hello world",
			"Xhello world",
		]);
	});

	it("commits a structural change immediately as its own node", () => {
		const { commits, at } = makeController("text");
		at(1000).record("text pasted block", null, { structural: true });
		expect(commits.map((c) => c.markdown)).toEqual(["text pasted block"]);
	});

	it("never commits a node for a selection-only move", () => {
		const { controller, commits, at } = makeController("hello");
		at(1000).record("hello", { anchor: 0, head: 0 });
		at(1010).record("hello", { anchor: 2, head: 4 });
		controller.flush();
		expect(commits).toHaveLength(0);
	});
});

describe("snapshot cadence", () => {
	it("stores a full snapshot every Nth node along a branch", () => {
		const commits: { snapshot?: string }[] = [];
		let t = 1000;
		const controller = new GroupingController({
			rootNodeId: "root",
			rootMarkdown: "",
			schedule: false,
			now: () => t,
			onCommit: (c) => commits.push({ snapshot: c.snapshot }),
		});
		// 60 separated edits → 60 nodes; snapshots every 50.
		for (let i = 1; i <= 60; i++) {
			t = 1000 + i * 1000; // each >500ms apart → its own node
			controller.record("x".repeat(i), null);
		}
		controller.flush();
		const snapshotCount = commits.filter((c) => c.snapshot != null).length;
		expect(commits.length).toBeGreaterThanOrEqual(60);
		expect(snapshotCount).toBeGreaterThanOrEqual(1);
	});
});

describe("retention keep-set (blueprint 07 §8)", () => {
	const now = 10_000_000;
	const day = 24 * 60 * 60 * 1000;
	const nodes: DocNode[] = [
		{
			nodeId: "root",
			parentNodeId: null,
			patch: "",
			snapshot: "",
			createdAt: now - 100 * day,
		},
		{
			nodeId: "spine1",
			parentNodeId: "root",
			patch: "{}",
			createdAt: now - 90 * day,
		},
		{
			nodeId: "head",
			parentNodeId: "spine1",
			patch: "{}",
			createdAt: now - 80 * day,
		},
		{
			nodeId: "tagged",
			parentNodeId: "root",
			patch: "{}",
			createdAt: now - 95 * day,
		},
		{
			nodeId: "abandoned",
			parentNodeId: "root",
			patch: "{}",
			createdAt: now - 95 * day,
		},
		{
			nodeId: "recent",
			parentNodeId: "root",
			patch: "{}",
			createdAt: now - 1 * day,
		},
	];

	it("prunes only deep abandoned old branches; keeps spine, tagged, recent", () => {
		const prunable = computePrunable(nodes, "head", ["tagged"], now);
		expect(prunable).toEqual(new Set(["abandoned"]));
	});

	it("keeps everything when within the recency window", () => {
		const recentNodes = nodes.map((n) => ({ ...n, createdAt: now - 1000 }));
		const prunable = computePrunable(recentNodes, "head", [], now);
		expect(prunable.size).toBe(0);
	});
});
