"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { countWords } from "@/lib/markdown";
import { caretAtOffset } from "@/lib/modes/caret";
import { toast } from "@/lib/ui/toast";

import {
	type GroupCommit,
	GroupingController,
	type NodeSelection,
} from "./grouping";
import {
	childrenByParent,
	type DocNode,
	indexNodes,
	materialize,
	unionMerge,
} from "./materialize";
import { ulid } from "./ulid";

export type HistoryNode = DocNode & {
	createdAt: number;
	origin?: string;
	selection?: { anchor: number; head: number } | null;
};

export type HistoryController = {
	nodes: HistoryNode[];
	currentNodeId: string | null;
	canUndo: boolean;
	canRedo: boolean;
	undo: () => void;
	redo: () => void;
	navigateTo: (nodeId: string) => void;
	restoreVersion: (versionNodeId: string) => void;
	recordChange: (opts?: { structural?: boolean }) => void;
	/**
	 * Commit a programmatic full-document replacement as a NEW child node, with an
	 * optional origin override (e.g. `"ai:tighten"`). Used by the reversible AI
	 * transform (plan 009): seed the new markdown, record it through the grouping
	 * path so it lands as a child node, and flush immediately. Reversible by
	 * construction — `undo()` returns to the pre-edit text. Returns the new tip
	 * nodeId (or null if no commit happened).
	 */
	commitProgrammatic: (
		markdown: string,
		opts?: { origin?: string },
	) => string | null;
	flush: () => void;
	tagVersion: (label: string, kind?: "auto" | "manual") => Promise<void>;
	materializeAt: (nodeId: string) => string | null;
	/**
	 * The head this device is committing onto, read from a ref that advances
	 * synchronously on commit and navigate. Rendered state lags a synchronous
	 * `flushHistory()` immediately followed by `flushMarkdown()` (mode switch),
	 * which would send the autosave CAS the previous head.
	 */
	getHeadNodeId: () => string | null;
	/** Local input the tree has not captured yet — see GroupingController. */
	hasPendingDraft: () => boolean;
	/**
	 * Project the server's current undo-tree state into the editor, the grouping
	 * controller and the pointer together, if that is safe right now. Returns
	 * false when it was deferred (uncommitted local text, editor still active, or
	 * the node has not synced), in which case the caller must NOT treat the
	 * remote revision as handled — reconciliation is retried automatically.
	 */
	reconcileRemote: () => boolean;
};

const AUTO_VERSION_MS = 120_000; // tag an auto version ~2min after activity settles
/** How long the editor must be quiet before remote state may be projected. */
const EDITOR_IDLE_MS = 2_000;

/**
 * This client's own most recent pointer move, tracked until the server echoes it
 * back. `appliedAt` is the server `updatedAt` the move was written at, or null
 * while the write is still in flight. `token` identifies the individual move:
 * node ids repeat (undo to A, redo to B, undo to A again), so a response must
 * name the attempt it belongs to or the first A can settle the second.
 */
export type LocalPointerMove = {
	token: number;
	nodeId: string;
	/** `documents.pointerRevision` our write produced, or null while in flight. */
	appliedRevision: number | null;
};

/** A remote pointer we have decided to adopt but could not project yet. */
export type QueuedRemotePointer = { nodeId: string; revision: number };

/** What to do with a `documents.currentNodeId` value the client just observed. */
export type PointerDecision = "adopt" | "ignore" | "settled";

/**
 * Tell a genuine cross-device pointer move apart from an echo of state this
 * client has already moved past (plan 022).
 *
 * The bug this exists to prevent: the client advances its pointer locally on
 * every commit, but the server only learns about it when the commit write
 * lands. In that window the reactive `documents` query keeps delivering the
 * PREVIOUS pointer — and, because a separate markdown write can bump
 * `updatedAt` meanwhile, it delivers it looking freshly changed. Adopting it
 * walks the pointer backwards onto an ancestor, and the next undo then lands a
 * whole level too far up (often the empty root).
 */
