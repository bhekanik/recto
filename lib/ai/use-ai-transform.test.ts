import { describe, expect, it } from "vitest";
import type { HistoryNode } from "@/lib/history/use-document-history";
import {
	canRejectAiCommit,
	commitTransformAfterAcknowledgement,
	type PendingAiCommit,
	readAiTransformError,
	reconcileTransformRun,
	resolveTransformRun,
	snapshotMatchesCurrent,
	transformReconciliationIsCurrent,
	type UnresolvedTransform,
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
	type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

	function deferred<T>(): Deferred<T> {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((resolvePromise) => {
			resolve = resolvePromise;
		});
		return { promise, resolve };
	}

	const unresolved = (
		requestId: string,
		document: string,
		generation: number,
	): UnresolvedTransform => ({
		requestId,
		// SAFETY: Tests use inert document ids and never pass them to Convex.
		documentId: document as UnresolvedTransform["documentId"],
		generation,
		partial: "",
	});

	it.each([
		"reserved cancellation",
		"failed acknowledgement",
		"succeeded acknowledgement and commit",
		"acknowledgement failure",
	])("drops document A's %s continuation after switching to B", () => {
		const captured = unresolved("request-a", "doc-a", 1);
		const current = unresolved("request-b", "doc-b", 2);
		expect(
			transformReconciliationIsCurrent(
				captured,
				current,
				current.documentId,
				2,
			),
		).toBe(false);
	});

	it("does not revive an A continuation after A to B to A with a newer request", () => {
		const captured = unresolved("old-a", "doc-a", 1);
		const current = unresolved("new-a", "doc-a", 3);
		expect(
			transformReconciliationIsCurrent(
				captured,
				current,
				current.documentId,
				3,
			),
		).toBe(false);
		expect(
			transformReconciliationIsCurrent(
				captured,
				captured,
				captured.documentId,
				3,
			),
		).toBe(false);
	});

	it("drops A while its reserved cancellation settles on B", async () => {
		let current = true;
		const cancellation = deferred<{ cancelled: true }>();
		const acknowledged: string[] = [];
		const result = reconcileTransformRun({
			requestId: "request-a",
			query: async () => ({ status: "reserved" }),
			cancel: async () => await cancellation.promise,
			acknowledge: async () => {
				acknowledged.push("request-a");
				return true;
			},
			isCurrent: () => current,
		});
		await Promise.resolve();
		current = false;
		cancellation.resolve({ cancelled: true });
		await expect(result).resolves.toEqual({ status: "stale" });
		expect(acknowledged).toEqual([]);
	});

	it("drops A's retry-safe result after its lookup resolves on B", async () => {
		let current = true;
		const lookup = deferred<{ status: "failed" }>();
		const result = reconcileTransformRun({
			requestId: "request-a",
			query: async () => await lookup.promise,
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => true,
			isCurrent: () => current,
		});
		current = false;
		lookup.resolve({ status: "failed" });
		await expect(result).resolves.toEqual({ status: "stale" });
	});

	it("drops A's success before commit when acknowledgement resolves on B", async () => {
		let current = true;
		const acknowledgement = deferred<boolean>();
		const result = reconcileTransformRun({
			requestId: "request-a",
			query: async () => ({
				status: "succeeded",
				applicable: true,
				output: "replacement",
			}),
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => await acknowledgement.promise,
			isCurrent: () => current,
		});
		await Promise.resolve();
		current = false;
		acknowledgement.resolve(true);
		await expect(result).resolves.toEqual({ status: "stale" });
	});

	it("does not let A's acknowledgement failure overwrite B", async () => {
		let current = true;
		const acknowledgement = deferred<void>();
		const result = reconcileTransformRun({
			requestId: "request-a",
			query: async () => ({
				status: "succeeded",
				applicable: true,
				output: "replacement",
			}),
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => {
				await acknowledgement.promise;
				throw new Error("transport failed");
			},
			isCurrent: () => current,
		});
		await Promise.resolve();
		current = false;
		acknowledgement.resolve();
		await expect(result).resolves.toEqual({ status: "stale" });
	});

	it("drops old A after A to B to A installs a newer generation", async () => {
		const captured = unresolved("old-a", "doc-a", 1);
		let current: UnresolvedTransform | null = captured;
		let generation = 1;
		const lookup = deferred<{ status: "failed" }>();
		const result = reconcileTransformRun({
			requestId: captured.requestId,
			query: async () => await lookup.promise,
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => true,
			isCurrent: () =>
				transformReconciliationIsCurrent(
					captured,
					current,
					current?.documentId ?? null,
					generation,
				),
		});
		current = unresolved("new-a", "doc-a", 3);
		generation = 3;
		lookup.resolve({ status: "failed" });
		await expect(result).resolves.toEqual({ status: "stale" });
	});

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
