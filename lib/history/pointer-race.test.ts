import { getFunctionName } from "convex/server";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";

import type { HistoryController, HistoryNode } from "./use-document-history";

// ---------------------------------------------------------------------------
// convex/react stubs. `useQuery` returns whatever the harness has published as
// the reactive docNodes rows.
//
// Mutations return a promise that never settles, which is not a shortcut — it
// pins the client in the exact window plan 022's race lives in: the pointer has
// moved locally but the write has not been acknowledged, so every server value
// the client sees still describes the state before the move.
// ---------------------------------------------------------------------------
const mutationCalls: Array<{ name: string; args: unknown }> = [];
let dagRows: HistoryNode[] | undefined;

vi.mock("convex/react", () => ({
	useQuery: (_ref: unknown, args: unknown) =>
		args === "skip" ? undefined : dagRows,
	useMutation: (ref: never) => {
		const name = getFunctionName(ref);
		return (args: unknown) => {
			mutationCalls.push({ name, args });
			return new Promise(() => {});
		};
	},
}));

/** The `documents.commitEdit` payload this harness asserts on. */
type CommitCall = {
	node: { nodeId: string; parentNodeId: string | null };
	markdown: string;
	expectedHeadNodeId: string;
	clientMutationId: string;
};

/** Args of every `documents.commitEdit` call, in order. */
function commitCalls(): CommitCall[] {
	const calls = mutationCalls.filter(
		(c) => c.name === getFunctionName(api.documents.commitEdit),
	);
	// SAFETY: filtered to commitEdit, whose args validator declares this shape.
	return calls.map((c) => c.args as CommitCall);
}

const { decideServerPointer, useDocumentHistory } = await import(
	"./use-document-history"
);

const ROOT = "00000000-0000-4000-8000-000000000000";
const TYPED = "The quick brown fox jumps over the lazy dog.";
const AI = "The quick brown fox jumped over the lazy dog.";

function rootNode(): HistoryNode {
	return {
		nodeId: ROOT,
		parentNodeId: null,
		patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
		snapshot: "",
		selection: null,
		origin: "server",
		createdAt: 1,
	};
}

/** A minimal EditorHandle whose text the harness reads and writes. */
function fakeHandle(): EditorHandle & { text: string; focused: boolean } {
	const handle = {
		text: "",
		focused: false,
		seed(markdown: string) {
			handle.text = markdown;
		},
		getCanonicalMarkdown: () => handle.text,
		exportCaret: () => ({ offset: 0, anchor: 0, head: 0 }),
		importCaret() {},
		focus() {},
		isFocused: () => handle.focused,
		getRootElement: () => null,
		runFormat() {},
	};
	return handle;
}

type Props = {
	serverCurrentNodeId: string | undefined;
	serverUpdatedAt: number | undefined;
};

/**
 * Drives the real `useDocumentHistory` in a DOM root so effect ordering — the
 * thing plan 022's race lives in — is React's, not a hand-rolled simulation.
 */
