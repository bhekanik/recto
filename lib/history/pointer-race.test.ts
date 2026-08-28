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
	settled: boolean;
};

const mutationCalls: MutationCall[] = [];
let dagRows: HistoryNode[] | undefined;

// Convex memoizes the function it returns for a given reference. Handing back a
// fresh closure per render would change the identity of every useCallback that
// depends on it, re-firing effects (notably the head-known flush) on every
// render and hiding real dependency bugs.
const mutationFns = new Map<
	string,
	(args: Record<string, unknown>) => Promise<unknown>
>();

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
		const existing = mutationFns.get(name);
		if (existing) return existing;
		const fn = (args: Record<string, unknown>) => {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			mutationCalls.push({ name, args, resolve, settled: false });
			return promise;
		};
		mutationFns.set(name, fn);
		return fn;
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

/**
 * Answer the OLDEST unanswered call to `name`. Convex delivers a client's
 * mutation results in the order they were sent, so a test that settles them out
 * of order is testing something the runtime cannot do.
 */
async function respond(name: string, result: unknown): Promise<void> {
	const call = mutationCalls.find((c) => c.name === name && !c.settled);
	if (!call) throw new Error(`no unanswered ${name} call to respond to`);
	call.settled = true;
	await act(async () => {
		call.resolve(result);
	});
}

