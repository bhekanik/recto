import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { createDefaultWorkspace, createEmptyPane } from "./defaults";
import { closePane, renormalizeSizes, splitPane } from "./operations";
import { collectLeaves, countPanes, openDocumentIdsFromTree } from "./queries";
import type { PaneLeaf, PaneSplit } from "./types";

const docA = "doc_a" as Id<"documents">;
const docB = "doc_b" as Id<"documents">;

function leaf(
	paneId: string,
	documentId: Id<"documents"> | null = null,
): PaneLeaf {
	return {
		type: "pane",
		paneId,
		documentId,
		mode: "rich",
		viewState: { selection: null, scrollTop: 0 },
	};
}

describe("renormalizeSizes", () => {
	it("sums to 100", () => {
		const result = renormalizeSizes([30, 30, 30]);
		expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
	});
});

describe("splitPane", () => {
	it("splits a single leaf into vertical split", () => {
		const root = leaf("a", docA);
		const result = splitPane(root, "a", "vertical");
		expect(result).not.toBeNull();
		expect(result?.tree.type).toBe("split");
		if (result?.tree.type === "split") {
			expect(result.tree.direction).toBe("vertical");
			expect(result.tree.children).toHaveLength(2);
		}
	});

	it("flattens same-direction split into parent group", () => {
		const inner: PaneSplit = {
			type: "split",
			splitId: "split-1",
			direction: "horizontal",
			children: [leaf("a", docA), leaf("b", docB)],
			sizes: [50, 50],
		};
		const result = splitPane(inner, "a", "horizontal");
		expect(result?.tree.type).toBe("split");
		if (result?.tree.type === "split") {
			expect(result.tree.children).toHaveLength(3);
		}
	});

	it("nests when split direction differs from parent", () => {
		const inner: PaneSplit = {
			type: "split",
			splitId: "split-1",
			direction: "horizontal",
			children: [leaf("a", docA), leaf("b", docB)],
			sizes: [50, 50],
		};
		const result = splitPane(inner, "a", "vertical");
		expect(result?.tree.type).toBe("split");
		if (result?.tree.type === "split") {
			const first = result.tree.children[0];
			expect(first?.type).toBe("split");
		}
	});
});

describe("closePane", () => {
	it("collapses single-child splits", () => {
		const root: PaneSplit = {
			type: "split",
			splitId: "split-1",
			direction: "horizontal",
			children: [leaf("a", docA), leaf("b", docB)],
			sizes: [50, 50],
		};
		const { tree } = closePane(root, "b", "b");
		expect(tree.type).toBe("pane");
	});

	it("never yields empty tree", () => {
		const root = leaf("only", docA);
		const { tree, activePaneId } = closePane(root, "only", "only");
		expect(tree.type).toBe("pane");
		expect(activePaneId).not.toBe("only");
	});
});

describe("openDocumentIdsFromTree", () => {
	it("deduplicates shared document ids", () => {
		const root: PaneSplit = {
			type: "split",
			splitId: "split-1",
			direction: "vertical",
			children: [leaf("a", docA), leaf("b", docA)],
			sizes: [50, 50],
		};
		expect(openDocumentIdsFromTree(root)).toEqual([docA]);
	});

	it("excludes empty panes", () => {
		const ws = createDefaultWorkspace();
		expect(openDocumentIdsFromTree(ws.paneTree)).toEqual([]);
	});
});

describe("createDefaultWorkspace", () => {
	it("starts with one empty pane", () => {
		const ws = createDefaultWorkspace();
		expect(countPanes(ws.paneTree)).toBe(1);
		expect(collectLeaves(ws.paneTree)[0]?.documentId).toBeNull();
	});
});

describe("createEmptyPane", () => {
	it("generates unique pane ids", () => {
		const a = createEmptyPane();
		const b = createEmptyPane();
		expect(a.paneId).not.toBe(b.paneId);
	});
});
