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

/** Query state a mutation's result becomes visible alongside. */
type Snapshot = { server?: ServerDoc; dag?: HistoryNode[] };

let renderServer: ((server: ServerDoc) => void) | null = null;

/**
 * Answer the oldest unanswered mutation, whatever function it called.
 *
 * Convex orders ALL of one client's mutations, not just those to the same
 * function, so a per-function queue would let a test express an interleaving the
 * runtime cannot produce. `expectedName` asserts the caller knows which call is
 * actually next.
 *
 * `snapshot` advances the reactive queries BEFORE the promise settles, which is
 * the order Convex guarantees: a mutation's result never arrives before the
 * query results that reflect it.
 */
async function respond(
	expectedName: string,
	result: unknown,
	snapshot?: Snapshot,
): Promise<void> {
	const call = mutationCalls.find((c) => !c.settled);
	if (!call) throw new Error(`no unanswered mutation; wanted ${expectedName}`);
	if (call.name !== expectedName) {
		throw new Error(
			`next unanswered mutation is ${call.name}, not ${expectedName}`,
		);
	}
	call.settled = true;
	if (snapshot?.dag) dagRows = snapshot.dag;
	if (snapshot?.server) renderServer?.(snapshot.server);
	await act(async () => {
		call.resolve(result);
	});
}

const OK_SAVE = { updatedAt: 1_500, stale: false, headMoved: false };

/** A mutation result plus the query state it becomes visible alongside. */
type Answer = { result: unknown; snapshot?: Snapshot };

/** Did this response say the write landed? Those must carry a snapshot. */
function isSuccessfulWrite(result: unknown): boolean {
	const r = result as {
		committed?: boolean;
		applied?: boolean;
		stale?: boolean;
	};
	if (r.committed === true) return true;
	if (r.applied === true) return true;
	if (r.stale === false) return true;
	return false;
}

/**
 * Answer every outstanding mutation in the order the client sent them, one
 * answer per CALL rather than per function: two saves in a row leave the
 * document in different states, and reusing one answer for both describes a
 * backend that forgot the first.
 *
 * A successful write MUST supply a snapshot. On the real client a write that
 * landed is already reflected in the reactive queries by the time its result
 * arrives, so reporting success while leaving the queries on the old document
 * is a state the backend cannot produce — and the state stale-pointer bugs hide
 * in.
 */
