import { getFunctionName } from "convex/server";
import { act, createElement, useCallback, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { loadDraft } from "@/lib/sync/draft-buffer";

import type { HistoryController, HistoryNode } from "./use-document-history";

// ---------------------------------------------------------------------------
// convex/react stubs. Queries are fed by the harness; mutations record their
// call and hand back a promise the test settles by hand, so the window between
// "this client moved" and "the server confirmed" — where plan 022's race lives
// — stays open for as long as a scenario needs.
// ---------------------------------------------------------------------------
type MutationCall = {
	name: string;
	args: Record<string, unknown>;
	resolve: (result: unknown) => void;
};

const mutationCalls: MutationCall[] = [];
let dagRows: HistoryNode[] | undefined;

// The draft buffer talks to the bare `localStorage` global, which this
// environment does not provide. The tests care whether the draft survives a
// head divergence, so give it somewhere real to live.
const removedKeys: string[] = [];

function installLocalStorage() {
	removedKeys.length = 0;
	const store = new Map<string, string>();
	const shim: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key) => store.get(key) ?? null,
		key: (index) => [...store.keys()][index] ?? null,
		removeItem: (key) => {
			removedKeys.push(key);
			store.delete(key);
		},
		setItem: (key, value) => {
			store.set(key, value);
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: shim,
		configurable: true,
		writable: true,
	});
}

vi.mock("convex/react", () => ({
	useQuery: (_ref: unknown, args: unknown) =>
		args === "skip" ? undefined : dagRows,
	useMutation: (ref: never) => {
		const name = getFunctionName(ref);
		return (args: Record<string, unknown>) => {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			mutationCalls.push({ name, args, resolve });
			return promise;
		};
	},
}));

const { decideServerPointer, useDocumentHistory } = await import(
	"./use-document-history"
);
const { useDocumentSync } = await import("@/lib/sync/use-document-sync");

const NAMES = {
	commitEdit: getFunctionName(api.documents.commitEdit),
	updateMarkdown: getFunctionName(api.documents.updateMarkdown),
	updatePointer: getFunctionName(api.documents.updateCurrentNodeId),
};

function callsTo(name: string): MutationCall[] {
	return mutationCalls.filter((c) => c.name === name);
}
function lastCallTo(name: string): MutationCall | undefined {
	return mutationCalls.findLast((c) => c.name === name);
}

// SAFETY: Id<"documents"> is a branded string; the mocked Convex client never
// dereferences it.
const DOC_ID = "doc1" as Id<"documents">;
const ROOT = "00000000-0000-4000-8000-000000000000";
const TYPED = "The quick brown fox jumps over the lazy dog.";
const AI = "The quick brown fox jumped over the lazy dog.";
const REMOTE = "01REMOTEBRANCHNODE0000000";
const REMOTE_TEXT = "A sentence written on the other device.";

function rootNode(snapshot = ""): HistoryNode {
	return {
		nodeId: ROOT,
		parentNodeId: null,
		patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
		snapshot,
		selection: null,
		origin: "server",
		createdAt: 1,
	};
}

/** A node another device committed on the same root. */
function remoteNode(): HistoryNode {
	return {
		nodeId: REMOTE,
		parentNodeId: ROOT,
		patch: JSON.stringify({ from: 0, to: 0, insert: REMOTE_TEXT }),
		snapshot: REMOTE_TEXT,
		selection: null,
		origin: "other-device",
		createdAt: 2,
	};
}

/** A minimal EditorHandle whose text the harness reads and writes. */
function fakeHandle(): EditorHandle & { text: string; focused: boolean } {
	const handle = {
		text: "",
		focused: false,
		caret: 0,
		seed(markdown: string) {
			handle.text = markdown;
		},
		getCanonicalMarkdown: () => handle.text,
		exportCaret: () => ({
			offset: handle.caret,
			anchor: handle.caret,
			head: handle.caret,
		}),
		importCaret(caret: { head: number }) {
			handle.caret = caret.head;
		},
		focus() {},
		isFocused: () => handle.focused,
		getRootElement: () => null,
		runFormat() {},
	};
	return handle;
}

/** What the reactive `documents.get` query is currently reporting. */
type ServerDoc = {
	currentNodeId: string;
	markdown: string;
	updatedAt: number;
	pointerRevision: number;
};

/**
 * Mounts the sync hook and the history hook wired exactly as workspace-context
 * wires them, because the contract between the two — who projects remote state,
 * who may flush, who is allowed to clear the draft — is what these tests are
 * about. Exercising either hook alone proves nothing about it.
 */