export function decideServerPointer(args: {
	serverCurrentNodeId: string;
	/** `documents.pointerRevision` of the observation being judged. */
	serverPointerRevision: number;
	localMove: LocalPointerMove | null;
}): PointerDecision {
	const { serverCurrentNodeId, serverPointerRevision, localMove } = args;
	if (!localMove) return "adopt";
	// The server caught up with us; there is nothing left to reconcile.
	if (serverCurrentNodeId === localMove.nodeId) return "settled";
	// Our move has not reached the server, so everything we see predates it.
	if (localMove.appliedRevision === null) return "ignore";
	// Strictly older observations are echoes of the state we moved off. An EQUAL
	// revision naming a different node cannot happen — one revision is one
	// pointer write — so treating it as adoptable is the safe direction: the
	// failure being fixed is ignoring real remote moves, never adopting too eagerly.
	if (serverPointerRevision < localMove.appliedRevision) return "ignore";
	return "adopt";
}

/**
 * The model-level branching undo tree for one open document (blueprint 07). It
 * observes canonical-markdown changes, groups them into immutable docNodes, and
 * navigates the DAG (undo/redo/branch-switch) by re-projecting materialized state
 * into the live editor. Deliberately additive: recordChange is passive and never
 * throws into the edit path.
 */
export function useDocumentHistory(args: {
	documentId: Id<"documents"> | null;
	getEditorHandle: () => EditorHandle | null;
	serverCurrentNodeId: string | undefined;
	serverMarkdown: string | undefined;
	serverUpdatedAt: number | undefined;
	/** `documents.pointerRevision`; orders pointer observations (ADR-19). */
	serverPointerRevision: number | undefined;
	enabled: boolean;
	origin: string;
	/**
	 * Called after remote state has been projected into the editor, so the sync
	 * hook can accept the text as the new baseline instead of flushing it back
	 * as a local edit. Projection is the ONLY thing that clears a dirty draft.
	 */
	onRemoteProjection?: (markdown: string, serverUpdatedAt: number) => void;
}): HistoryController {
	const {
		documentId,
		getEditorHandle,
		serverCurrentNodeId,
		serverMarkdown,
		serverUpdatedAt,
		serverPointerRevision,
		enabled,
		origin,
		onRemoteProjection,
	} = args;

	const dagRows = useQuery(
		api.docNodes.listSince,
		enabled && documentId ? { documentId } : "skip",
	);
	const commitEdit = useMutation(api.documents.commitEdit);
	const ensureRoot = useMutation(api.docNodes.ensureRoot);
	const updatePointer = useMutation(api.documents.updateCurrentNodeId);
	const createVersion = useMutation(api.versions.create);

	const [localNodes, setLocalNodes] = useState<HistoryNode[]>([]);
	const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);

	const controllerRef = useRef<GroupingController | null>(null);
	const hydratedRef = useRef(false);
	const getHandleRef = useRef(getEditorHandle);
	getHandleRef.current = getEditorHandle;
	// Written through setPointer, NOT during render. An effect that runs in the
	// same commit as a pointer change has to see the new value: reading a
	// render-lagged ref made the hook treat its own hydration as a remote move,
	// re-seeding the editor and toasting on every document open.
	const currentNodeIdRef = useRef<string | null>(null);
	const ensureRootSentRef = useRef(false);
	const localMoveRef = useRef<LocalPointerMove | null>(null);
	const moveTokenRef = useRef(0);
	// A remote pointer we have decided to adopt but cannot project yet — the
	// writer is mid-sentence, or the node has not reached this client's DAG.
	// Held until the next safe moment instead of being dropped.
	const pendingRemotePointerRef = useRef<QueuedRemotePointer | null>(null);
	// The head autosave commits against. A ref, not rendered state: a mode switch
	// flushes history and markdown in the same tick, and state would still hold
	// the previous head (R5).
	const headNodeIdRef = useRef<string | null>(null);
	// Whether the editor has settled. Remote state is projected on idle rather
	// than on blur: in vim and full-screen the editor never loses DOM focus, so
	// a focus-gated adoption would never fire at all (R4).
	const editorIdleRef = useRef(true);
	const onRemoteProjectionRef = useRef(onRemoteProjection);
	onRemoteProjectionRef.current = onRemoteProjection;
	// Bumped whenever something happens that could unblock a queued adoption
	// (a local move settles, the editor blurs). The reconciliation lives in an
	// effect, so it needs a state dependency to re-run on.
	const [reconcileTick, setReconcileTick] = useState(0);
	// The latest editor change seen before the controller hydrated. Without this
	// the first keystrokes of a session are dropped: recordChange has nowhere to
	// put them until the DAG query resolves.
	const pendingRecordRef = useRef<{
		markdown: string;
		selection: NodeSelection;
	} | null>(null);

	// Reset per document.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on document rebind
	useEffect(() => {
		controllerRef.current?.dispose();
		controllerRef.current = null;
		hydratedRef.current = false;
		ensureRootSentRef.current = false;
		lastAutoNodeIdRef.current = null;
		localMoveRef.current = null;
		pendingRemotePointerRef.current = null;
		pendingRecordRef.current = null;
		headNodeIdRef.current = null;
		editorIdleRef.current = true;
		setLocalNodes([]);
		currentNodeIdRef.current = null;
		setCurrentNodeId(null);
	}, [documentId]);

	/** Move the pointer, keeping the ref and the rendered state in step. */
	const setPointer = useCallback((nodeId: string | null) => {
		currentNodeIdRef.current = nodeId;
		setCurrentNodeId(nodeId);
	}, []);

	/** Claim the pointer for a move this client is about to write. */
	const startLocalMove = useCallback((nodeId: string): number => {
		moveTokenRef.current += 1;
		localMoveRef.current = {
			token: moveTokenRef.current,
			nodeId,
			appliedRevision: null,
		};
		headNodeIdRef.current = nodeId;
		return moveTokenRef.current;
	}, []);

	/**
	 * Record what became of a pointer move this client started. `appliedAt` is
	 * the server `updatedAt` it was written at, or null when the move never took
	 * — a failed write, or a head another writer owns. Either way the guard has
	 * to go: keeping it would deafen this client to every later remote move.
	 *
	 * The tick is bumped either way. A move that settles to null unblocks a
	 * remote pointer this client was ignoring while the move was in flight, and
	 * nothing else would re-run the reconciliation for it.
	 */
	const settleLocalMove = useCallback(
		(token: number, appliedRevision: number | null) => {
			if (localMoveRef.current?.token !== token) return;
			if (appliedRevision === null) localMoveRef.current = null;
			else localMoveRef.current.appliedRevision = appliedRevision;
			setReconcileTick((tick) => tick + 1);
		},
		[],
	);

	// The editor counts as settled 2s after the last change. Adoption keys off
	// this rather than DOM focus, which never leaves in vim or full-screen.
	const markEditorIdle = useDebouncedCallback(() => {
		editorIdleRef.current = true;
		if (pendingRemotePointerRef.current === null) return;
		setReconcileTick((tick) => tick + 1);
	}, EDITOR_IDLE_MS);

	/** Queue a remote head, keeping the newest observation of it. */
	const queueRemotePointer = useCallback((next: QueuedRemotePointer) => {
		const queued = pendingRemotePointerRef.current;
		if (queued && queued.revision > next.revision) return;
		pendingRemotePointerRef.current = next;
	}, []);

	// Merge the reactive DAG with any optimistically-appended local nodes.
	const nodes = useMemo<HistoryNode[]>(() => {
		const remote = (dagRows ?? []) as HistoryNode[];
		return unionMerge(remote, localNodes) as HistoryNode[];
	}, [dagRows, localNodes]);

	const nodesById = useMemo(() => indexNodes(nodes), [nodes]);

	// Auto-versioning on the idle path (blueprint 08 §4, phase-4 C2): a periodic
	// "auto" tag of the current node, deduped — never a duplicate when nothing
	// changed since the last auto version (G5).
	const lastAutoNodeIdRef = useRef<string | null>(null);
	const debouncedAutoVersion = useDebouncedCallback(() => {
		if (!documentId) return;
		const id = currentNodeIdRef.current;
		if (!id || id === lastAutoNodeIdRef.current) return;
		lastAutoNodeIdRef.current = id;
		void createVersion({
			documentId,
			nodeId: id,
			label: `Autosave ${new Date().toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})}`,
			kind: "auto",
		}).catch(() => {});
	}, AUTO_VERSION_MS);

	// A one-shot origin override consumed by the next commit (AI transforms tag
	// their node `ai:<label>`); cleared after use so normal edits keep the device
	// origin (plan 009).
	const originOverrideRef = useRef<string | null>(null);

	const onCommit = useCallback(
		(commit: GroupCommit) => {
			if (!documentId) return;
			const commitOrigin = originOverrideRef.current ?? origin;
			originOverrideRef.current = null;
			const node: HistoryNode = {
				nodeId: commit.nodeId,
				parentNodeId: commit.parentNodeId,
				patch: commit.patch,
				snapshot: commit.snapshot,
				selection: commit.selection,
				origin: commitOrigin,
				createdAt: Date.now(),
			};
			setLocalNodes((prev) => [...prev, node]);
			setPointer(commit.nodeId);
			const moveToken = startLocalMove(commit.nodeId);

			// One transaction: the node, the pointer, the markdown. See the
			// documents.commitEdit doc comment for why these can't be separate.
			void commitEdit({
				documentId,
				node: {
					nodeId: commit.nodeId,
					parentNodeId: commit.parentNodeId,
					patch: commit.patch,
					snapshot: commit.snapshot,
					selection: commit.selection,
					origin: commitOrigin,
					createdAt: node.createdAt,
				},
				markdown: commit.markdown,
				wordCount: countWords(commit.markdown),
				expectedHeadNodeId: commit.parentNodeId,
				clientMutationId: ulid(),
			})
				.then((result) => {
					if (result.committed) {
						settleLocalMove(moveToken, result.pointerRevision);
						return;
					}
					// Another writer owns the head. Queue theirs so the next safe
					// moment adopts it; the writer is probably still mid-sentence,
					// and re-projecting under their caret is not an option.
					queueRemotePointer({
						nodeId: result.remoteHeadNodeId,
						revision: result.remotePointerRevision,
					});
					headNodeIdRef.current = result.remoteHeadNodeId;
					settleLocalMove(moveToken, null);
				})
				.catch(() => settleLocalMove(moveToken, null));
			debouncedAutoVersion();
		},
		[
			commitEdit,
			debouncedAutoVersion,
			documentId,
			origin,
			queueRemotePointer,
			setPointer,
			settleLocalMove,
			startLocalMove,
		],
	);

	// Hydrate the grouping controller once the DAG + pointer are known.
	useEffect(() => {
		if (!enabled || !documentId) return;
		if (hydratedRef.current) return;
		if (dagRows === undefined || serverCurrentNodeId === undefined) return;

		// Legacy document with no nodes yet — create a root lazily (ADR-17 #1).
		if (dagRows.length === 0) {
			if (!ensureRootSentRef.current) {
				ensureRootSentRef.current = true;
				void ensureRoot({ documentId }).catch(() => {});
			}
			return; // wait for the query to refetch with the root
		}

		const map = indexNodes(dagRows as HistoryNode[]);
		const rootMarkdown = map.has(serverCurrentNodeId)
			? materialize(serverCurrentNodeId, map)
			: (serverMarkdown ?? "");

		const controller = new GroupingController({
			rootNodeId: serverCurrentNodeId,
			rootMarkdown,
			onCommit,
		});
		controllerRef.current = controller;
		setPointer(serverCurrentNodeId);
		headNodeIdRef.current = serverCurrentNodeId;
		hydratedRef.current = true;

		// Replay anything typed before the DAG query resolved, as one node.
		// The buffer only says the writer typed *something*; the value comes from
		// the live editor, because the sync hook may have seeded server markdown
		// over those keystrokes in the meantime (D11). Committing the buffered
		// text there would put a node in the DAG that the editor never showed,
		// and the next recordChange would commit a reverting node on top of it.
		const pending = pendingRecordRef.current;
		pendingRecordRef.current = null;
		if (pending) {
			const typed =
				getHandleRef.current()?.getCanonicalMarkdown() ?? pending.markdown;
			if (typed !== rootMarkdown) {
				controller.record(typed, pending.selection, { structural: true });
			}
		}
	}, [
		enabled,
		documentId,
		dagRows,
		serverCurrentNodeId,
		serverMarkdown,
		ensureRoot,
		onCommit,
		setPointer,
	]);

	// Suppress grouping while a navigation re-projects state into the editor, so
	// undo/redo/branch-switch never grow the tree (they are pointer moves).
	const navigatingRef = useRef(false);

	const recordChange = useCallback(
		(opts?: { structural?: boolean }) => {
			if (navigatingRef.current) return;
			editorIdleRef.current = false;
			markEditorIdle();
			try {
				const handle = getHandleRef.current();
				if (!handle) return;
				const markdown = handle.getCanonicalMarkdown();
				const caret = handle.exportCaret();
				const selection = { anchor: caret.anchor, head: caret.head };
				const controller = controllerRef.current;
				if (!controller) {
					pendingRecordRef.current = { markdown, selection };
					return;
				}
				controller.record(markdown, selection, opts);
			} catch {
				// History is additive — never disturb the edit path.
			}
		},
		[markEditorIdle],
	);

	const flush = useCallback(() => {
		controllerRef.current?.flush();
	}, []);

	const navigateTo = useCallback(
		(nodeId: string) => {
			if (!documentId) return;
			const controller = controllerRef.current;
			const map = nodesById;
			if (!map.has(nodeId)) return;
			// Commit any pending draft so we branch from a real node, not mid-edit.
			controller?.flush();

			let markdown: string;
			try {
				markdown = materialize(nodeId, map);
			} catch {
				return;
			}

			navigatingRef.current = true;
			const handle = getHandleRef.current();
			handle?.seed(markdown, { programmatic: true });
			const node = map.get(nodeId);
			if (node?.selection && handle) {
				handle.importCaret({
					offset: node.selection.head,
					anchor: node.selection.anchor,
					head: node.selection.head,
				});
			}
			controller?.setCurrent(nodeId, markdown);
			setPointer(nodeId);
			// Release the guard after the async re-seed cascade (idle-rehydrate, etc.).
			window.setTimeout(() => {
				navigatingRef.current = false;
			}, 200);
			const moveToken = startLocalMove(nodeId);
			void updatePointer({
				documentId,
				currentNodeId: nodeId,
				markdown,
				wordCount: countWords(markdown),
				updatedAt: Date.now(),
			})
				.then((result) => {
					if (result.applied) {
						// Only now is the queue known to be superseded. Clearing it
						// before the write would drop a remote head this move never
						// managed to overwrite.
						pendingRemotePointerRef.current = null;
						settleLocalMove(moveToken, result.pointerRevision);
						return;
					}
					// Rejected: the server told us which head won — keep it.
					queueRemotePointer({
						nodeId: result.currentNodeId,
						revision: result.pointerRevision,
					});
					headNodeIdRef.current = result.currentNodeId;
					settleLocalMove(moveToken, null);
				})
				.catch(() => {
					settleLocalMove(moveToken, null);
					toast("Couldn't sync undo position", "error");
				});
		},
		[
			documentId,
			nodesById,
			queueRemotePointer,
			setPointer,
			settleLocalMove,
			startLocalMove,
			updatePointer,
		],
	);

	const undo = useCallback(() => {
		const id = currentNodeIdRef.current;
		if (!id) return;
		controllerRef.current?.flush();
		const node = nodesById.get(currentNodeIdRef.current ?? "");
		const parent = node?.parentNodeId;
		if (parent && nodesById.has(parent)) navigateTo(parent);
	}, [navigateTo, nodesById]);

	const redo = useCallback(() => {
		const id = currentNodeIdRef.current;
		if (!id) return;
		const children = childrenByParent(nodes).get(id);
		if (!children || children.length === 0) return;
		// Vim behaviour: the most recently created child by default.
		const target = children[children.length - 1];
		if (target) navigateTo(target);
	}, [navigateTo, nodes]);

	const tagVersion = useCallback(
		async (label: string, kind: "auto" | "manual" = "manual") => {
			if (!documentId) return;
			const id = currentNodeIdRef.current;
			if (!id) return;
			controllerRef.current?.flush();
			await createVersion({ documentId, nodeId: id, label, kind }).catch(() => {
				toast("Couldn't save version — it may not be synced", "error");
			});
		},
		[createVersion, documentId],
	);

	// Additive restore (D9): fork forward — seed the version's materialized state
	// and record it as a NEW node parented at the current tip, via the grouping
	// path, so the live editor re-projects and old history stays reachable.
	const restoreVersion = useCallback(
		(versionNodeId: string) => {
			const controller = controllerRef.current;
			if (!controller || !nodesById.has(versionNodeId)) return;
			let markdown: string;
			try {
				markdown = materialize(versionNodeId, nodesById);
			} catch {
				return;
			}
			controller.flush();
			const handle = getHandleRef.current();
			handle?.seed(markdown, { programmatic: true });
			controller.record(markdown, null, { structural: true });
			controller.flush();
		},
		[nodesById],
	);

	// Commit a programmatic full-document replacement as a child node (plan 009 —
	// the reversible AI transform). Same shape as restoreVersion: flush any draft,
	// seed the new markdown into the live editor, record it as a structural child
	// through the grouping path, then flush immediately. The optional origin
	// override tags the node (e.g. "ai:tighten"). Returns the new tip nodeId.
	const commitProgrammatic = useCallback(
		(markdown: string, opts?: { origin?: string }): string | null => {
			const controller = controllerRef.current;
			if (!controller) return null;
			const before = controller.currentNodeId;
			if (opts?.origin) originOverrideRef.current = opts.origin;
			controller.flush();
			const handle = getHandleRef.current();
			handle?.seed(markdown, { programmatic: true });
			controller.record(markdown, null, { structural: true });
			controller.flush();
			const after = controller.currentNodeId;
			// Clear an unused override if record() found nothing to commit (no change).
			if (after === before) originOverrideRef.current = null;
			return after === before ? null : after;
		},
		[],
	);

	const getHeadNodeId = useCallback(() => headNodeIdRef.current, []);
	const hasPendingDraft = useCallback(
		() => controllerRef.current?.hasPendingDraft ?? false,
		[],
	);

	const materializeAt = useCallback(
		(nodeId: string) => {
			if (!nodesById.has(nodeId)) return null;
			try {
				return materialize(nodeId, nodesById);
			} catch {
				return null;
			}
		},
		[nodesById],
	);

	const canUndo = useMemo(() => {
		const node = currentNodeId ? nodesById.get(currentNodeId) : null;
		return Boolean(node?.parentNodeId && nodesById.has(node.parentNodeId));
	}, [currentNodeId, nodesById]);

	const canRedo = useMemo(() => {
		if (!currentNodeId) return false;
		const children = childrenByParent(nodes).get(currentNodeId);
		return Boolean(children && children.length > 0);
	}, [currentNodeId, nodes]);

	/**
	 * Project the queued remote state into the editor, the grouping controller
	 * and the pointer TOGETHER, or defer. One function so those three can never
	 * disagree: adoption used to move the pointer while leaving the editor
	 * showing the old text, and the sync hook re-seeded on a separate path.
	 *
	 * Returns false when it deferred, which is the caller's signal NOT to mark
	 * the remote revision handled.
	 */
	const reconcileRemote = useCallback((): boolean => {
		const target = pendingRemotePointerRef.current;
		if (target === null) return true; // nothing outstanding
		if (target.nodeId === currentNodeIdRef.current) {
			pendingRemotePointerRef.current = null;
			return true;
		}
		// Never re-project over text the tree has not captured: those keystrokes
		// exist nowhere else yet.
		if (controllerRef.current?.hasPendingDraft) return false;
		// Idle, not unfocused. In vim and full-screen the editor keeps DOM focus
		// forever, so a focus gate would defer this indefinitely.
		if (!editorIdleRef.current) return false;
		if (!nodesById.has(target.nodeId)) return false; // node not synced yet

		let markdown: string;
		try {
			markdown = materialize(target.nodeId, nodesById);
		} catch {
			return false;
		}

		const handle = getHandleRef.current();
		const caretBefore = handle?.exportCaret().head ?? 0;
		navigatingRef.current = true;
		handle?.seed(markdown, { programmatic: true });
		// The remote text is a different document; the old offset may not exist in
		// it, so clamp rather than dropping the caret to the top.
		handle?.importCaret(caretAtOffset(caretBefore, markdown.length));
		controllerRef.current?.setCurrent(target.nodeId, markdown);
		setPointer(target.nodeId);
		headNodeIdRef.current = target.nodeId;
		pendingRemotePointerRef.current = null;
		window.setTimeout(() => {
			navigatingRef.current = false;
		}, 200);

		// The sync hook must accept this as the new baseline, or it will flush the
		// projected text straight back as though the writer had typed it.
		onRemoteProjectionRef.current?.(markdown, serverUpdatedAt ?? 0);
		toast("Updated from another device", "info");
		return true;
	}, [nodesById, serverUpdatedAt, setPointer]);

	// Decide what the latest server observation means, then try to apply it.
	//
	// Deciding to adopt and being able to adopt are separate: uncommitted local
	// text, an active writer, or a node that has not synced all defer the
	// projection. Whatever cannot be applied now is QUEUED rather than dropped —
	// this effect only re-runs on its own dependencies, so a pointer skipped once
	// used to be skipped forever, and with commitEdit's head check that would
	// leave a writer diverging on every commit with no way back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconcileTick is a re-run signal, not a value the body reads — settling a move, idling, or blurring bumps it so a queued pointer is reconsidered
	useEffect(() => {
		if (!hydratedRef.current) return;
		if (serverCurrentNodeId === undefined) return;
		if (serverPointerRevision === undefined) return;

		const decision = decideServerPointer({
			serverCurrentNodeId,
			serverPointerRevision,
			localMove: localMoveRef.current,
		});
		// Our own move is still resolving; it decides the pointer, not the server.
		if (decision === "ignore") return;
		localMoveRef.current = null;
		if (decision === "settled") {
			// The server is on our node, so anything queued has been overtaken.
			pendingRemotePointerRef.current = null;
			return;
		}
		if (serverCurrentNodeId !== currentNodeIdRef.current) {
			queueRemotePointer({
				nodeId: serverCurrentNodeId,
				revision: serverPointerRevision,
			});
		}
		reconcileRemote();
	}, [
		serverCurrentNodeId,
		serverPointerRevision,
		nodesById,
		queueRemotePointer,
		reconcileRemote,
		reconcileTick,
	]);

	// Leaving the editor is an extra chance to reconcile, on top of the idle
	// timer. `focusout` bubbles where `blur` does not, so one window listener
	// covers every lens; the ref check keeps unrelated focus changes free.
	useEffect(() => {
		const onFocusOut = () => {
			if (pendingRemotePointerRef.current === null) return;
			editorIdleRef.current = true;
			setReconcileTick((tick) => tick + 1);
		};
		window.addEventListener("focusout", onFocusOut);
		return () => window.removeEventListener("focusout", onFocusOut);
	}, []);

	return {
		nodes,
		currentNodeId,
		canUndo,
		canRedo,
		undo,
		redo,
		navigateTo,
		restoreVersion,
		recordChange,
		commitProgrammatic,
		flush,
		tagVersion,
		materializeAt,
		getHeadNodeId,
		hasPendingDraft,
		reconcileRemote,
	};
}
