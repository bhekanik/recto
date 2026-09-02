import { describe, expect, it } from "vitest";
import {
	canRejectAiCommit,
	commitTransformAfterAcknowledgement,
	type PendingAiCommit,
	readAiTransformError,
	reconcileTransformRun,
	rejectAiCommit,
	resolveTransformRun,
	snapshotMatchesCurrent,
	transformReconciliationIsCurrent,
	type UnresolvedTransform,
} from "./use-ai-transform";

const documentId = "doc-a";

const sourceMarkdown = "# Before\n\nCafe\u0301 😀 — unchanged\n";
const aiMarkdown = "# AI result\n\nRewritten 📚\n";

function controller(args: {
	headNodeId: string | null;
	source?: string | null;
	hasPendingDraft?: boolean;
	commitProgrammatic?: PendingAiCommit["controller"]["commitProgrammatic"];
	navigateTo?: (nodeId: string) => void;
}) {
	return {
		commitProgrammatic: args.commitProgrammatic ?? (() => "ai-result"),
		getHeadNodeId: () => args.headNodeId,
		hasPendingDraft: () => args.hasPendingDraft ?? false,
		materializeAt: (nodeId: string) => {
			if (nodeId === "source") {
				return "source" in args ? (args.source ?? null) : sourceMarkdown;
			}
			return null;
		},
		navigateTo: args.navigateTo ?? (() => {}),
	};
}

function pending(owner: PendingAiCommit["controller"]): PendingAiCommit {
	return {
		documentId,
		controller: owner,
		sourceNodeId: "source",
		sourceMarkdown,
		aiNodeId: "ai-result",
		aiMarkdown,
	};
}

