import { describe, expect, it } from "vitest";
import type { HistoryNode } from "@/lib/history/use-document-history";
import {
	canRejectAiCommit,
	type PendingAiCommit,
	readAiTransformError,
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
		});
	});

	it("falls back safely for an unstructured non-2xx response", async () => {
		await expect(
			readAiTransformError(new Response("gateway", { status: 503 })),
		).resolves.toEqual({
			message: "AI request failed (503)",
			outcomeUnknown: false,
		});
	});
});