/** Answer every outstanding call to `name`, oldest first. */
async function respondAll(name: string, result: unknown): Promise<void> {
	while (mutationCalls.some((c) => c.name === name && !c.settled)) {
		await respond(name, result);
	}
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
	let sync!: ReturnType<typeof useDocumentSync>;
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

		const syncHook = useDocumentSync({
			documentId: DOC_ID,
			getEditorHandle: () => handle,
			serverMarkdown: server?.markdown,
			serverUpdatedAt: server?.updatedAt,
			enabled: server !== undefined,
			getCurrentHeadNodeId,
			getHasPendingDraft,
			reconcileRemote,
		});
		sync = syncHook;

		const h = useDocumentHistory({
			documentId: DOC_ID,
			getEditorHandle: () => handle,
			serverCurrentNodeId: server?.currentNodeId,
			serverMarkdown: server?.markdown,
			serverUpdatedAt: server?.updatedAt,
			serverPointerRevision: server?.pointerRevision,
			enabled: server !== undefined,
			origin: "test-device",
			onRemoteProjection: syncHook.acceptRemoteProjection,
		});
		historyApiRef.current = h;
		history = h;
		syncStatus = syncHook.syncStatus;

		const flushSync = syncHook.flushSync;
		const headKnown = h.currentNodeId !== null;
		useEffect(() => {
			if (!headKnown) return;
			void flushSync();
		}, [headKnown, flushSync]);

		// The studio's single change handler: autosave and undo tree see every
		// edit through the same call, in the same order the app makes it.
		onEditorChange = () => {
			syncHook.handleEditorChange();
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
		get sync() {
			return sync;
		},
		get syncStatus() {
			return syncStatus;
		},
		/** Type, exactly as the studio reports it: one handler, both hooks. */
		type(text: string) {
			act(() => {
				handle.text = text;
				onEditorChange();
			});
		},
		/** Run whatever the app would do synchronously, inside one React batch. */
		run(fn: () => void) {
			act(fn);
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

/** A node another device committed and then kept typing past. */
const LOCAL_NODE = "01LOCALCOMMITNODE00000000";
const LOCAL_TEXT = "Text device A committed as a node.";
const AHEAD_TEXT = "Text device A committed as a node, plus unsaved words.";

function localNode(): HistoryNode {
	return {
		nodeId: LOCAL_NODE,
		parentNodeId: ROOT,
		patch: JSON.stringify({ from: 0, to: 0, insert: LOCAL_TEXT }),
		snapshot: LOCAL_TEXT,
		selection: null,
		origin: "other-device",
		createdAt: 2,
	};
}

const AT_ROOT: ServerDoc = {
	currentNodeId: ROOT,
	markdown: "",
	updatedAt: 1_000,
	pointerRevision: 1,
};

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

	it("plan 022: undo after an AI accept returns to the typed sentence", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		expect(s.history.currentNodeId).toBe(ROOT);

		s.type(TYPED);
		await settle(600);
		const typedNodeId = s.history.currentNodeId;
		if (!typedNodeId) throw new Error("the typed sentence committed no node");
		expect(typedNodeId).not.toBe(ROOT);

		await respond(NAMES.commitEdit, {
			committed: true,
			headNodeId: typedNodeId,
			updatedAt: 2_000,
			pointerRevision: 2,
		});
		dagRows = [rootNode(), ...s.history.nodes.filter((n) => n.nodeId !== ROOT)];
		s.render({
			currentNodeId: typedNodeId,
			markdown: TYPED,
			updatedAt: 2_000,
			pointerRevision: 2,
		});

		// The AI transform's own commit path: seed, record, flush, one node.
		s.run(() => {
			s.history.commitProgrammatic(AI, { origin: "ai:grammar" });
		});
		const aiNodeId = s.history.currentNodeId;
		expect(aiNodeId).not.toBe(typedNodeId);
		expect(handle.text).toBe(AI);

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

		s.run(() => s.history.undo());
		expect(s.history.currentNodeId).toBe(typedNodeId);
		expect(handle.text).toBe(TYPED);
		s.unmount();
	});

	it("R1: does not autosave before the head is known, then flushes once it is", async () => {
		const handle = fakeHandle();
		dagRows = undefined; // the DAG query has not resolved
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type("typed before history hydrated");
		await settle();

		// A headless write has no compare-and-set and would land under whichever
		// branch currently owns the document.
		expect(callsTo(NAMES.updateMarkdown)).toEqual([]);
		expect(s.syncStatus).toBe("unsynced");

		dagRows = [rootNode()];
		s.render(AT_ROOT);
		await settle();

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
		s.render(AT_ROOT);

		s.type(DRAFT);
		await settle(600);

		// Only clears caused by the divergence count; an earlier no-op flush
		// legitimately clears an empty draft on open.
		const clearsBefore = removedKeys.length;
		await respondAll(NAMES.updateMarkdown, {
			updatedAt: 5_000,
			stale: true,
			headMoved: true,
		});

		// The draft must never be DISCARDED here: only a completed projection may
		// retire it, and nothing has replaced this text yet. Asserting on the
		// stored value alone is not enough — a following flush attempt rewrites
		// it, which would hide a deletion.
		expect(removedKeys.slice(clearsBefore)).toEqual([]);
		expect(loadDraft(DOC_ID)?.markdown).toBe(DRAFT);
		expect(s.syncStatus).not.toBe("saved");

		// The in-memory half of the same rule: the unload guard must still fire,
		// or the writer closes the tab on unsaved text with no warning.
		const unload = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(unload);
		expect(unload.defaultPrevented).toBe(true);
		s.unmount();
	});

	it("R3: adoption projects the editor text, not just the pointer", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

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
		s.render(AT_ROOT);

		// vim and full-screen never release DOM focus.
		handle.focused = true;
		s.type(TYPED);
		await settle(600);
		await respondAll(NAMES.commitEdit, {
			committed: true,
			headNodeId: "x",
			updatedAt: 1_500,
			pointerRevision: 2,
		});

		dagRows = [rootNode(), remoteNode()];
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 3,
		});
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
		s.render(AT_ROOT);

		// Typed, never committed: this text exists nowhere else.
		s.run(() => {
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

	it("X1: stands down from autosave while a remote head is queued", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);

		// Answer the first save, or the flush pipeline stays busy and the
		// assertion below would hold for the wrong reason.
		await respondAll(NAMES.updateMarkdown, {
			updatedAt: 1_500,
			stale: false,
			headMoved: false,
		});
		await settle(0);

		// The commit is refused: another device owns the head. The winning node is
		// NOT in this client's DAG yet, so the projection cannot run.
		await respond(NAMES.commitEdit, {
			committed: false,
			diverged: true,
			remoteHeadNodeId: REMOTE,
			remotePointerRevision: 5,
		});

		const savesBefore = callsTo(NAMES.updateMarkdown).length;
		const clearsBefore = removedKeys.length;
		s.type("still typing after the divergence");
		await settle();

		// Adopting the winner's head here would let the CAS pass and write THIS
		// device's text under their branch — the precise thing the CAS prevents.
		expect(callsTo(NAMES.updateMarkdown).length).toBe(savesBefore);
		expect(s.syncStatus).toBe("unsynced");
		expect(removedKeys.slice(clearsBefore)).toEqual([]);
		s.unmount();
	});

	it("X2: projects a draft the other device saved ahead of its last node", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// Device A committed LOCAL_NODE, then its autosave stored AHEAD_TEXT
		// against that same head without closing a new node.
		dagRows = [rootNode(), localNode()];
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
		});
		await settle();

		expect(s.history.currentNodeId).toBe(LOCAL_NODE);
		// Projecting materialize(LOCAL_NODE) would silently drop the words that
		// exist only in documents.markdown.
		expect(handle.text).toBe(AHEAD_TEXT);

		// And this device must not then save the node's text back over them.
		const overwrote = callsTo(NAMES.updateMarkdown).some(
			(c) => c.args.markdown === LOCAL_TEXT,
		);
		expect(overwrote).toBe(false);

		// The controller sits on the node, so the next edit turns that rescued
		// draft into an ordinary node rather than a patch against itself.
		const extended = `${AHEAD_TEXT} typed here`;
		s.type(extended);
		await settle(600);
		const commit = lastCallTo(NAMES.commitEdit);
		expect(commit?.args.expectedHeadNodeId).toBe(LOCAL_NODE);
		expect(commit?.args.markdown).toBe(extended);
		s.unmount();
	});

	it("X4: a newer observation of our own head clears a stale queued pointer", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// R@2 arrives but its node has not synced, so it sits in the queue.
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
		});
		await settle();
		expect(s.history.currentNodeId).toBe(ROOT);
		// Autosave stands down while a remote head is outstanding.
		expect(s.history.getHeadNodeId()).toBeNull();

		// H@3: the other device moved back to the head we are already on. The
		// queued R@2 is now stale and must be replaced, not left waiting.
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 3_000,
			pointerRevision: 3,
		});
		await settle();

		expect(s.history.currentNodeId).toBe(ROOT);
		expect(s.history.getHeadNodeId()).toBe(ROOT);
		s.unmount();
	});

	it("hydrates against a row that predates pointerRevision", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		// documents.get reports 0 for rows written before the field existed.
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 0,
		});
		expect(s.history.currentNodeId).toBe(ROOT);

		// The first pointer write anywhere bumps it to 1, which must still read as
		// newer than the 0 this client hydrated on.
		dagRows = [rootNode(), remoteNode()];
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 1,
		});
		await settle();

		expect(s.history.currentNodeId).toBe(REMOTE);
		expect(handle.text).toBe(REMOTE_TEXT);
		s.unmount();
	});

	it("a mode switch flushing history then markdown in one tick sends the new head", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		// Let the open-document flush finish, so the mode switch is not merely
		// queued behind it.
		await settle(0);

		s.type(TYPED);

		// What switching lens does: close the open node, then push the text. Both
		// synchronously, before React re-renders — so a head read from rendered
		// state would still name the root.
		s.run(() => {
			s.history.flush();
			void s.sync.flushMarkdown(TYPED);
		});

		const newHead = s.history.currentNodeId;
		expect(newHead).not.toBe(ROOT);
		const save = lastCallTo(NAMES.updateMarkdown);
		expect(save?.args.expectedHeadNodeId).toBe(newHead);
		s.unmount();
	});

	it("cuts a node for a writer who never pauses, so nothing stays device-only", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// A continuous typist: every keystroke inside the 500ms grouping window,
		// so no idle boundary ever fires.
		for (let i = 1; i <= 40; i++) {
			s.type("x".repeat(i));
			await settle(200);
		}

		// Without a maximum grouping lifetime this text would live only in
		// documents.markdown, and a head divergence would have no branch to keep.
		expect(callsTo(NAMES.commitEdit).length).toBeGreaterThan(0);
		s.unmount();
	});

	it("does not let an A -> B -> A response settle the wrong move", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.run(() => s.history.navigateTo(REMOTE));
		s.run(() => s.history.navigateTo(ROOT));
		s.run(() => s.history.navigateTo(REMOTE));
		expect(s.history.currentNodeId).toBe(REMOTE);
		expect(callsTo(NAMES.updatePointer).length).toBe(3);

		// The FIRST navigate finally answers, rejected, naming ROOT as the winner.
		// Settling by node id would apply that to the third move (same node), queue
		// ROOT, and walk the pointer off the node the writer just chose.
		await respond(NAMES.updatePointer, {
			applied: false,
			currentNodeId: ROOT,
			pointerRevision: 9,
		});
		await settle();

		expect(s.history.currentNodeId).toBe(REMOTE);
		s.unmount();
	});

	it("sends the head it is committing onto with every edit", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		expect(lastCallTo(NAMES.commitEdit)?.args.expectedHeadNodeId).toBe(ROOT);
		const typedNodeId = s.history.currentNodeId;

		s.run(() => {
			s.history.commitProgrammatic(AI, { origin: "ai:grammar" });
		});
		const second = lastCallTo(NAMES.commitEdit);
		expect(second?.args.expectedHeadNodeId).toBe(typedNodeId);
		expect(second?.args.markdown).toBe(AI);
		s.unmount();
	});

	it("replays keystrokes typed before the DAG query resolved", () => {
		const handle = fakeHandle();
		dagRows = undefined;
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		expect(s.history.currentNodeId).toBeNull();

		s.type(TYPED);

		dagRows = [rootNode()];
		s.render(AT_ROOT);

		expect(s.history.currentNodeId).not.toBe(ROOT);
		expect(lastCallTo(NAMES.commitEdit)?.args.markdown).toBe(TYPED);
		s.unmount();
	});

	it("drops pre-hydration keystrokes the seed clobbered, rather than committing a node the editor never showed", () => {
		const handle = fakeHandle();
		const FROM_SERVER = "Text this document already had on the server.";
		const seeded: ServerDoc = {
			currentNodeId: ROOT,
			markdown: FROM_SERVER,
			updatedAt: 1_000,
			pointerRevision: 1,
		};
		dagRows = undefined;
		const s = mountStudio(handle);
		s.render(seeded);

		s.type("typed before anything had loaded");

		// use-document-sync seeds the server markdown, overwriting what was typed.
		s.run(() => handle.seed(FROM_SERVER, { programmatic: true }));

		dagRows = [rootNode(FROM_SERVER)];
		s.render(seeded);

		expect(s.history.currentNodeId).toBe(ROOT);
		expect(callsTo(NAMES.commitEdit)).toEqual([]);
		s.unmount();
	});
});