describe("AI transform rejection ownership", () => {
	it("allows immediate rejection before rendered history catches up", () => {
		const commitProgrammatic = () => "ai-result";
		const staleNavigations: string[] = [];
		const currentNavigations: string[] = [];
		const materialized: string[] = [];
		let displayedMarkdown = aiMarkdown;
		const owner = controller({
			headNodeId: "ai-result",
			commitProgrammatic,
			navigateTo: (nodeId) => staleNavigations.push(nodeId),
		});
		const staleRender = {
			...controller({
				headNodeId: "ai-result",
				commitProgrammatic,
				navigateTo: (nodeId) => currentNavigations.push(nodeId),
			}),
			materializeAt(nodeId: string) {
				materialized.push(nodeId);
				return nodeId === "source" ? sourceMarkdown : aiMarkdown;
			},
			navigateTo(nodeId: string) {
				currentNavigations.push(nodeId);
				displayedMarkdown = sourceMarkdown;
			},
		};

		expect(
			rejectAiCommit(
				pending(owner),
				documentId,
				staleRender,
				displayedMarkdown,
			),
		).toBe(true);
		expect(materialized).toEqual(["source"]);
		expect(currentNavigations).toEqual(["source"]);
		expect(staleNavigations).toEqual([]);
		expect(displayedMarkdown).toBe(sourceMarkdown);
	});

	it.each([
		"normal",
		"reconciled",
	])("allows rejection after a %s AI commit re-renders history", () => {
		const commitProgrammatic = () => "ai-result";
		const navigated: string[] = [];
		let displayedMarkdown = aiMarkdown;
		const owner = controller({
			headNodeId: "ai-result",
			commitProgrammatic,
		});
		const acknowledgedRender = controller({
			headNodeId: "ai-result",
			commitProgrammatic,
			navigateTo: (nodeId) => {
				navigated.push(nodeId);
				displayedMarkdown = sourceMarkdown;
			},
		});

		expect(
			rejectAiCommit(
				pending(owner),
				documentId,
				acknowledgedRender,
				displayedMarkdown,
			),
		).toBe(true);
		expect(navigated).toEqual(["source"]);
		expect(displayedMarkdown).toBe(sourceMarkdown);
	});

	it("does not undo a later edit flushed as an AI child", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "later-edit",
			navigateTo: (nodeId) => navigated.push(nodeId),
		});
		expect(
			rejectAiCommit(pending(owner), documentId, owner, "post-AI edit"),
		).toBe(false);
		expect(navigated).toEqual([]);
	});

	it("does not undo when visible Markdown changed before history recorded it", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "ai-result",
			navigateTo: (nodeId) => navigated.push(nodeId),
		});

		expect(
			rejectAiCommit(pending(owner), documentId, owner, `${aiMarkdown}draft`),
		).toBe(false);
		expect(navigated).toEqual([]);
	});

	it("does not undo a grouped pending draft", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "ai-result",
			hasPendingDraft: true,
			navigateTo: (nodeId) => navigated.push(nodeId),
		});

		expect(
			rejectAiCommit(pending(owner), documentId, owner, `${aiMarkdown}draft`),
		).toBe(false);
		expect(navigated).toEqual([]);
	});

	it("does not undo a pending draft even when visible text matches the AI node", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "ai-result",
			hasPendingDraft: true,
			navigateTo: (nodeId) => navigated.push(nodeId),
		});

		expect(rejectAiCommit(pending(owner), documentId, owner, aiMarkdown)).toBe(
			false,
		);
		expect(navigated).toEqual([]);
	});

	it("does not navigate after a document switch", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "ai-result",
			navigateTo: (nodeId) => navigated.push(nodeId),
		});
		expect(rejectAiCommit(pending(owner), "doc-b", owner, aiMarkdown)).toBe(
			false,
		);
		expect(navigated).toEqual([]);
	});

	it("does not navigate through a replacement history controller", () => {
		const navigated: string[] = [];
		const owner = controller({ headNodeId: "ai-result" });
		const replacement = controller({
			headNodeId: "ai-result",
			navigateTo: (nodeId) => navigated.push(nodeId),
		});
		expect(
			rejectAiCommit(pending(owner), documentId, replacement, aiMarkdown),
		).toBe(false);
		expect(navigated).toEqual([]);
	});

	it("does not navigate for a stale result node", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "other-ai-result",
			navigateTo: (nodeId) => navigated.push(nodeId),
		});
		expect(rejectAiCommit(pending(owner), documentId, owner, aiMarkdown)).toBe(
			false,
		);
		expect(navigated).toEqual([]);
	});

	it("does not navigate while a remote head is queued", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: null,
			navigateTo: (nodeId) => navigated.push(nodeId),
		});

		expect(rejectAiCommit(pending(owner), documentId, owner, aiMarkdown)).toBe(
			false,
		);
		expect(navigated).toEqual([]);
	});

	it.each([
		null,
		"# Before\n\nCafé 😀 — changed\n",
	])("requires the source node to retain exact Markdown and Unicode (%s)", (source) => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "ai-result",
			source,
			navigateTo: (nodeId) => navigated.push(nodeId),
		});
		expect(rejectAiCommit(pending(owner), documentId, owner, aiMarkdown)).toBe(
			false,
		);
		expect(navigated).toEqual([]);
	});

	it("leaves the AI result in place on Keep", () => {
		const navigated: string[] = [];
		const owner = controller({
			headNodeId: "ai-result",
			navigateTo: (nodeId) => navigated.push(nodeId),
		});

		expect(
			canRejectAiCommit(pending(owner), documentId, owner, aiMarkdown),
		).toBe(true);
		expect(navigated).toEqual([]);
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
			requestInProgress: false,
		});
	});

	it("identifies a cross-tab request already in progress", async () => {
		await expect(
			readAiTransformError(
				Response.json(
					{
						error: "Another request is already in progress.",
						code: "request_in_progress",
					},
					{ status: 409 },
				),
			),
		).resolves.toEqual({
			message: "Another request is already in progress.",
			outcomeUnknown: false,
			retrySafe: false,
			requestInProgress: true,
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
			requestInProgress: false,
		});
	});

	it("falls back safely for an unstructured non-2xx response", async () => {
		await expect(
			readAiTransformError(new Response("gateway", { status: 503 })),
		).resolves.toEqual({
			message: "AI request failed (503)",
			outcomeUnknown: false,
			retrySafe: false,
			requestInProgress: false,
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
				flush() {},
				getHeadNodeId: () => "source",
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

	it.each([
		"immediate",
		"post-rerender",
	])("rejects a %s AI commit back to its flushed draft parent byte-for-byte", async (timing) => {
		const draftMarkdown = "# Draft\n\nCafe\u0301 😀 — writer text\n";
		const resultMarkdown = "# AI result\n\nCafe\u0301 😀 — rewritten\n";
		const materialized = new Map([
			["node-a", "# Older node\n"],
			["node-b", draftMarkdown],
			["node-c", resultMarkdown],
		]);
		let headNodeId = "node-a";
		let displayedMarkdown = draftMarkdown;
		const navigated: string[] = [];
		const commitProgrammatic = (markdown: string) => {
			headNodeId = "node-c";
			displayedMarkdown = markdown;
			return headNodeId;
		};
		const owner = {
			currentNodeId: "node-a",
			flush() {
				headNodeId = "node-b";
			},
			getHeadNodeId: () => headNodeId,
			commitProgrammatic,
			hasPendingDraft: () => false,
			materializeAt: (nodeId: string) => materialized.get(nodeId) ?? null,
			navigateTo(nodeId: string) {
				navigated.push(nodeId);
				displayedMarkdown = materialized.get(nodeId) ?? displayedMarkdown;
			},
		};
		const commit = await commitTransformAfterAcknowledgement({
			acknowledge: async () => true,
			snapshot: {
				sourceNodeId: "node-a",
				sourceMarkdown: draftMarkdown,
				range: { from: 9, to: 14 },
				selection: "Cafe\u0301",
			},
			controller: owner,
			getMarkdown: () => displayedMarkdown,
			isCurrent: () => true,
			nextMarkdown: resultMarkdown,
			origin: "ai:tighten",
		});

		expect(commit).toEqual({
			status: "committed",
			nodeId: "node-c",
			sourceNodeId: "node-b",
			aiMarkdown: resultMarkdown,
		});
		if (commit.status !== "committed" || !commit.nodeId) {
			throw new Error("Expected an AI commit");
		}
		const pendingCommit: PendingAiCommit = {
			documentId,
			controller: owner,
			sourceNodeId: commit.sourceNodeId,
			sourceMarkdown: draftMarkdown,
			aiNodeId: commit.nodeId,
			aiMarkdown: commit.aiMarkdown,
		};
		const currentController = timing === "immediate" ? owner : { ...owner };

		expect(
			rejectAiCommit(
				pendingCommit,
				documentId,
				currentController,
				displayedMarkdown,
			),
		).toBe(true);
		expect(navigated).toEqual(["node-b"]);
		expect(displayedMarkdown).toBe(draftMarkdown);
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

	it.each([
		{
			name: "reserved",
			run: { requestId: "request-a", status: "reserved" as const },
			expected: { status: "retry-safe" as const },
			expectsAcknowledgement: true,
		},
		{
			name: "provider started",
			run: { requestId: "request-a", status: "provider_started" as const },
			expected: { status: "unresolved" as const },
			expectsAcknowledgement: false,
		},
		{
			name: "outcome unknown",
			run: { requestId: "request-a", status: "outcome_unknown" as const },
			expected: { status: "unresolved" as const },
			expectsAcknowledgement: false,
		},
		{
			name: "applicable success",
			run: {
				requestId: "request-a",
				status: "succeeded" as const,
				applicable: true,
				output: "replacement",
			},
			expected: { status: "succeeded" as const, output: "replacement" },
			expectsAcknowledgement: true,
		},
	])("adopts cross-tab active A when B is missing: $name", async (attack) => {
		let current = unresolved("request-b", "doc-a", 1);
		const adopted: string[] = [];
		const cancelled: string[] = [];
		const acknowledged: string[] = [];
		const result = await reconcileTransformRun({
			requestId: "request-b",
			query: async () => null,
			recovery: {
				latest: async () => attack.run,
				adopt: (requestId, activeRequestId) => {
					if (current.requestId !== requestId) return false;
					current = unresolved(activeRequestId, "doc-a", 2);
					adopted.push(activeRequestId);
					return true;
				},
			},
			cancel: async (requestId) => {
				cancelled.push(requestId);
				return { cancelled: true };
			},
			acknowledge: async (requestId) => {
				acknowledged.push(requestId);
				return true;
			},
			isCurrent: (requestId) => current.requestId === requestId,
		});

		expect(result).toEqual(attack.expected);
		expect(adopted).toEqual(["request-a"]);
		expect(cancelled).toEqual(
			attack.run.status === "reserved" ? ["request-a"] : [],
		);
		expect(acknowledged).toEqual(
			attack.expectsAcknowledgement ? ["request-a"] : [],
		);
	});

	it("keeps a missing current ID locked when no recoverable run exists", async () => {
		await expect(
			reconcileTransformRun({
				requestId: "request-b",
				query: async () => null,
				recovery: {
					latest: async () => null,
					adopt: () => true,
				},
				cancel: async () => ({ cancelled: true }),
				acknowledge: async () => true,
				isCurrent: () => true,
			}),
		).resolves.toEqual({ status: "unresolved" });
	});

	it("does not adopt A after B is replaced while latest recovery is pending", async () => {
		let current = unresolved("request-b", "doc-a", 1);
		const latest = deferred<{
			requestId: string;
			status: "provider_started";
		}>();
		const adopted: string[] = [];
		const result = reconcileTransformRun({
			requestId: "request-b",
			query: async () => null,
			recovery: {
				latest: async () => await latest.promise,
				adopt: (_requestId, activeRequestId) => {
					adopted.push(activeRequestId);
					return true;
				},
			},
			cancel: async () => ({ cancelled: true }),
			acknowledge: async () => true,
			isCurrent: (requestId) => current.requestId === requestId,
		});
		current = unresolved("new-request-b", "doc-a", 2);
		latest.resolve({ requestId: "request-a", status: "provider_started" });

		await expect(result).resolves.toEqual({ status: "stale" });
		expect(adopted).toEqual([]);
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
