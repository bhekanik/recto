import { describe, expect, it } from "vitest";

import { indexNodes, materialize, unionMerge } from "../src/materialize.ts";
import { applyPatch, computePatch, encodePatch } from "../src/patch.ts";

describe("patch apply", () => {
	it("reproduces child from parent + patch", () => {
		const parent = "Hello world";
		const child = "Hello brave world";
		const patch = encodePatch(computePatch(parent, child));
		expect(applyPatch(parent, patch)).toBe(child);
	});
});

describe("materialize", () => {
	const nodes = indexNodes([
		{
			nodeId: "root",
			parentNodeId: null,
			patch: encodePatch({ from: 0, to: 0, insert: "" }),
			snapshot: "",
		},
		{
			nodeId: "n1",
			parentNodeId: "root",
			patch: encodePatch(computePatch("", "Hello")),
		},
		{
			nodeId: "n2",
			parentNodeId: "n1",
			patch: encodePatch(computePatch("Hello", "Hello world")),
			snapshot: "Hello world",
		},
		{
			nodeId: "a3",
			parentNodeId: "n2",
			patch: encodePatch(computePatch("Hello world", "Hello world from A")),
		},
		{
			nodeId: "b3",
			parentNodeId: "n2",
			patch: encodePatch(computePatch("Hello world", "Hello world from B")),
		},
	]);

	it("materializes arbitrary branch nodes exactly", () => {
		expect(materialize("a3", nodes)).toBe("Hello world from A");
		expect(materialize("b3", nodes)).toBe("Hello world from B");
	});

	it("union-merges two client node sets with zero conflict", () => {
		const root = nodes.get("root");
		const n1 = nodes.get("n1");
		const n2 = nodes.get("n2");
		const a3 = nodes.get("a3");
		const b3 = nodes.get("b3");
		if (!root || !n1 || !n2 || !a3 || !b3)
			throw new Error("fixture incomplete");

		const clientA = [root, n1, n2, a3];
		const clientB = [root, n1, n2, b3];
		const merged = unionMerge(clientA, clientB);
		expect(merged).toHaveLength(5);
		expect(materialize("a3", indexNodes(merged))).toBe("Hello world from A");
		expect(materialize("b3", indexNodes(merged))).toBe("Hello world from B");
	});
});

describe("storage probe", () => {
	it("patch values stay well under 1 MiB", () => {
		const parent = "x".repeat(10_000);
		const child = `${parent} appended`;
		const patch = encodePatch(computePatch(parent, child));
		expect(patch.length).toBeLessThan(1024);
	});
});