function mountHistory(handle: EditorHandle) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	let root: Root;
	let controller!: HistoryController;
	/** Every distinct currentNodeId the hook has rendered, in order. */
	const pointerLog: Array<string | null> = [];

	function Harness(props: Props) {
		controller = useDocumentHistory({
			// SAFETY: Id<"documents"> is a branded string and the mocked Convex
			// client never dereferences it.
			documentId: "doc1" as Id<"documents">,
			getEditorHandle: () => handle,
			serverCurrentNodeId: props.serverCurrentNodeId,
			serverMarkdown: "",
			serverUpdatedAt: props.serverUpdatedAt,
			enabled: true,
			origin: "test-device",
		});
		if (pointerLog[pointerLog.length - 1] !== controller.currentNodeId) {
			pointerLog.push(controller.currentNodeId);
		}
		return null;
	}

	function render(props: Props) {
		act(() => {
			root.render(createElement(Harness, props));
		});
	}

	act(() => {
		root = createRoot(container);
	});

	return {
		render,
		pointerLog,
		get controller() {
			return controller;
		},
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("decideServerPointer", () => {
	const base = { serverCurrentNodeId: "remote", serverUpdatedAt: 2_000 };

	it("adopts any pointer when this client has no move outstanding", () => {
		expect(decideServerPointer({ ...base, localMove: null })).toBe("adopt");
	});

	it("ignores the pre-move pointer while our write is in flight", () => {
		expect(
			decideServerPointer({
				...base,
				localMove: { nodeId: "local", appliedAt: null },
			}),
		).toBe("ignore");
	});

	it("ignores a query result produced before our write landed", () => {
		expect(
			decideServerPointer({
				...base,
				serverUpdatedAt: 2_000,
				localMove: { nodeId: "local", appliedAt: 2_000 },
			}),
		).toBe("ignore");
	});

	it("adopts a remote move that is genuinely newer than ours", () => {
		expect(
			decideServerPointer({
				...base,
				serverUpdatedAt: 2_001,
				localMove: { nodeId: "local", appliedAt: 2_000 },
			}),
		).toBe("adopt");
	});

	it("settles once the server echoes our own move back", () => {
		expect(
			decideServerPointer({
				...base,
				serverCurrentNodeId: "local",
				localMove: { nodeId: "local", appliedAt: null },
			}),
		).toBe("settled");
	});
});

describe("plan 022 — undo pointer race after an AI accept", () => {
	beforeEach(() => {
		// SAFETY: React reads this flag off the global object in dev builds; the
		// cast only names the property it looks for.
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		mutationCalls.length = 0;
		dagRows = undefined;
		vi.useFakeTimers();
	});

	it("keeps the local pointer when the server pointer is merely stale", () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const h = mountHistory(handle);

		// 1. Hydrate at the root.
		h.render({ serverCurrentNodeId: ROOT, serverUpdatedAt: 1_000 });
		expect(h.controller.currentNodeId).toBe(ROOT);

		// 2. The writer types a sentence; it commits as node N1.
		act(() => {
			handle.text = TYPED;
			h.controller.recordChange({ structural: true });
		});
		const typedNodeId = h.controller.currentNodeId;
		if (!typedNodeId) throw new Error("the typed change committed no node");
		expect(typedNodeId).not.toBe(ROOT);

		// 3. That commit reaches the server: the node row and the pointer move
		//    together, so the reactive queries now report N1 as the head.
		dagRows = [
			rootNode(),
			...h.controller.nodes.filter((n) => n.nodeId !== ROOT),
		];
		h.render({ serverCurrentNodeId: typedNodeId, serverUpdatedAt: 2_000 });

		// 4. The AI transform is accepted: a full-document replacement commits as
		//    N2, parented on N1. The writer is NOT focused — they clicked "Keep".
		handle.focused = false;
		act(() => {
			h.controller.commitProgrammatic(AI, { origin: "ai:grammar" });
		});
		const aiNodeId = h.controller.currentNodeId;
		expect(aiNodeId).not.toBe(typedNodeId);
		expect(aiNodeId).not.toBeNull();

		// 5. THE RACE. The AI commit has not been acknowledged yet, and meanwhile
		//    the sync hook's debounced documents.updateMarkdown advances
		//    documents.updatedAt while leaving documents.currentNodeId on N1. The
		//    reactive documents.get therefore pushes {currentNodeId: N1,
		//    updatedAt: newer} — a stale pointer wearing a fresh timestamp.
		h.render({ serverCurrentNodeId: typedNodeId, serverUpdatedAt: 3_000 });

		// Before the fix the hook adopted N1 here and the pointer walked backwards.
		expect(h.controller.currentNodeId).toBe(aiNodeId);

		// 6. Undo must land on the typed sentence, never on the empty root.
		act(() => {
			h.controller.undo();
		});
		expect(h.controller.currentNodeId).toBe(typedNodeId);
		expect(handle.text).toBe(TYPED);

		// The pointer only ever moved forwards, then back one step for the undo.
		// The regression signature was an extra ROOT after typedNodeId.
		expect(h.pointerLog).toEqual([
			null,
			ROOT,
			typedNodeId,
			aiNodeId,
			typedNodeId,
		]);

		// Both edits went through commitEdit, each naming the head it committed
		// onto, so the server can detect divergence.
		expect(
			commitCalls().map((c) => [c.node.nodeId, c.expectedHeadNodeId]),
		).toEqual([
			[typedNodeId, ROOT],
			[aiNodeId, typedNodeId],
		]);
		expect(commitCalls()[1]?.markdown).toBe(AI);

		h.unmount();
	});
});