function mountStudio(handle: ReturnType<typeof fakeHandle>) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	let root: Root;
	let history!: HistoryController;
	let syncStatus = "";
	let onEditorChange: () => void = () => {};
	const pointerLog: Array<string | null> = [];

	function Harness(props: { server: ServerDoc | undefined }) {
		const { server } = props;
		const historyApiRef = useRef<HistoryController | null>(null);
		const getCurrentHeadNodeId = useCallback(
			() => historyApiRef.current?.getHeadNodeId() ?? null,
			[],
		);
		const getHasPendingDraft = useCallback(
			() => historyApiRef.current?.hasPendingDraft() ?? false,
			[],
		);
		const reconcileRemote = useCallback(
			() => historyApiRef.current?.reconcileRemote() ?? false,
			[],
		);

		const sync = useDocumentSync({
			documentId: DOC_ID,
			getEditorHandle: () => handle,
			serverMarkdown: server?.markdown,
			serverUpdatedAt: server?.updatedAt,
			enabled: server !== undefined,
			getCurrentHeadNodeId,
			getHasPendingDraft,
			reconcileRemote,
		});

		const h = useDocumentHistory({
			documentId: DOC_ID,
			getEditorHandle: () => handle,
			serverCurrentNodeId: server?.currentNodeId,
			serverMarkdown: server?.markdown,
			serverUpdatedAt: server?.updatedAt,
			serverPointerRevision: server?.pointerRevision,
			enabled: server !== undefined,
			origin: "test-device",
			onRemoteProjection: sync.acceptRemoteProjection,
		});
		historyApiRef.current = h;
		history = h;
		syncStatus = sync.syncStatus;

		const flushSync = sync.flushSync;
		const headKnown = h.currentNodeId !== null;
		useEffect(() => {
			if (!headKnown) return;
			void flushSync();
		}, [headKnown, flushSync]);

		onEditorChange = () => {
			sync.handleEditorChange();
			h.recordChange();
		};

		if (pointerLog[pointerLog.length - 1] !== h.currentNodeId) {
			pointerLog.push(h.currentNodeId);
		}
		return null;
	}

	function render(server: ServerDoc | undefined) {
		act(() => {
			root.render(createElement(Harness, { server }));
		});
	}

	act(() => {
		root = createRoot(container);
	});

	return {
		render,
		pointerLog,
		get history() {
			return history;
		},
		get syncStatus() {
			return syncStatus;
		},
		type(text: string) {
			act(() => {
				handle.text = text;
				onEditorChange();
			});
		},
		/** Structural commit — one node, without waiting on the grouping timer. */
		commit(text: string) {
			act(() => {
				handle.text = text;
				history.recordChange({ structural: true });
			});
		},
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/** Let debounces, the 2s idle timer and settled promises land. */
async function settle(ms = 3_000) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("decideServerPointer", () => {
	const base = { serverCurrentNodeId: "remote", serverPointerRevision: 7 };

	it("adopts any pointer when this client has no move outstanding", () => {
		expect(decideServerPointer({ ...base, localMove: null })).toBe("adopt");
	});

	it("ignores the pre-move pointer while our write is in flight", () => {
		expect(
			decideServerPointer({
				...base,
				localMove: { token: 1, nodeId: "local", appliedRevision: null },
			}),
		).toBe("ignore");
	});

	it("ignores an observation older than our own write", () => {
		expect(
			decideServerPointer({
				...base,
				serverPointerRevision: 6,
				localMove: { token: 1, nodeId: "local", appliedRevision: 7 },
			}),
		).toBe("ignore");
	});

	it("adopts an observation newer than our own write", () => {
		expect(
			decideServerPointer({
				...base,
				serverPointerRevision: 8,
				localMove: { token: 1, nodeId: "local", appliedRevision: 7 },
			}),
		).toBe("adopt");
	});

	it("adopts on an equal revision naming a different node", () => {
		// One revision is one pointer write, so this should not arise. If it ever
		// does, adopting is the safe direction — the failure being fixed is
		// ignoring real remote moves, never adopting too eagerly.
		expect(
			decideServerPointer({
				...base,
				serverPointerRevision: 7,
				localMove: { token: 1, nodeId: "local", appliedRevision: 7 },
			}),
		).toBe("adopt");
	});

	it("settles once the server echoes our own move back", () => {
		expect(
			decideServerPointer({
				...base,
				serverCurrentNodeId: "local",
				localMove: { token: 1, nodeId: "local", appliedRevision: null },
			}),
		).toBe("settled");
	});
});

describe("studio sync + history contract", () => {
	beforeEach(() => {
		// SAFETY: React reads this flag off the global object in dev builds; the
		// cast only names the property it looks for.
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		mutationCalls.length = 0;
		dagRows = undefined;
		installLocalStorage();
		vi.useFakeTimers();
	});

	it("plan 022: undo after an AI accept returns to the typed sentence", () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);

		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});
		expect(s.history.currentNodeId).toBe(ROOT);

		s.commit(TYPED);
		const typedNodeId = s.history.currentNodeId;
		if (!typedNodeId) throw new Error("the typed change committed no node");

		// That commit reaches the server: node and pointer move together.
		dagRows = [rootNode(), ...s.history.nodes.filter((n) => n.nodeId !== ROOT)];
		s.render({
			currentNodeId: typedNodeId,
			markdown: TYPED,
			updatedAt: 2_000,
			pointerRevision: 2,
		});

		// AI transform accepted. The writer clicked "Keep", so the editor is not
		// focused, and the commit has not been acknowledged yet.
		s.commit(AI);
		const aiNodeId = s.history.currentNodeId;
		expect(aiNodeId).not.toBe(typedNodeId);

		// THE RACE: the debounced markdown save bumps updatedAt while
		// currentNodeId still names the pre-AI node — a stale pointer wearing a
		// fresh timestamp. The unchanged pointer revision is what exposes it.
		s.render({
			currentNodeId: typedNodeId,
			markdown: AI,
			updatedAt: 3_000,
			pointerRevision: 2,
		});
		expect(s.history.currentNodeId).toBe(aiNodeId);

		act(() => {
			s.history.undo();
		});
		expect(s.history.currentNodeId).toBe(typedNodeId);
		expect(handle.text).toBe(TYPED);

		expect(s.pointerLog).toEqual([
			null,
			ROOT,
			typedNodeId,
			aiNodeId,
			typedNodeId,
		]);
		s.unmount();
	});

	it("R1: does not autosave before the head is known, then flushes once it is", async () => {
		const handle = fakeHandle();
		dagRows = undefined; // the DAG query has not resolved
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		s.type("typed before history hydrated");
		await settle();

		// A headless write has no compare-and-set and would land under whichever
		// branch currently owns the document.
		expect(callsTo(NAMES.updateMarkdown)).toEqual([]);
		expect(s.syncStatus).toBe("unsynced");

		// The DAG arrives; the head becomes known and the held draft goes up.
		dagRows = [rootNode()];
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});
		await settle();

		// The head it names is whatever the tree is on now — the replayed node —
		// but it must name one, which is the whole point of holding the flush.
		const saves = callsTo(NAMES.updateMarkdown);
		expect(saves.length).toBeGreaterThan(0);
		expect(saves[0]?.args.expectedHeadNodeId).toBe(s.history.currentNodeId);
		expect(saves[0]?.args.expectedHeadNodeId).not.toBeNull();
		s.unmount();
	});

	it("R2: keeps the draft dirty when the server reports the head moved", async () => {
		const handle = fakeHandle();
		const DRAFT = "a draft this device will lose the head for";
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		s.type(DRAFT);
		await settle(600);

		const saves = callsTo(NAMES.updateMarkdown);
		expect(saves.length).toBeGreaterThan(0);
		// Only clears caused by the divergence count; an earlier no-op flush
		// legitimately clears an empty draft on open.
		const clearsBefore = removedKeys.length;
		await act(async () => {
			for (const save of saves) {
				save.resolve({ updatedAt: 5_000, stale: true, headMoved: true });
			}
		});

		// The draft must never be DISCARDED here: only a completed projection may
		// retire it, and nothing has replaced this text yet. Asserting on the
		// stored value alone is not enough — a following flush attempt rewrites
		// it, which would hide a deletion.
		expect(removedKeys.slice(clearsBefore)).toEqual([]);
		expect(loadDraft(DOC_ID)?.markdown).toBe(DRAFT);
		expect(s.syncStatus).not.toBe("saved");
		s.unmount();
	});

	it("R3: adoption projects the editor text, not just the pointer", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		dagRows = [rootNode(), remoteNode()];
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
		});
		await settle();

		expect(s.history.currentNodeId).toBe(REMOTE);
		// The pointer used to move while the editor kept showing the old text.
		expect(handle.text).toBe(REMOTE_TEXT);
		s.unmount();
	});

	it("R4: adopts on idle even though the editor never loses focus", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		// vim and full-screen never release DOM focus.
		handle.focused = true;
		s.type(TYPED);
		await settle(600); // the grouping boundary commits the typed node

		// Acknowledge it, or this client's own in-flight move would rightly
		// outrank the server pointer and nothing would be queued.
		await act(async () => {
			for (const call of callsTo(NAMES.commitEdit)) {
				call.resolve({
					committed: true,
					headNodeId: "x",
					updatedAt: 1_500,
					pointerRevision: 2,
				});
			}
		});

		dagRows = [rootNode(), remoteNode()];
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 3,
		});
		// Deferred while the editor is still warm, then taken on the idle timer.
		expect(s.history.currentNodeId).not.toBe(REMOTE);
		await settle();

		expect(handle.focused).toBe(true);
		expect(s.history.currentNodeId).toBe(REMOTE);
		expect(handle.text).toBe(REMOTE_TEXT);
		s.unmount();
	});

	it("R4: still refuses to project over keystrokes no node has captured", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		// Typed, never committed: this text exists nowhere else.
		act(() => {
			handle.text = "half a sentence";
			s.history.recordChange();
		});

		dagRows = [rootNode(), remoteNode()];
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
		});
		await act(async () => {
			window.dispatchEvent(new Event("focusout"));
		});

		expect(s.history.currentNodeId).toBe(ROOT);
		expect(handle.text).toBe("half a sentence");
		s.unmount();
	});

	it("does not let an A -> B -> A response settle the wrong move", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		act(() => s.history.navigateTo(REMOTE));
		act(() => s.history.navigateTo(ROOT));
		act(() => s.history.navigateTo(REMOTE));
		expect(s.history.currentNodeId).toBe(REMOTE);

		const pointerWrites = callsTo(NAMES.updatePointer);
		expect(pointerWrites.length).toBe(3);

		// The FIRST navigate finally answers, rejected, naming ROOT as the winner.
		// Settling by node id would apply that to the third move (same node), queue
		// ROOT, and walk the pointer off the node the writer just chose.
		await act(async () => {
			pointerWrites[0]?.resolve({
				applied: false,
				currentNodeId: ROOT,
				pointerRevision: 9,
			});
		});
		await settle();

		expect(s.history.currentNodeId).toBe(REMOTE);
		s.unmount();
	});

	it("sends the head it is committing onto with every edit", () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		s.commit(TYPED);
		const first = lastCallTo(NAMES.commitEdit);
		expect(first?.args.expectedHeadNodeId).toBe(ROOT);
		const typedNodeId = s.history.currentNodeId;

		s.commit(AI);
		const second = lastCallTo(NAMES.commitEdit);
		expect(second?.args.expectedHeadNodeId).toBe(typedNodeId);
		expect(second?.args.markdown).toBe(AI);
		s.unmount();
	});

	it("replays keystrokes typed before the DAG query resolved", () => {
		const handle = fakeHandle();
		dagRows = undefined;
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});
		expect(s.history.currentNodeId).toBeNull();

		act(() => {
			handle.text = TYPED;
			s.history.recordChange();
		});

		dagRows = [rootNode()];
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		expect(s.history.currentNodeId).not.toBe(ROOT);
		expect(lastCallTo(NAMES.commitEdit)?.args.markdown).toBe(TYPED);
		s.unmount();
	});

	it("drops pre-hydration keystrokes the seed clobbered, rather than committing a node the editor never showed", () => {
		const handle = fakeHandle();
		const FROM_SERVER = "Text this document already had on the server.";
		dagRows = undefined;
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: FROM_SERVER,
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		act(() => {
			handle.text = "typed before anything had loaded";
			s.history.recordChange();
		});

		// use-document-sync seeds the server markdown, overwriting what was typed.
		handle.seed(FROM_SERVER, { programmatic: true });

		dagRows = [rootNode(FROM_SERVER)];
		s.render({
			currentNodeId: ROOT,
			markdown: FROM_SERVER,
			updatedAt: 1_000,
			pointerRevision: 1,
		});

		expect(s.history.currentNodeId).toBe(ROOT);
		expect(callsTo(NAMES.commitEdit)).toEqual([]);
		s.unmount();
	});
});