async function drain(answers: Array<Answer & { name: string }>): Promise<void> {
	for (const answer of answers) {
		const next = mutationCalls.find((c) => !c.settled);
		if (!next) throw new Error(`no unanswered mutation for ${answer.name}`);
		if (isSuccessfulWrite(answer.result) && !answer.snapshot) {
			throw new Error(
				`${answer.name} reports success with no query snapshot; a landed write is always already visible to the queries`,
			);
		}
		await respond(answer.name, answer.result, answer.snapshot);
	}
	const leftover = mutationCalls.find((c) => !c.settled);
	if (leftover) throw new Error(`no answer supplied for ${leftover.name}`);
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
function fakeHandle(): EditorHandle & {
	text: string;
	focused: boolean;
	seeds: string[];
} {
	const handle = {
		text: "",
		focused: false,
		caret: 0,
		/** Every value ever seeded, so a test can assert what was never shown. */
		seeds: [] as string[],
		seed(markdown: string) {
			handle.seeds.push(markdown);
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
	/** Undefined models a legacy headless save: markdown of unknown provenance. */
	markdownHeadNodeId?: string;
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
	/** What workspace-context would hand the panes to render. */
	let projectedMarkdown: string | null = null;
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
			serverMarkdownHeadNodeId: server?.markdownHeadNodeId,
			getBaselineUpdatedAt: syncHook.getBaselineUpdatedAt,
			getRecoveredDraft: syncHook.getRecoveredDraft,
			enabled: server !== undefined,
			origin: "test-device",
			onProjection: (projection) => {
				// Mirrors workspace-context: publish for the panes, then decide
				// whether it counts as saved.
				projectedMarkdown = projection.markdown;
				if (projection.serverDerived) {
					syncHook.acceptRemoteProjection(
						projection.markdown,
						projection.serverUpdatedAt,
					);
				} else {
					syncHook.adoptRecoveredDraft(projection.markdown);
				}
			},
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
	// Let respond() advance the query snapshot before it settles a mutation.
	renderServer = (server: ServerDoc) => {
		root.render(createElement(Harness, { server }));
	};

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
		get projectedMarkdown() {
			return projectedMarkdown;
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
	markdownHeadNodeId: ROOT,
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
		renderServer = null;
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

		const afterCommit: ServerDoc = {
			currentNodeId: typedNodeId,
			markdown: TYPED,
			updatedAt: 2_000,
			pointerRevision: 2,
			markdownHeadNodeId: typedNodeId,
		};
		const dagAfterCommit = [
			rootNode(),
			...s.history.nodes.filter((n) => n.nodeId !== ROOT),
		];
		await drain([
			{
				name: NAMES.updateMarkdown,
				result: OK_SAVE,
				snapshot: { server: afterCommit, dag: dagAfterCommit },
			},
			{
				name: NAMES.commitEdit,
				result: {
					committed: true,
					headNodeId: typedNodeId,
					updatedAt: 2_000,
					pointerRevision: 2,
				},
				snapshot: { server: afterCommit, dag: dagAfterCommit },
			},
		]);
		s.render(afterCommit);

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

		// It names the head that existed when the flush ran — the root, since the
		// held keystrokes are still an open draft at that point.
		const saves = callsTo(NAMES.updateMarkdown);
		expect(saves.length).toBeGreaterThan(0);
		expect(saves[0]?.args.expectedHeadNodeId).toBe(ROOT);
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
		await drain([
			{
				name: NAMES.updateMarkdown,
				result: { updatedAt: 5_000, stale: true, headMoved: true },
			},
			{
				name: NAMES.commitEdit,
				result: {
					committed: false,
					diverged: true,
					remoteHeadNodeId: REMOTE,
					remotePointerRevision: 5,
				},
			},
		]);

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
		const typedHead = s.history.currentNodeId ?? ROOT;
		const afterTyping: ServerDoc = {
			currentNodeId: typedHead,
			markdown: TYPED,
			updatedAt: 1_500,
			pointerRevision: 2,
			markdownHeadNodeId: typedHead,
		};
		const dagAfterTyping = [
			rootNode(),
			...s.history.nodes.filter((n) => n.nodeId !== ROOT),
		];
		await drain([
			{
				name: NAMES.updateMarkdown,
				result: OK_SAVE,
				snapshot: { server: afterTyping, dag: dagAfterTyping },
			},
			{
				name: NAMES.commitEdit,
				result: {
					committed: true,
					headNodeId: typedHead,
					updatedAt: 1_500,
					pointerRevision: 2,
				},
				snapshot: { server: afterTyping, dag: dagAfterTyping },
			},
		]);

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

		// Answer everything outstanding, or the flush pipeline stays busy and the
		// assertion below would hold for the wrong reason. The commit is refused:
		// another device owns the head, and its node is NOT in this client's DAG
		// yet, so the projection cannot run.
		const savedHead = s.history.currentNodeId ?? ROOT;
		await drain([
			{
				name: NAMES.updateMarkdown,
				result: OK_SAVE,
				snapshot: {
					server: {
						currentNodeId: savedHead,
						markdown: TYPED,
						updatedAt: 1_500,
						pointerRevision: 2,
						markdownHeadNodeId: savedHead,
					},
				},
			},
			{
				name: NAMES.commitEdit,
				result: {
					committed: false,
					diverged: true,
					remoteHeadNodeId: REMOTE,
					remotePointerRevision: 5,
				},
			},
		]);
		await settle(0);

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
			markdownHeadNodeId: LOCAL_NODE,
		});
		// Nothing was ever typed here, so the editor is already idle and the
		// projection lands on this render — before any grouping boundary closes.
		await settle(0);

		expect(s.history.currentNodeId).toBe(LOCAL_NODE);
		// Projecting materialize(LOCAL_NODE) would silently drop the words that
		// exist only in documents.markdown.
		expect(handle.text).toBe(AHEAD_TEXT);

		// And this device must not then save the node's text back over them.
		const overwrote = callsTo(NAMES.updateMarkdown).some(
			(c) => c.args.markdown === LOCAL_TEXT,
		);
		expect(overwrote).toBe(false);

		// The controller sits on the node, so when the draft's boundary closes it
		// becomes an ordinary child of that node rather than a patch against
		// itself — which is how the rescued text finally enters the DAG.
		await settle(600);
		const rescued = callsTo(NAMES.commitEdit).find(
			(c) => c.args.markdown === AHEAD_TEXT,
		);
		expect(rescued?.args.expectedHeadNodeId).toBe(LOCAL_NODE);
		s.unmount();
	});

	it("Y1: never promotes markdown of unknown provenance into the tree", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// A legacy client saved without the compare-and-set, so the server holds
		// text with no stamp. It may belong to a branch this device knows nothing
		// about; the node's own materialization is the only trustworthy value.
		dagRows = [rootNode(), localNode()];
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: "text from a legacy client with no provenance",
			updatedAt: 2_000,
			pointerRevision: 2,
			markdownHeadNodeId: undefined,
		});
		await settle();

		expect(s.history.currentNodeId).toBe(LOCAL_NODE);
		expect(handle.text).toBe(LOCAL_TEXT);
		// Nothing untrusted was turned into a node.
		const promoted = callsTo(NAMES.commitEdit).some(
			(c) => c.args.markdown === "text from a legacy client with no provenance",
		);
		expect(promoted).toBe(false);
		s.unmount();
	});

	it("Y1: distrusts a stamp naming a different head", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		dagRows = [rootNode(), localNode()];
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
			// The stored text belongs to some other branch's head.
			markdownHeadNodeId: REMOTE,
		});
		await settle();

		expect(handle.text).toBe(LOCAL_TEXT);
		s.unmount();
	});

	it("Y2: projects a newer same-head draft instead of treating it as a no-op", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);
		// This device is already sitting on LOCAL_NODE.
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LOCAL_TEXT,
			updatedAt: 1_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle();
		expect(s.history.currentNodeId).toBe(LOCAL_NODE);
		expect(handle.text).toBe(LOCAL_TEXT);

		// The other device keeps typing: markdown and updatedAt move, the pointer
		// does not. The pointer being unchanged used to make this a no-op.
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 4_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle();

		expect(handle.text).toBe(AHEAD_TEXT);
		const overwrote = callsTo(NAMES.updateMarkdown).some(
			(c) => c.args.markdown === LOCAL_TEXT,
		);
		expect(overwrote).toBe(false);
		s.unmount();
	});

	it("Y3: an undo straight after a projection keeps the rescued draft", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LOCAL_TEXT,
			updatedAt: 1_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle();

		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 4_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		// Nothing was typed, so the projection lands immediately; stop well before
		// the 500ms grouping boundary, which is the state Y3 is about.
		await settle(0);
		expect(handle.text).toBe(AHEAD_TEXT);

		// Undo before typing anything. The rescued draft must become a node first,
		// or this navigation would discard it.
		s.run(() => s.history.undo());

		const rescued = callsTo(NAMES.commitEdit).find(
			(c) => c.args.markdown === AHEAD_TEXT,
		);
		expect(rescued?.args.expectedHeadNodeId).toBe(LOCAL_NODE);
		expect(handle.text).toBe(LOCAL_TEXT);
		s.unmount();
	});

	it("Y3: a version tag straight after a projection names the flushed node", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LOCAL_TEXT,
			updatedAt: 1_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle();

		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 4_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		// Tag while the rescued draft is still OPEN — before the grouping boundary
		// would have closed it for us.
		await settle(0);

		await act(async () => {
			void s.history.tagVersion("after projection");
		});

		// Reading the pointer before the flush would tag the pre-draft node.
		const tagged = lastCallTo(getFunctionName(api.versions.create));
		expect(tagged?.args.nodeId).toBe(s.history.currentNodeId);
		expect(tagged?.args.nodeId).not.toBe(LOCAL_NODE);
		s.unmount();
	});

	it("V2: a preview-only pane receives the projection through the published markdown", async () => {
		const preview = fakeHandle();
		preview.readOnly = true; // a preview pane registers no writable handle
		const s = mountStudio(preview);
		dagRows = [rootNode()];
		s.render(AT_ROOT);

		dagRows = [rootNode(), remoteNode()];
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
			markdownHeadNodeId: REMOTE,
		});
		await settle();

		// Y4 used to DEFER here, because seeding a preview handle is a no-op and
		// advancing the pointer would have claimed a projection no surface
		// received. The pane now renders the published projection, so it does
		// reach the writer — deferring would strand a preview pane on stale text
		// for as long as it stayed in preview.
		expect(s.projectedMarkdown).toBe(REMOTE_TEXT);
		expect(s.history.currentNodeId).toBe(REMOTE);
		// Nothing was seeded into the read-only surface.
		expect(preview.seeds).not.toContain(REMOTE_TEXT);

		// And switching to a writable lens must not flush stale text back.
		const staleFlush = callsTo(NAMES.updateMarkdown).some(
			(c) => c.args.markdown === "",
		);
		expect(staleFlush).toBe(false);
		s.unmount();
	});

	it("Z1: first open never shows an unstamped legacy body, and never commits it", async () => {
		const handle = fakeHandle();
		const LEGACY = "body a pre-deploy tab saved under an unknown head";
		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);

		// documents.markdown holds text with no provenance while the head's own
		// materialization is LOCAL_TEXT.
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LEGACY,
			updatedAt: 2_000,
			pointerRevision: 2,
			markdownHeadNodeId: undefined,
		});
		await settle(0);

		// The DAG is the only thing we know to be true — and the legacy body must
		// never reach the editor at all, not even for a frame before a correction.
		expect(handle.text).toBe(LOCAL_TEXT);
		expect(handle.seeds).not.toContain(LEGACY);
		// V2: this is what the panes render, so preview cannot show it either.
		expect(s.projectedMarkdown).toBe(LOCAL_TEXT);

		// And nothing may turn the legacy body into a node under this head.
		s.type(`${LOCAL_TEXT} typed after opening`);
		await settle(600);
		const commits = callsTo(NAMES.commitEdit);
		expect(commits.some((c) => String(c.args.markdown).includes(LEGACY))).toBe(
			false,
		);
		expect(lastCallTo(NAMES.commitEdit)?.args.expectedHeadNodeId).toBe(
			LOCAL_NODE,
		);
		s.unmount();
	});

	it("Z1: first open shows a stamped same-head draft and an undo keeps it", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);

		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle(0);

		expect(handle.text).toBe(AHEAD_TEXT);

		// Undo immediately, before typing anything. The draft must reach the DAG
		// first or this navigation would discard the other device's work.
		s.run(() => s.history.undo());

		const rescued = callsTo(NAMES.commitEdit).find(
			(c) => c.args.markdown === AHEAD_TEXT,
		);
		expect(rescued?.args.expectedHeadNodeId).toBe(LOCAL_NODE);
		expect(handle.text).toBe(LOCAL_TEXT);
		s.unmount();
	});

	it("Z1: first open keeps an AI replacement as a child of the stamped draft", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);

		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 2_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle(0);

		// Accepting an AI transform straight after opening: the draft it replaced
		// has to survive as its own node, or undo lands on the wrong text.
		s.run(() => {
			s.history.commitProgrammatic(AI, { origin: "ai:grammar" });
		});

		const drafts = callsTo(NAMES.commitEdit).map((c) => c.args);
		const rescued = drafts.find((a) => a.markdown === AHEAD_TEXT);
		expect(rescued?.expectedHeadNodeId).toBe(LOCAL_NODE);
		const aiCommit = drafts.find((a) => a.markdown === AI);
		expect(aiCommit?.expectedHeadNodeId).toBe(
			(rescued?.node as { nodeId: string }).nodeId,
		);
		s.unmount();
	});

	it("Z2: a deferred projection is still newer than what the editor shows", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LOCAL_TEXT,
			updatedAt: 1_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle(0);

		// This device is mid-sentence: an OPEN draft, which defers any projection.
		s.type("device A is mid-sentence");

		// Device B saves a stamped draft at the same head. Deferring it advances
		// the compare-and-set token so a later save can still land — and that
		// token used to double as "what the editor shows", so the retry below
		// decided 3000 was not newer than 3000 and projected the node text over
		// B's draft.
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: AHEAD_TEXT,
			updatedAt: 3_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle(0);
		expect(handle.text).toBe("device A is mid-sentence");

		// The draft closes into a node and goes out.
		await settle(600);

		// A's own commit loses the head, so its draft stops blocking and the
		// projection finally runs.
		await drain([
			{
				name: NAMES.commitEdit,
				result: {
					committed: false,
					diverged: true,
					remoteHeadNodeId: LOCAL_NODE,
					remotePointerRevision: 2,
				},
			},
		]);
		await settle();

		expect(handle.text).toBe(AHEAD_TEXT);
		s.unmount();
	});

	it("V1: recovers a draft on a preview-only reload, and does not delete it", async () => {
		const preview = fakeHandle();
		preview.readOnly = true; // the only pane is preview: no editor handle
		const DRAFT = "unsaved words from the session that crashed";
		window.localStorage.setItem(
			`recto:draft:${DOC_ID}`,
			JSON.stringify({ markdown: DRAFT, updatedAt: 9_999, origin: "other" }),
		);

		dagRows = [rootNode(), localNode()];
		const s = mountStudio(preview);
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LOCAL_TEXT,
			updatedAt: 1_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle(0);

		// Recovery used to be gated on an editor handle, so with no pane to seed
		// it never ran; history then read "no local input", took the server text
		// and cleared the draft from storage.
		expect(s.projectedMarkdown).toBe(DRAFT);
		expect(loadDraft(DOC_ID)?.markdown).toBe(DRAFT);
		s.unmount();
	});

	it("V1: treats an intentionally empty recovered draft as a draft", async () => {
		const handle = fakeHandle();
		window.localStorage.setItem(
			`recto:draft:${DOC_ID}`,
			JSON.stringify({ markdown: "", updatedAt: 9_999, origin: "other" }),
		);

		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LOCAL_TEXT,
			updatedAt: 1_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle(0);

		// Deleting everything is a draft the writer meant to keep; reading it as
		// "no draft" silently restored the text they had removed.
		expect(handle.text).toBe("");
		expect(s.projectedMarkdown).toBe("");
		s.unmount();
	});

	it("V3: a recovered draft is unsaved, and is written rather than dropped", async () => {
		const handle = fakeHandle();
		const DRAFT = "recovered but never sent";
		window.localStorage.setItem(
			`recto:draft:${DOC_ID}`,
			JSON.stringify({ markdown: DRAFT, updatedAt: 9_999, origin: "other" }),
		);

		dagRows = [rootNode(), localNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: LOCAL_NODE,
			markdown: LOCAL_TEXT,
			updatedAt: 1_000,
			pointerRevision: 2,
			markdownHeadNodeId: LOCAL_NODE,
		});
		await settle(0);

		// Marked as flushed, it would be cleared from storage and never written:
		// the draft would simply vanish. It must be dirty — in flight or waiting,
		// but never already "saved".
		expect(s.syncStatus).not.toBe("saved");
		await settle();
		const sent = callsTo(NAMES.updateMarkdown).some(
			(c) => c.args.markdown === DRAFT,
		);
		const committed = callsTo(NAMES.commitEdit).some(
			(c) => c.args.markdown === DRAFT,
		);
		expect(sent || committed).toBe(true);
		s.unmount();
	});

	it("V4: an AI commit tags the AI node, not the draft it replaced", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// An open draft the writer typed, then an AI transform accepted on top.
		s.type(TYPED);
		s.run(() => {
			s.history.commitProgrammatic(AI, { origin: "ai:grammar" });
		});

		const commits = callsTo(NAMES.commitEdit).map(
			(c) => c.args.node as { origin: string },
		);
		const typedNode = callsTo(NAMES.commitEdit).find(
			(c) => c.args.markdown === TYPED,
		);
		const aiNode = callsTo(NAMES.commitEdit).find(
			(c) => c.args.markdown === AI,
		);
		expect(commits).toHaveLength(2);
		// Claiming the origin before flushing gave the writer's own text the AI
		// tag and left the AI's node looking like an ordinary device edit.
		expect((typedNode?.args.node as { origin: string }).origin).toBe(
			"test-device",
		);
		expect((aiNode?.args.node as { origin: string }).origin).toBe("ai:grammar");
		s.unmount();
	});

	it("V4: an AI result identical to the current text commits nothing", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// An OPEN draft, then an AI result identical to it. Reading the head
		// before the flush made the flush's own node look like the AI's work.
		s.type(TYPED);
		const before = callsTo(NAMES.commitEdit).length;

		let returned: string | null = "not-null";
		s.run(() => {
			returned = s.history.commitProgrammatic(TYPED, { origin: "ai:grammar" });
		});

		// Reading the head before the flush made an unchanged AI result look like
		// it had committed a node.
		expect(returned).toBeNull();
		// The draft's own node is expected; the AI must not add a second one.
		expect(callsTo(NAMES.commitEdit).length).toBe(before + 1);
		expect(lastCallTo(NAMES.commitEdit)?.args.markdown).toBe(TYPED);
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

	it("replays keystrokes typed before the DAG query resolved", async () => {
		const handle = fakeHandle();
		dagRows = undefined;
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		expect(s.history.currentNodeId).toBeNull();

		s.type(TYPED);

		dagRows = [rootNode()];
		s.render(AT_ROOT);

		// Held as an open draft on the root, so continued typing merges into one
		// node rather than being forced into its own; the boundary closes it.
		expect(handle.text).toBe(TYPED);
		await settle(600);
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
