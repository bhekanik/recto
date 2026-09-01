import { describe, expect, it } from "vitest";
import type { HistoryNode } from "@/lib/history/use-document-history";
import {
	canRejectAiCommit,
	commitTransformAfterAcknowledgement,
	type PendingAiCommit,
	readAiTransformError,
	resolveTransformRun,
	snapshotMatchesCurrent,
} from "./use-ai-transform";

const documentId = "doc-a";

function node(
	nodeId: string,
	parentNodeId: string | null,
	origin: string,
): HistoryNode {
	return {
		nodeId,
		parentNodeId,
		origin,
		patch: "",
		createdAt: 1,
	};
}

function controller(
	currentNodeId: string,
	nodes: HistoryNode[],
): PendingAiCommit["controller"] {
	return { currentNodeId, nodes, navigateTo() {} };
}

function pending(owner: PendingAiCommit["controller"]): PendingAiCommit {
	return {
		documentId,
		controller: owner,
		sourceNodeId: "source",
		aiNodeId: "ai-result",
	};
}

describe("AI transform rejection ownership", () => {
	it("allows only the exact AI child at the current head", () => {
		const owner = controller("ai-result", [
			node("ai-result", "source", "ai:tighten"),
		]);
		expect(canRejectAiCommit(pending(owner), documentId, owner)).toBe(true);
	});

	it("does not undo a later local or remote head", () => {
		const owner = controller("later-edit", [
			node("ai-result", "source", "ai:tighten"),
			node("later-edit", "ai-result", "edit"),
		]);
		expect(canRejectAiCommit(pending(owner), documentId, owner)).toBe(false);
	});

	it("does not navigate after a document switch", () => {
		const owner = controller("ai-result", [
			node("ai-result", "source", "ai:tighten"),
		]);
		expect(canRejectAiCommit(pending(owner), "doc-b", owner)).toBe(false);
	});

	it("does not navigate through a replacement history controller", () => {
		const owner = controller("ai-result", [
			node("ai-result", "source", "ai:tighten"),
		]);
		const replacement = controller("ai-result", owner.nodes);
		expect(canRejectAiCommit(pending(owner), documentId, replacement)).toBe(
			false,
		);
	});
});

describe("AI transform HTTP errors", () => {
	it("preserves outcome-unknown instead of treating its 409 as retry-safe", async () => {
		await expect(
			readAiTransformError(
				Response.json(
					{
						error: "This request may already have reached the provider.",
						code: "request_outcome_unknown",
					},
					{ status: 409 },
				),
			),
		).resolves.toEqual({
			message: "This request may already have reached the provider.",
			outcomeUnknown: true,
			retrySafe: false,
		});
	});

	it("keeps known pre-provider failures retry-safe", async () => {
		await expect(
			readAiTransformError(
				Response.json(
					{ error: "The document changed.", code: "document_changed" },
					{ status: 409 },
				),
			),
		).resolves.toEqual({
			message: "The document changed.",
			outcomeUnknown: false,
			retrySafe: true,
		});
	});

	it("falls back safely for an unstructured non-2xx response", async () => {
		await expect(
			readAiTransformError(new Response("gateway", { status: 503 })),
		).resolves.toEqual({
			message: "AI request failed (503)",
			outcomeUnknown: false,
			retrySafe: false,
		});
	});
});

describe("AI transform summon snapshot", () => {
	const snapshot = {
		sourceNodeId: "node-a",
		sourceMarkdown: "😀 selected tail",
		range: { from: 3, to: 11 },
		selection: "selected",
	};

	it("rejects a same-node edit before Run", () => {
		expect(
			snapshotMatchesCurrent(
				snapshot,
				{ currentNodeId: "node-a" },
				"prefix 😀 selected tail",
			),
		).toBe(false);
	});

	it("rejects a changed history head before Run", () => {
		expect(
			snapshotMatchesCurrent(
				snapshot,
				{ currentNodeId: "node-b" },
				snapshot.sourceMarkdown,
			),
		).toBe(false);
	});

	it("accepts only the exact source and UTF-16 span", () => {
		expect(
			snapshotMatchesCurrent(
				snapshot,
				{ currentNodeId: "node-a" },
				snapshot.sourceMarkdown,
			),
		).toBe(true);
	});
});

describe("AI transform acknowledgement boundary", () => {
	it("does not create an AI node when acknowledgement transport fails", async () => {
		let markdown = "before selected after";
		const commits: string[] = [];
		const snapshot = {
			sourceNodeId: "source",
			sourceMarkdown: markdown,
			range: { from: 7, to: 15 },
			selection: "selected",
		};
		const result = await commitTransformAfterAcknowledgement({
			acknowledge: async () => {
				throw new Error("transport failed");
			},
			snapshot,
			controller: {
				currentNodeId: "source",
				commitProgrammatic(nextMarkdown) {
					commits.push(nextMarkdown);
					markdown = nextMarkdown;
					return "ai-node";
				},
			},
			getMarkdown: () => markdown,
			isCurrent: () => true,
			nextMarkdown: "before replacement after",
			origin: "ai:tighten",
		});

		expect(result).toEqual({ status: "acknowledgement-failed" });
		expect(markdown).toBe(snapshot.sourceMarkdown);
		expect(commits).toEqual([]);
	});
});

describe("AI transform run recovery", () => {
	it("keeps missing and reserved runs locked", () => {
		expect(resolveTransformRun(null)).toEqual({ status: "unresolved" });
		expect(resolveTransformRun({ status: "reserved" })).toEqual({
			status: "unresolved",
		});
	});

	it("allows retry only after terminal pre-provider failure", () => {
		expect(resolveTransformRun({ status: "failed" })).toEqual({
			status: "retry-safe",
		});
		expect(resolveTransformRun({ status: "cancelled" })).toEqual({
			status: "retry-safe",
		});
	});

	it("recovers a stored successful output", () => {
		expect(
			resolveTransformRun({
				status: "succeeded",
				applicable: true,
				output: "done",
			}),
		).toEqual({ status: "succeeded", output: "done" });
	});

	it("does not expose a succeeded transform the server marked non-applicable", () => {
		expect(
			resolveTransformRun({
				status: "succeeded",
				applicable: false,
				output: "done",
			}),
		).toEqual({ status: "retry-safe" });
	});
});
