import { describe, expect, it } from "vitest";
import type { GroupCommit } from "@/lib/history/grouping";
import { appendArgsFromNode, reviewerNodeFromCommit } from "./reviewer-branch";

const commit = (over: Partial<GroupCommit> = {}): GroupCommit => ({
	nodeId: "node-1",
	parentNodeId: "whatever-grouping-said",
	patch: JSON.stringify({ from: 0, to: 0, insert: "x" }),
	snapshot: undefined,
	selection: { anchor: 1, head: 1 },
	markdown: "x",
	...over,
});

describe("reviewerNodeFromCommit", () => {
	it("reparents the commit onto the supplied branch head and stamps a review origin", () => {
		const node = reviewerNodeFromCommit(commit(), "base-node", "user-42", 1000);
		// Always parents on the reviewer's CURRENT branch head — never on whatever
		// the grouping controller computed — so the reviewer's nodes stay contiguous.
		expect(node.parentNodeId).toBe("base-node");
		expect(node.nodeId).toBe("node-1");
		expect(node.origin).toBe("review:user-42");
		expect(node.createdAt).toBe(1000);
		expect(node.selection).toEqual({ anchor: 1, head: 1 });
	});

	it("carries the patch + snapshot through unchanged", () => {
		const node = reviewerNodeFromCommit(
			commit({ snapshot: "full text", patch: "PATCH" }),
			"head",
			"u",
			5,
		);
		expect(node.patch).toBe("PATCH");
		expect(node.snapshot).toBe("full text");
	});
});

describe("appendArgsFromNode", () => {
	it("builds reviewerAppend args, forwarding a known branch id and never an origin", () => {
		const node = reviewerNodeFromCommit(commit(), "base", "u", 7);
		const args = appendArgsFromNode("doc-1", node, "branch-9");
		expect(args.documentId).toBe("doc-1");
		expect(args.branchId).toBe("branch-9");
		expect(args.nodeId).toBe("node-1");
		expect(args.parentNodeId).toBe("base");
		expect(args.createdAt).toBe(7);
		// The server stamps the canonical origin; it is NOT forwarded by the client.
		expect("origin" in args).toBe(false);
	});

	it("omits the branch id on the first append (server opens the branch)", () => {
		const node = reviewerNodeFromCommit(commit(), "base", "u", 7);
		const args = appendArgsFromNode("doc-1", node, undefined);
		expect(args.branchId).toBeUndefined();
	});

	it("coerces a null parent to an empty string (reviewerAppend requires a string)", () => {
		const node = reviewerNodeFromCommit(commit(), "base", "u", 7);
		node.parentNodeId = null;
		const args = appendArgsFromNode("doc-1", node, undefined);
		expect(args.parentNodeId).toBe("");
	});
});
