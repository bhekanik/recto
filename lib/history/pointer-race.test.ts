import { getFunctionName } from "convex/server";
import { act, createElement, useCallback, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { loadDraft } from "@/lib/sync/draft-buffer";
import { displaySyncStatus } from "@/lib/sync/sync-indicator";
import type { SyncStatus } from "@/lib/sync/use-document-sync";

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
	reject: (error: unknown) => void;
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
			const { promise, resolve, reject } = Promise.withResolvers<unknown>();
			// Nothing else awaits this promise, so an unobserved rejection would
			// surface as a process warning instead of reaching the hook's catch.
			promise.catch(() => {});
			mutationCalls.push({ name, args, resolve, reject, settled: false });
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
	ensureRoot: getFunctionName(api.docNodes.ensureRoot),
	createVersion: getFunctionName(api.versions.create),
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

/**
 * Accept the commit at the head of the client's outbox. Commits are sent one
 * at a time — a descendant cannot go out until its parent has landed, or it
 * would chain off a node the server never received — so a test that wants a
 * second commit has to answer the first.
 */
async function ackHeadCommit(
	nodeId: string,
	markdown: string,
	updatedAt: number,
	revision: number,
	dag: HistoryNode[],
): Promise<void> {
	// Answer anything the client sent ahead of the commit; Convex delivers one
	// client's results in order, so those come back first.
	while (mutationCalls.find((c) => !c.settled)?.name === NAMES.updateMarkdown) {
		await respond(NAMES.updateMarkdown, {
			updatedAt,
			stale: false,
			headMoved: false,
		});
	}
	await respond(
		NAMES.commitEdit,
		{
			committed: true,
			headNodeId: nodeId,
			updatedAt,
			pointerRevision: revision,
		},
		{
			server: {
				currentNodeId: nodeId,
				markdown,
				updatedAt,
				pointerRevision: revision,
				markdownHeadNodeId: nodeId,
			},
			dag,
		},
	);
}

/**
 * Answer whatever is outstanding, in send order, by function name. For tests
 * whose point is the end state rather than the exact sequence of writes.
 */
/** Answer any autosaves the client sent ahead of the write under test. */
async function settleSavesAhead(updatedAt = 1_500): Promise<void> {
	while (mutationCalls.find((c) => !c.settled)?.name === NAMES.updateMarkdown) {
		await respond(NAMES.updateMarkdown, {
			updatedAt,
			stale: false,
			headMoved: false,
		});
	}
}

/**
 * Fail the oldest unanswered mutation the way the SERVER fails one.
 *
 * A rejected Convex mutation promise is never a lost connection: the client
 * retries offline and internal failures itself until the server confirms, so a
 * rejection means the server ran the function and refused — an application,
 * developer or limit error. Modelling a dropped connection as a rejection is
 * what made the old harness bless a retry loop that can never succeed; a
 * disconnection is modelled by simply LEAVING a call unanswered.
 */
async function refuseNext(
	expectedName: string,
	message = "Server Error: refused",
): Promise<void> {
	const call = mutationCalls.find((c) => !c.settled);
	if (!call) throw new Error(`no unanswered mutation; wanted ${expectedName}`);
	if (call.name !== expectedName) {
		throw new Error(
			`next unanswered mutation is ${call.name}, not ${expectedName}`,
		);
	}
	call.settled = true;
	await act(async () => {
		call.reject(new Error(message));
	});
}

/** Calls the client has sent and not yet had answered. */
function outstanding(): MutationCall[] {
	return mutationCalls.filter((c) => !c.settled);
}

/**
 * Only one history write may be on the wire at a time. Two in flight means the
 * pump was re-entered while the head was pending — which sends the head twice,
 * and `versions.create` is not idempotent.
 */
function expectOneWriteInFlight(): void {
	const live = outstanding().filter((c) => c.name !== NAMES.updateMarkdown);
	expect(live.map((c) => c.name)).toHaveLength(1);
}

async function respondAllRemaining(
	results: Record<string, unknown>,
): Promise<void> {
	let next = mutationCalls.find((c) => !c.settled);
	while (next) {
		const result = results[next.name];
		if (result === undefined) {
			throw new Error(`no result supplied for ${next.name}`);
		}
		await respond(next.name, result);
		next = mutationCalls.find((c) => !c.settled);
	}
}

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
	let syncStatus: SyncStatus = "idle";
	/** What workspace-context would hand the panes to render. */
	let projectedMarkdown: string | null = null;
	/** Every value published, so a test can assert a transition was announced. */
	const projectionLog: string[] = [];
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
			serverCurrentNodeId: server?.currentNodeId,
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
				projectionLog.push(projection.markdown);
				if (projection.source === "server") {
					syncHook.acceptRemoteProjection(
						projection.markdown,
						projection.serverUpdatedAt,
						projection.resolvedProjectionId,
					);
				} else if (projection.source === "recovered-draft") {
					syncHook.adoptRecoveredDraft(projection.markdown, projection.kind);
				} else {
					syncHook.markLocalProjectionPending(
						projection.markdown,
						projection.projectionId ?? crypto.randomUUID(),
						projection.kind ?? "draft",
						projection.pointerNodeId,
					);
				}
			},
			onProjectionSettled: syncHook.settleLocalProjection,
			getPendingProjectionId: syncHook.getPendingProjectionId,
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
		projectionLog,
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
				localMove: {
					token: 1,
					nodeId: "local",
					appliedRevision: null,
					markdown: "x",
					projectionId: "p1",
				},
			}),
		).toBe("ignore");
	});

	it("ignores an observation older than our own write", () => {
		expect(
			decideServerPointer({
				...base,
				serverPointerRevision: 6,
				localMove: {
					token: 1,
					nodeId: "local",
					appliedRevision: 7,
					markdown: "x",
					projectionId: "p1",
				},
			}),
		).toBe("ignore");
	});

	it("adopts an observation newer than our own write", () => {
		expect(
			decideServerPointer({
				...base,
				serverPointerRevision: 8,
				localMove: {
					token: 1,
					nodeId: "local",
					appliedRevision: 7,
					markdown: "x",
					projectionId: "p1",
				},
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
				localMove: {
					token: 1,
					nodeId: "local",
					appliedRevision: 7,
					markdown: "x",
					projectionId: "p1",
				},
			}),
		).toBe("adopt");
	});

	it("settles once the server echoes our own move back", () => {
		expect(
			decideServerPointer({
				...base,
				serverCurrentNodeId: "local",
				localMove: {
					token: 1,
					nodeId: "local",
					appliedRevision: null,
					markdown: "x",
					projectionId: "p1",
				},
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

		// The tag is queued behind the commit that created the node it names — a
		// tag can otherwise reach the server before that node exists.
		await settleSavesAhead();
		const flushedNode = s.history.currentNodeId ?? LOCAL_NODE;
		await ackHeadCommit(flushedNode, AHEAD_TEXT, 5_000, 3, [
			rootNode(),
			localNode(),
			...s.history.nodes.filter(
				(n) => n.nodeId !== ROOT && n.nodeId !== LOCAL_NODE,
			),
		]);

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

		// The rescued draft's own node has to land before its descendant is sent.
		const rescuedHead =
			s.history.nodes.find((n) => n.nodeId !== ROOT && n.nodeId !== LOCAL_NODE)
				?.nodeId ?? LOCAL_NODE;
		await ackHeadCommit(rescuedHead, AHEAD_TEXT, 3_000, 3, [
			rootNode(),
			localNode(),
			...s.history.nodes.filter(
				(n) => n.nodeId !== ROOT && n.nodeId !== LOCAL_NODE,
			),
		]);

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

		// Sequential outbox: the typed node lands, then the AI node goes out.
		const typedHead = s.history.nodes[1]?.nodeId ?? ROOT;
		await ackHeadCommit(typedHead, TYPED, 2_000, 2, [
			rootNode(),
			...s.history.nodes.filter((n) => n.nodeId !== ROOT),
		]);

		const typedNode = callsTo(NAMES.commitEdit).find(
			(c) => c.args.markdown === TYPED,
		);
		const aiNode = callsTo(NAMES.commitEdit).find(
			(c) => c.args.markdown === AI,
		);
		expect(typedNode).toBeDefined();
		expect(aiNode).toBeDefined();
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

	it("U1: publishes every local transition, so a preview pane keeps up", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// A grouped edit.
		s.type(TYPED);
		await settle(600);
		expect(s.projectedMarkdown).toBe(TYPED);

		// An AI commit.
		s.run(() => {
			s.history.commitProgrammatic(AI, { origin: "ai:grammar" });
		});
		expect(s.projectedMarkdown).toBe(AI);

		// Undo, then redo.
		s.run(() => s.history.undo());
		expect(s.projectedMarkdown).toBe(TYPED);
		s.run(() => s.history.redo());
		expect(s.projectedMarkdown).toBe(AI);

		// Every one of those was announced. Before this, they moved the editor
		// handle and the pointer while the published value — what a preview pane
		// of the same document renders — stayed on the previous node.
		expect(s.projectionLog).toEqual(["", TYPED, AI, TYPED, AI]);
		s.unmount();
	});

	it("U1: publishes a branch switch", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.run(() => s.history.navigateTo(REMOTE));

		expect(s.projectedMarkdown).toBe(REMOTE_TEXT);
		expect(handle.text).toBe(REMOTE_TEXT);
		s.unmount();
	});

	it("U4: writes an intentionally empty recovered draft", async () => {
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
		const clearsBefore = removedKeys.length;
		await settle();

		// Nothing is answered, so nothing has been written yet. "" used to equal
		// the initial lastFlushed value, so the no-op fast path declared the draft
		// already saved and DELETED the recovery copy — with no write behind it,
		// the writer's deletion was silently undone on the next open.

		expect(removedKeys.slice(clearsBefore)).toEqual([]);
		expect(s.syncStatus).not.toBe("saved");
		s.unmount();
	});

	it("T1: an AI accept whose commit is rejected stays recoverable", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		await respond(NAMES.updateMarkdown, OK_SAVE, {
			server: {
				currentNodeId: ROOT,
				markdown: TYPED,
				updatedAt: 1_500,
				pointerRevision: 1,
				markdownHeadNodeId: ROOT,
			},
		});

		// Accepting an AI transform seeds programmatically — it never reaches the
		// editor's change handler, so nothing else marks it dirty.
		s.run(() => {
			s.history.commitProgrammatic(AI, { origin: "ai:grammar" });
		});
		expect(handle.text).toBe(AI);

		// Its commit is refused. The text must survive a reload: with sync still
		// reading "saved" and no recovery copy, it would simply be gone.
		await respondAllRemaining({
			[NAMES.commitEdit]: {
				committed: false,
				diverged: true,
				remoteHeadNodeId: REMOTE,
				remotePointerRevision: 9,
			},
			[NAMES.updateMarkdown]: {
				updatedAt: 2_000,
				stale: true,
				headMoved: true,
			},
		});

		expect(s.syncStatus).not.toBe("saved");
		expect(loadDraft(DOC_ID)?.markdown).toBe(AI);
		s.unmount();
	});

	it("T1: an unanswered pointer write is left to Convex, never re-sent", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.run(() => s.history.navigateTo(REMOTE));
		expect(s.projectedMarkdown).toBe(REMOTE_TEXT);

		// A pointer move changes no text, so nothing used to mark it dirty: the
		// pane showed a node the server had never heard of while reporting the
		// document "saved".
		expect(s.syncStatus).toBe("unsynced");

		// Going offline is a PENDING mutation, not a rejected one: the Convex
		// client holds it and retries until the server confirms. Re-sending it
		// ourselves would be a duplicate write, so nothing here may.
		await settle(30_000);
		expect(callsTo(NAMES.updatePointer)).toHaveLength(1);
		expect(s.history.hasPendingWrites).toBe(true);
		expect(s.history.blockedWrite).toBeNull();
		expect(s.syncStatus).not.toBe("saved");

		// Reconnected: the same call finally answers, and the move is done.
		await respond(
			NAMES.updatePointer,
			{
				applied: true,
				currentNodeId: REMOTE,
				updatedAt: 4_000,
				pointerRevision: 2,
			},
			{
				server: {
					currentNodeId: REMOTE,
					markdown: REMOTE_TEXT,
					updatedAt: 4_000,
					pointerRevision: 2,
					markdownHeadNodeId: REMOTE,
				},
			},
		);
		await settle();
		expect(callsTo(NAMES.updatePointer)).toHaveLength(1);
		expect(s.history.hasPendingWrites).toBe(false);
		expect(s.syncStatus).toBe("saved");
		s.unmount();
	});

	it("T3: bounds ensureRoot retries and reports the failure once", async () => {
		const handle = fakeHandle();
		dagRows = []; // a legacy document with no root node
		const s = mountStudio(handle);

		const toasts: string[] = [];
		const onToast = (event: Event) => {
			toasts.push((event as CustomEvent<{ message: string }>).detail.message);
		};
		window.addEventListener("recto:toast", onToast);

		s.render(AT_ROOT);

		// Fail every attempt, allowing plenty of time for any backoff to elapse.
		for (let round = 0; round < 8; round += 1) {
			const outstanding = mutationCalls.find(
				(c) => !c.settled && c.name === NAMES.ensureRoot,
			);
			if (outstanding) await refuseNext(NAMES.ensureRoot);
			await settle(30_000);
		}
		window.removeEventListener("recto:toast", onToast);

		// Unbounded, this re-sent immediately on every failure and raised a toast
		// each time — a hot loop against the server and a wall of notifications.
		const attempts = callsTo(NAMES.ensureRoot).length;
		expect(attempts).toBeGreaterThan(1);
		expect(attempts).toBeLessThanOrEqual(4);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toContain("Reload");
		s.unmount();
	});

	it("T1: an acknowledged pointer move becomes saved", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.run(() => s.history.navigateTo(REMOTE));
		expect(s.syncStatus).toBe("unsynced");

		// A pointer move writes no markdown, so nothing else can report it saved:
		// the acknowledgement of the pointer write is the only signal there is.
		await respond(NAMES.updatePointer, {
			applied: true,
			currentNodeId: REMOTE,
			updatedAt: 4_000,
			pointerRevision: 5,
		});

		expect(s.syncStatus).toBe("saved");
		expect(s.history.currentNodeId).toBe(REMOTE);
		s.unmount();
	});

	it("T1: an acknowledged local commit becomes saved", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		const head = s.history.currentNodeId ?? ROOT;
		const after: ServerDoc = {
			currentNodeId: head,
			markdown: TYPED,
			updatedAt: 2_000,
			pointerRevision: 2,
			markdownHeadNodeId: head,
		};
		await respondAllRemaining({
			[NAMES.updateMarkdown]: OK_SAVE,
			[NAMES.commitEdit]: {
				committed: true,
				headNodeId: head,
				updatedAt: 2_000,
				pointerRevision: 2,
			},
		});
		s.render(after);

		// Pending until the server takes it, saved once it has — not stuck dirty.
		expect(s.syncStatus).toBe("saved");
		expect(loadDraft(DOC_ID)).toBeNull();
		s.unmount();
	});

	it("S4: an ensureRoot failure after unmount schedules nothing", async () => {
		const handle = fakeHandle();
		dagRows = []; // a legacy document with no root node
		const s = mountStudio(handle);

		const toasts: string[] = [];
		const onToast = (event: Event) => {
			toasts.push((event as CustomEvent<{ message: string }>).detail.message);
		};
		window.addEventListener("recto:toast", onToast);

		s.render(AT_ROOT);
		const sent = callsTo(NAMES.ensureRoot).length;
		expect(sent).toBe(1);

		// The pane goes away with the call still outstanding.
		s.unmount();
		const timersAfterUnmount = vi.getTimerCount();
		await refuseNext(NAMES.ensureRoot);

		// A rejection arriving after unmount has no timer to cancel — the cleanup
		// already ran — so without a binding token it SCHEDULES one, against a
		// hook that no longer exists.
		expect(vi.getTimerCount()).toBe(timersAfterUnmount);

		await settle(30_000);
		window.removeEventListener("recto:toast", onToast);
		expect(callsTo(NAMES.ensureRoot).length).toBe(sent);
		expect(toasts).toEqual([]);
	});

	it("S2: a stale host's acknowledgement never clears newer work", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const first = mountStudio(handle);
		first.render(AT_ROOT);

		// Commit A goes out and is never answered.
		first.type(TYPED);
		await settle(600);
		const inFlight = mutationCalls.filter((c) => !c.settled);
		expect(inFlight.length).toBeGreaterThan(0);

		// The document is closed and reopened: a new host, a new draft.
		first.unmount();
		const reopened = fakeHandle();
		const second = mountStudio(reopened);
		second.render(AT_ROOT);
		second.type("B, typed after reopening");
		await settle(600);
		const draftB = loadDraft(DOC_ID)?.markdown;
		expect(draftB).toBe("B, typed after reopening");

		// Now the old host's write finally comes back. Matched on text or on
		// "something is pending", it would clear B — work it has never seen.
		for (const call of inFlight) {
			call.settled = true;
			await act(async () => {
				call.resolve(
					call.name === NAMES.commitEdit
						? {
								committed: true,
								headNodeId: "a",
								updatedAt: 9_000,
								pointerRevision: 9,
							}
						: { updatedAt: 9_000, stale: false, headMoved: false },
				);
			});
		}

		expect(loadDraft(DOC_ID)?.markdown).toBe("B, typed after reopening");
		second.unmount();
	});

	it("S3: a draft typed past a failed pointer move is not projected away", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// Navigate to REMOTE; the pointer write is still in flight.
		s.run(() => s.history.navigateTo(REMOTE));

		// The writer types B on top of it and the grouping boundary closes, so
		// hasPendingDraft goes quiet — but B is still unacknowledged.
		s.type(`${REMOTE_TEXT} and then B`);
		await settle(600);

		// The pointer write fails. The server is still on the root.
		const pointerCall = mutationCalls.find(
			(c) => !c.settled && c.name === NAMES.updatePointer,
		);
		expect(pointerCall).toBeDefined();
		if (pointerCall) {
			pointerCall.settled = true;
			await act(async () => {
				pointerCall.reject(new Error("network"));
			});
		}
		await settle();

		// Reconciliation must not seed the root over B: B exists nowhere else.
		expect(handle.text).toBe(`${REMOTE_TEXT} and then B`);
		expect(loadDraft(DOC_ID)?.markdown).toBe(`${REMOTE_TEXT} and then B`);
		s.unmount();
	});

	it("Q1: an autosave acknowledgement never clears a draft it does not own", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		await settle(0);

		// Flush directly, before any grouping boundary, so the write under test
		// owns the pending id it will later be acknowledged against.
		s.type("A, saved by this host");
		s.run(() => {
			void s.sync.flushMarkdown("A, saved by this host");
		});
		const save = mutationCalls.find(
			(c) => !c.settled && c.name === NAMES.updateMarkdown,
		);
		expect(save).toBeDefined();

		// Another host writes a newer draft into the SHARED record while this
		// write is still out. The stored id is now someone else's work.
		window.localStorage.setItem(
			`recto:draft:${DOC_ID}`,
			JSON.stringify({
				markdown: "B, from another host",
				updatedAt: 9_999,
				origin: "other",
				projectionId: "someone-elses-work",
			}),
		);

		if (save) {
			save.settled = true;
			await act(async () => {
				save.resolve({ updatedAt: 2_000, stale: false, headMoved: false });
			});
		}

		// Matched on this host's in-memory id alone, the acknowledgement deleted
		// a draft it had never seen.
		expect(loadDraft(DOC_ID)?.markdown).toBe("B, from another host");
		s.unmount();
	});

	it("Q2: a projection that resolves a refused move clears its pending state", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.run(() => s.history.navigateTo(REMOTE));
		expect(s.syncStatus).toBe("unsynced");

		// The server refuses the move and keeps the root.
		await respond(NAMES.updatePointer, {
			applied: false,
			currentNodeId: ROOT,
			pointerRevision: 9,
		});
		await settle();

		// Reconciliation projects the head the server kept. That RESOLVES the
		// refused move: the pane used to show the server's head while the document
		// stayed unsynced and storage kept the target it had refused.
		expect(s.history.currentNodeId).toBe(ROOT);
		expect(s.syncStatus).toBe("saved");
		expect(loadDraft(DOC_ID)).toBeNull();
		s.unmount();
	});

	it("Q3: an unanswered commit holds its descendants back", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		const firstAttempt = mutationCalls.filter(
			(c) => c.name === NAMES.commitEdit,
		);
		expect(firstAttempt).toHaveLength(1);
		const clientMutationId = firstAttempt[0]?.args.clientMutationId;
		await settleSavesAhead();

		// The commit is still on the wire. A descendant sent now would chain off
		// a node the server may never have received.
		s.run(() => {
			s.history.commitProgrammatic(AI, { origin: "ai:grammar" });
		});
		await settle(30_000);
		expect(callsTo(NAMES.commitEdit)).toHaveLength(1);
		expectOneWriteInFlight();
		expect(s.history.hasPendingWrites).toBe(true);

		// Once the head lands, the descendant follows — and only then.
		const head = s.history.nodes.find((n) => n.nodeId !== ROOT)?.nodeId ?? ROOT;
		await ackHeadCommit(head, TYPED, 3_000, 2, [
			rootNode(),
			...s.history.nodes.filter((n) => n.nodeId !== ROOT),
		]);
		await settle(0);
		const sent = callsTo(NAMES.commitEdit);
		expect(sent).toHaveLength(2);
		expect(sent[0]?.args.clientMutationId).toBe(clientMutationId);
		// The server rejects a commit whose node does not descend from the head
		// it names, so every attempt must carry the SAME pairing.
		for (const attempt of sent) {
			const node = attempt.args.node as { parentNodeId: string | null };
			expect(attempt.args.expectedHeadNodeId).toBe(node.parentNodeId);
		}
		s.unmount();
	});

	it("Q4: reverting text never retires a pointer move", async () => {
		const handle = fakeHandle();
		// Two nodes carrying identical markdown: the root and a child of it.
		const twin: HistoryNode = {
			nodeId: "01TWINNODEIDENTICALTEXT00",
			parentNodeId: ROOT,
			patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
			snapshot: "",
			selection: null,
			origin: "other-device",
			createdAt: 2,
		};
		dagRows = [rootNode(), twin];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// Navigate to the twin. The text does not change, because both nodes hold
		// the same markdown — but the pointer move is still unacknowledged.
		s.run(() => s.history.navigateTo(twin.nodeId));
		expect(s.syncStatus).toBe("unsynced");

		// A flush now finds the text already matching what the server holds. That
		// proves a text draft was reverted; it proves nothing about the pointer,
		// and retiring it here lost an undo the server never took.
		s.run(() => {
			void s.sync.flushSync();
		});
		await settle(600);
		expect(s.syncStatus).not.toBe("saved");
		s.unmount();
	});

	it("Q6: an unanswered commit is pending, never saved", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		await settleSavesAhead();

		// The commit is outstanding. Nothing may call the document saved while it
		// is: the draft stays recoverable and the queue reports itself occupied.
		await settle(30_000);
		expect(s.history.hasPendingWrites).toBe(true);
		expect(s.history.blockedWrite).toBeNull();
		expect(s.syncStatus).not.toBe("saved");
		expect(loadDraft(DOC_ID)?.markdown).toBe(TYPED);
		s.unmount();
	});

	it("N1: an unanswered commit cannot overtake an undo made after it", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		await settleSavesAhead();

		// The commit is on the wire, unanswered, so it holds the head of the queue.
		const typedNode = s.history.currentNodeId ?? ROOT;

		// The writer undoes. Sent directly, this pointer move would land first and
		// then be reversed when the commit finally arrived.
		s.run(() => s.history.undo());
		expect(s.history.currentNodeId).toBe(ROOT);
		expect(callsTo(NAMES.updatePointer)).toEqual([]);
		await settle(2_000);
		expect(callsTo(NAMES.commitEdit)).toHaveLength(1);
		expectOneWriteInFlight();

		// The commit lands first, as the writer's own order demands...
		await ackHeadCommit(typedNode, TYPED, 3_000, 2, [
			rootNode(),
			...s.history.nodes.filter((n) => n.nodeId !== ROOT),
		]);

		// ...and only then the undo, so the undo is what stands.
		await settle();
		const pointerWrites = callsTo(NAMES.updatePointer);
		expect(pointerWrites.length).toBe(1);
		expect(pointerWrites[0]?.args.currentNodeId).toBe(ROOT);
		expect(s.history.currentNodeId).toBe(ROOT);
		s.unmount();
	});

	it("N1: a queued pointer move is stamped when it is sent", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		await settleSavesAhead();

		const queuedAt = Date.now();
		s.run(() => s.history.navigateTo(REMOTE));

		// Long enough that a timestamp taken at queue time would be stale against
		// writes the server accepted while this one waited.
		await settle(5_000);
		const head = s.history.nodes.find((n) => n.nodeId !== ROOT)?.nodeId ?? ROOT;
		await ackHeadCommit(head, TYPED, 6_000, 2, [
			rootNode(),
			remoteNode(),
			...s.history.nodes.filter((n) => n.nodeId !== ROOT),
		]);
		await settle();

		const move = lastCallTo(NAMES.updatePointer);
		expect(move).toBeDefined();
		expect(move?.args.updatedAt as number).toBeGreaterThan(queuedAt);
		s.unmount();
	});

	it("N2: unmount disposes the grouping controller before its timer fires", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		await settle(0);

		// Typed, with the grouping boundary still open.
		s.type(TYPED);
		const commitsBefore = callsTo(NAMES.commitEdit).length;
		const clearsBefore = removedKeys.length;

		s.unmount();
		const timersAfterUnmount = vi.getTimerCount();
		await settle(30_000);

		// Left armed, the idle timer fired after teardown: it published a recovery
		// id through a host that no longer exists and sent a commit for a document
		// the writer had already closed.
		expect(callsTo(NAMES.commitEdit).length).toBe(commitsBefore);
		expect(vi.getTimerCount()).toBeLessThanOrEqual(timersAfterUnmount);
		expect(removedKeys.slice(clearsBefore)).toEqual([]);
	});

	it("N3: an identical autosaved body never retires a node commit", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		// The autosave stores this text first; the grouping boundary then closes
		// the same text into a node.
		s.type(TYPED);
		await settle(600);
		await respond(NAMES.updateMarkdown, {
			updatedAt: 2_000,
			stale: false,
			headMoved: false,
		});
		await settle(0);

		// A later flush finds the body already matching. That says the DRAFT was
		// saved; it says nothing about whether the node landed.
		s.run(() => {
			void s.sync.flushSync();
		});
		await settle(600);

		expect(s.syncStatus).not.toBe("saved");
		expect(s.history.currentNodeId).not.toBe(ROOT);
		s.unmount();
	});

	it("N4: a pending pointer move survives a reload", async () => {
		const handle = fakeHandle();
		// A node whose text is identical to the root's. Navigating to it changes
		// no body at all, which is the whole difficulty: recovery cannot tell from
		// the text whether the move landed.
		const twin: HistoryNode = {
			nodeId: "01TWINNODEIDENTICALTEXT00",
			parentNodeId: ROOT,
			patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
			snapshot: "",
			selection: null,
			origin: "other-device",
			createdAt: 2,
		};
		dagRows = [rootNode(), twin];
		const first = mountStudio(handle);
		first.render(AT_ROOT);

		// Navigate; the write never lands, so the move is still pending.
		first.run(() => first.history.navigateTo(twin.nodeId));

		const stored = loadDraft(DOC_ID);
		expect(stored?.projectionKind).toBe("pointer");
		expect(stored?.pointerNodeId).toBe(twin.nodeId);
		expect(stored?.markdown).toBe("");
		first.unmount();
		// The page is gone: whatever it had on the wire dies with it, and the
		// reload's writes are the only ones left to answer.
		mutationCalls.length = 0;

		// Reload. The server is still on the root and the stored body is identical
		// to the server's, so judged by text alone recovery deleted the move
		// outright — an undo the server had never accepted, silently dropped.
		const reopened = fakeHandle();
		const second = mountStudio(reopened);
		second.render(AT_ROOT);
		await settle(0);

		expect(loadDraft(DOC_ID)?.pointerNodeId).toBe(twin.nodeId);

		// The recovered move is REPLAYED, at the target the writer left off on,
		// and it is a pointer write that goes out — not a markdown save.
		expect(second.history.currentNodeId).toBe(twin.nodeId);
		const replay = lastCallTo(NAMES.updatePointer);
		expect(replay?.args.currentNodeId).toBe(twin.nodeId);

		// Settling the automatic markdown save is where the loss used to happen:
		// its success retired the recovered POINTER id, deleted the record and
		// reported "Saved" for a move the server had never taken.
		await settleSavesAhead(2_500);
		await settle(600);
		expect(loadDraft(DOC_ID)?.pointerNodeId).toBe(twin.nodeId);
		expect(second.syncStatus).not.toBe("saved");

		// Only the move's own acknowledgement retires it.
		await respond(
			NAMES.updatePointer,
			{
				applied: true,
				currentNodeId: twin.nodeId,
				updatedAt: 3_000,
				pointerRevision: 2,
			},
			{
				server: {
					currentNodeId: twin.nodeId,
					markdown: "",
					updatedAt: 3_000,
					pointerRevision: 2,
					markdownHeadNodeId: twin.nodeId,
				},
			},
		);
		await settle();
		expect(loadDraft(DOC_ID)).toBeNull();
		expect(second.syncStatus).toBe("saved");
		second.unmount();
	});

	it("M1: a second version tag waits for the first to answer", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		await settle(0);
		await settleSavesAhead();

		// Two tags in quick succession. Re-entering the pump on the second one
		// sent the FIRST a second time, and versions.create is not idempotent —
		// the same label was inserted twice.
		s.run(() => {
			void s.history.tagVersion("v1");
			void s.history.tagVersion("v2");
		});
		await settle(0);
		expect(callsTo(NAMES.createVersion)).toHaveLength(1);
		expect(lastCallTo(NAMES.createVersion)?.args.label).toBe("v1");
		expectOneWriteInFlight();

		await respond(NAMES.createVersion, null);
		await settle(0);
		const sent = callsTo(NAMES.createVersion);
		expect(sent).toHaveLength(2);
		expect(sent.map((c) => c.args.label)).toEqual(["v1", "v2"]);
		s.unmount();
	});

	it("M1/M2: a refused commit is sent once and schedules no retry", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		await settleSavesAhead();
		expect(callsTo(NAMES.commitEdit)).toHaveLength(1);

		// The server ran the function and refused it. Convex retries offline and
		// internal failures itself, so this is an application error: the same
		// arguments can never start succeeding, and re-sending them looped for
		// ever with everything behind it stuck.
		const timersBefore = vi.getTimerCount();
		await refuseNext(NAMES.commitEdit, "Server Error: document too large");
		expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore);

		await settle(60_000);
		expect(callsTo(NAMES.commitEdit)).toHaveLength(1);
		expect(s.history.blockedWrite?.kind).toBe("commit");
		expect(s.history.blockedWrite?.message).toContain("too large");
		// Terminal, but never a loss: the text stays on screen, dirty, and in the
		// recovery record.
		expect(handle.text).toBe(TYPED);
		expect(loadDraft(DOC_ID)?.markdown).toBe(TYPED);
		expect(s.syncStatus).not.toBe("saved");
		expect(
			displaySyncStatus({
				status: s.syncStatus,
				hasPendingWrites: s.history.hasPendingWrites,
				blocked: s.history.blockedWrite !== null,
			}),
		).toBe("unresolved");
		s.unmount();
	});

	it("M2: resolving a refused commit keeps the text and re-syncs the head", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		await settleSavesAhead();
		await refuseNext(NAMES.commitEdit, "Server Error: refused");
		expect(s.history.blockedWrite).not.toBeNull();

		// The writer's way out. Their words survive; only the refused transition
		// is given up, and the document goes back onto the head the server has.
		s.run(() => s.history.resolveBlockedWrite());
		expect(s.history.blockedWrite).toBeNull();
		expect(s.history.hasPendingWrites).toBe(false);
		expect(handle.text).toBe(TYPED);
		expect(s.history.currentNodeId).toBe(ROOT);

		// And the text is committable again — as an ordinary child of the head the
		// server actually holds.
		await settle(2_000);
		const retry = lastCallTo(NAMES.commitEdit);
		expect(retry?.args.expectedHeadNodeId).toBe(ROOT);
		expect(retry?.args.markdown).toBe(TYPED);
		s.unmount();
	});

	it("M2: a refused version tag reports itself and releases the writes behind it", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		await settle(0);
		await settleSavesAhead();

		const toasts: string[] = [];
		const onToast = (event: Event) => {
			toasts.push((event as CustomEvent<{ message: string }>).detail.message);
		};
		window.addEventListener("recto:toast", onToast);

		s.run(() => {
			void s.history.tagVersion("v1");
			void s.history.tagVersion("v2");
		});
		await settle(0);
		await refuseNext(NAMES.createVersion, "Server Error: unknown node");
		await settle(0);
		window.removeEventListener("recto:toast", onToast);

		// A label names no text and nothing chains off it, so its refusal is
		// reported and the queue moves on. Holding for it stranded unrelated
		// later writes behind a version name.
		expect(toasts.some((t) => t.includes("version"))).toBe(true);
		expect(s.history.blockedWrite).toBeNull();
		expect(callsTo(NAMES.createVersion)).toHaveLength(2);
		expect(lastCallTo(NAMES.createVersion)?.args.label).toBe("v2");
		s.unmount();
	});

	it("M4: a pointer move compares revisions, not the browser clock", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		// A browser clock far behind the server's own timestamps. Under the old
		// last-write-wins rule this move loses to `doc.updatedAt` immediately.
		vi.setSystemTime(0);
		const AHEAD: ServerDoc = {
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 9_000_000_000_000,
			pointerRevision: 4,
			markdownHeadNodeId: ROOT,
		};
		s.render(AHEAD);
		await settle(0);

		s.run(() => s.history.navigateTo(REMOTE));
		const move = lastCallTo(NAMES.updatePointer);
		expect(Number(move?.args.updatedAt)).toBeLessThan(AHEAD.updatedAt);
		// The revision the client last observed, which is what the server now
		// compares against instead.
		expect(move?.args.expectedPointerRevision).toBe(4);

		await respond(
			NAMES.updatePointer,
			{
				applied: true,
				currentNodeId: REMOTE,
				updatedAt: 9_000_000_001_000,
				pointerRevision: 5,
			},
			{
				server: {
					currentNodeId: REMOTE,
					markdown: REMOTE_TEXT,
					updatedAt: 9_000_000_001_000,
					pointerRevision: 5,
					markdownHeadNodeId: REMOTE,
				},
			},
		);
		await settle();
		expect(s.history.currentNodeId).toBe(REMOTE);
		s.unmount();
	});

	it("M4: an earlier markdown write landing first does not lose the pointer move", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		vi.setSystemTime(0);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 3,
			markdownHeadNodeId: ROOT,
		});
		await settle(0);

		// An autosave is already ahead of the pointer in Convex's ordered queue.
		// It executes first and stamps `doc.updatedAt` with a server clock — which
		// the pointer's own `Date.now()` is then behind.
		s.type(TYPED);
		await settle(600);
		await respond(
			NAMES.updateMarkdown,
			{ updatedAt: 8_000_000_000_000, stale: false, headMoved: false },
			{
				server: {
					currentNodeId: ROOT,
					markdown: TYPED,
					updatedAt: 8_000_000_000_000,
					pointerRevision: 3,
					markdownHeadNodeId: ROOT,
				},
			},
		);
		await settleSavesAhead(8_000_000_000_000);
		// Let the typed node land so the navigation is not queued behind it.
		const typedNode = s.history.currentNodeId ?? ROOT;
		if (typedNode !== ROOT) {
			await ackHeadCommit(typedNode, TYPED, 8_000_000_001_000, 4, [
				rootNode(),
				remoteNode(),
				...s.history.nodes.filter((n) => n.nodeId !== ROOT),
			]);
		}
		await settleSavesAhead(8_000_000_001_000);

		s.run(() => s.history.navigateTo(REMOTE));
		await settle(0);
		const move = lastCallTo(NAMES.updatePointer);
		expect(move).toBeDefined();
		// The markdown write moved `updatedAt` far past this client's clock; the
		// revision it compares against is untouched by it.
		expect(Number(move?.args.updatedAt)).toBeLessThan(8_000_000_000_000);
		expect(move?.args.expectedPointerRevision).toBe(4);
		s.unmount();
	});

	it("M4: a refused compare-and-set reconciles to the head the server returned", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		await settle(0);

		s.run(() => s.history.navigateTo(REMOTE));
		expect(s.history.currentNodeId).toBe(REMOTE);

		// Another device got there first, so our expected revision is stale.
		await respond(NAMES.updatePointer, {
			applied: false,
			currentNodeId: ROOT,
			pointerRevision: 7,
		});
		await settle();

		// The projection path takes us back to the head the server kept, and the
		// refused move is resolved rather than left dirty for ever.
		expect(s.history.currentNodeId).toBe(ROOT);
		expect(s.projectedMarkdown).toBe("");
		expect(s.syncStatus).toBe("saved");
		expect(loadDraft(DOC_ID)).toBeNull();

		// The next move compares against the revision the refusal reported.
		s.run(() => s.history.navigateTo(REMOTE));
		expect(lastCallTo(NAMES.updatePointer)?.args.expectedPointerRevision).toBe(
			7,
		);
		s.unmount();
	});

	it("M5: a queued version tag is never reported as saved", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);
		await settle(0);
		await settleSavesAhead();
		expect(s.syncStatus).toBe("saved");

		// A version creates no pending projection of its own, so the autosave's
		// status kept saying "Saved" while the version was still uncreated.
		s.run(() => {
			void s.history.tagVersion("Chapter one");
		});
		await settle(0);
		expect(s.history.hasPendingWrites).toBe(true);
		expect(
			displaySyncStatus({
				status: s.syncStatus,
				hasPendingWrites: s.history.hasPendingWrites,
				blocked: s.history.blockedWrite !== null,
			}),
		).toBe("unsynced");

		await respond(NAMES.createVersion, null);
		await settle(0);
		expect(s.history.hasPendingWrites).toBe(false);
		expect(
			displaySyncStatus({
				status: s.syncStatus,
				hasPendingWrites: s.history.hasPendingWrites,
				blocked: s.history.blockedWrite !== null,
			}),
		).toBe("saved");
		s.unmount();
	});

	it("M3: a recovered pointer move the server already took is cleared", async () => {
		const handle = fakeHandle();
		const twin: HistoryNode = {
			nodeId: "01TWINNODEIDENTICALTEXT00",
			parentNodeId: ROOT,
			patch: JSON.stringify({ from: 0, to: 0, insert: "" }),
			snapshot: "",
			selection: null,
			origin: "other-device",
			createdAt: 2,
		};
		dagRows = [rootNode(), twin];
		const first = mountStudio(handle);
		first.render(AT_ROOT);
		first.run(() => first.history.navigateTo(twin.nodeId));
		expect(loadDraft(DOC_ID)?.pointerNodeId).toBe(twin.nodeId);
		first.unmount();
		mutationCalls.length = 0;

		// The move DID land; only its answer was lost. Recovery has to judge that
		// against the head the SERVER is on — it used to be handed this device's
		// own head, which is still null while recovery runs, so the check never
		// fired and the move was replayed for ever.
		const second = mountStudio(fakeHandle());
		second.render({
			currentNodeId: twin.nodeId,
			markdown: "",
			updatedAt: 3_000,
			pointerRevision: 2,
			markdownHeadNodeId: twin.nodeId,
		});
		await settle(0);

		expect(loadDraft(DOC_ID)).toBeNull();
		expect(callsTo(NAMES.updatePointer)).toHaveLength(0);
		expect(second.history.currentNodeId).toBe(twin.nodeId);
		second.unmount();
	});

	it("M3: a recovered pointer move whose target never landed keeps its text", async () => {
		const handle = fakeHandle();
		const ghost: HistoryNode = {
			nodeId: "01GHOSTNODENEVERLANDED000",
			parentNodeId: ROOT,
			patch: JSON.stringify({ from: 0, to: 0, insert: TYPED }),
			snapshot: TYPED,
			selection: null,
			origin: "test-device",
			createdAt: 2,
		};
		dagRows = [rootNode(), ghost];
		const first = mountStudio(handle);
		first.render(AT_ROOT);
		first.run(() => first.history.navigateTo(ghost.nodeId));
		expect(loadDraft(DOC_ID)?.pointerNodeId).toBe(ghost.nodeId);
		first.unmount();
		mutationCalls.length = 0;

		// The commit that would have created the target never landed, so on the
		// reload the node is not in the DAG at all and nobody can apply the move.
		// What survives is the TEXT: the record is demoted to a plain draft rather
		// than left claiming a move nothing could ever retire.
		dagRows = [rootNode()];
		const reopened = fakeHandle();
		const second = mountStudio(reopened);
		second.render(AT_ROOT);
		await settle(0);

		expect(reopened.text).toBe(TYPED);
		expect(loadDraft(DOC_ID)?.projectionKind).toBe("draft");
		expect(loadDraft(DOC_ID)?.pointerNodeId).toBeUndefined();
		// No pointer write is invented for a node the server has never heard of.
		expect(callsTo(NAMES.updatePointer)).toHaveLength(0);
		expect(second.history.currentNodeId).toBe(ROOT);

		// And the text is saved as ordinary work rather than sitting unsynced for
		// ever behind a dead move.
		await settle(600);
		expect(lastCallTo(NAMES.commitEdit)?.args.markdown).toBe(TYPED);
		second.unmount();
	});

	it("M3: a markdown save never retires a pointer move stuck behind a refused write", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode()];
		const s = mountStudio(handle);
		s.render(AT_ROOT);

		s.type(TYPED);
		await settle(600);
		await settleSavesAhead();
		// The commit is refused, so the queue is terminal and nothing behind it
		// can be sent — including the pointer move the writer makes next.
		await refuseNext(NAMES.commitEdit, "Server Error: refused");
		s.run(() => s.history.undo());
		expect(s.history.currentNodeId).toBe(ROOT);
		expect(callsTo(NAMES.updatePointer)).toHaveLength(0);
		expect(loadDraft(DOC_ID)?.projectionKind).toBe("pointer");

		// The autosave still runs, and it carries the POINTER work's id because
		// that is what is pending. Its success proves the text reached the server;
		// it proves nothing about the move, and retiring it here deleted the
		// recovery record and reported "Saved" for a move nobody had sent.
		s.run(() => {
			void s.sync.flushSync();
		});
		await settle(0);
		const save = mutationCalls.find(
			(c) => !c.settled && c.name === NAMES.updateMarkdown,
		);
		expect(save).toBeDefined();
		await respond(
			NAMES.updateMarkdown,
			{ updatedAt: 4_000, stale: false, headMoved: false },
			{
				server: {
					currentNodeId: ROOT,
					markdown: "",
					updatedAt: 4_000,
					pointerRevision: 1,
					markdownHeadNodeId: ROOT,
				},
			},
		);
		await settle(600);

		expect(loadDraft(DOC_ID)?.projectionKind).toBe("pointer");
		expect(loadDraft(DOC_ID)?.pointerNodeId).toBe(ROOT);
		expect(s.syncStatus).not.toBe("saved");
		s.unmount();
	});

	it("M4: a move made after another device's compares against their revision", async () => {
		const handle = fakeHandle();
		dagRows = [rootNode(), remoteNode()];
		const s = mountStudio(handle);
		s.render({
			currentNodeId: ROOT,
			markdown: "",
			updatedAt: 1_000,
			pointerRevision: 4,
			markdownHeadNodeId: ROOT,
		});
		await settle(0);

		// The other device moves the head. Nothing of ours is in flight, so this
		// observation is simply adopted.
		s.render({
			currentNodeId: REMOTE,
			markdown: REMOTE_TEXT,
			updatedAt: 2_000,
			pointerRevision: 5,
			markdownHeadNodeId: REMOTE,
		});
		await settle();
		expect(s.history.currentNodeId).toBe(REMOTE);

		// Our next move must compare against what we have SEEN, not against the
		// revision we hydrated on — the server would refuse the stale one, and the
		// writer's undo would vanish for no reason they could observe.
		s.run(() => s.history.navigateTo(ROOT));
		expect(lastCallTo(NAMES.updatePointer)?.args.expectedPointerRevision).toBe(
			5,
		);
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
		// One at a time: the second and third moves wait behind the first.
		expect(callsTo(NAMES.updatePointer).length).toBe(1);
		expect(lastCallTo(NAMES.updatePointer)?.args.currentNodeId).toBe(REMOTE);

		// The FIRST navigate answers, refused, naming ROOT as the winner. Settling
		// by node id would apply that to the third move (same node), queue ROOT,
		// and walk the pointer off the node the writer just chose.
		await respond(NAMES.updatePointer, {
			applied: false,
			currentNodeId: ROOT,
			pointerRevision: 9,
		});
		await settle();

		expect(s.history.currentNodeId).toBe(REMOTE);
		// And the queue carries on in the writer's own order, rather than the
		// refusal of the first move standing in for the third.
		expect(callsTo(NAMES.updatePointer).length).toBe(2);
		expect(lastCallTo(NAMES.updatePointer)?.args.currentNodeId).toBe(ROOT);
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
		const typedNodeId = s.history.currentNodeId ?? ROOT;

		// The AI commit is a descendant, so the typed node has to land first.
		await ackHeadCommit(typedNodeId, TYPED, 2_000, 2, [
			rootNode(),
			...s.history.nodes.filter((n) => n.nodeId !== ROOT),
		]);

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
