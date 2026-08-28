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
/** How often to look for a writable editor while a projection is waiting. */
const HANDLE_RETRY_MS = 250;

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

/**
 * The server's stored markdown, but only when it can be trusted as a draft
 * belonging to `headNodeId` — otherwise null, meaning "show the DAG instead".
 *
 * `documents.markdown` can be ahead of the head (a writer who never paused long
 * enough to close a grouping boundary) which is worth rescuing, or it can be
 * text a pre-deploy client saved with no idea which branch it belonged to,
 * which must never be promoted into this one. `markdownHeadNodeId` is the only
 * thing that tells those apart, so an absent or mismatched stamp is distrusted.
 *
 * Shared by first-open hydration and remote reconciliation so both answer the
 * question the same way.
 */
export function trustedServerDraft(args: {
	headNodeId: string;
	materialized: string;
	serverMarkdown: string | undefined;
	serverMarkdownHeadNodeId: string | undefined;
	/** False when the observation is not newer than what the editor shows. */
	isNewerThanBaseline: boolean;
}): string | null {
	const {
		headNodeId,
		materialized,
		serverMarkdown,
		serverMarkdownHeadNodeId,
		isNewerThanBaseline,
	} = args;
	if (serverMarkdown === undefined) return null;
	if (serverMarkdownHeadNodeId !== headNodeId) return null;
	if (serverMarkdown === materialized) return null;
	if (!isNewerThanBaseline) return null;
	return serverMarkdown;
}

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
	/**
	 * `documents.markdownHeadNodeId` — the head `serverMarkdown` belongs to.
	 * Undefined means unknown provenance (a legacy headless save), and is never
	 * trusted as a draft.
	 */
	serverMarkdownHeadNodeId: string | undefined;
	/**
	 * The server `updatedAt` this device's editor already reflects, from the sync
	 * hook. A "newer draft" must be newer than this or there is nothing to show.
	 */
	getBaselineUpdatedAt?: () => number;
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
		serverMarkdownHeadNodeId,
		getBaselineUpdatedAt,
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
	// The same map, but advanced synchronously by onCommit. A flush inside undo /
	// navigateTo / tagVersion creates a node those callers must then look up, and
	// the memo above only catches up on the next render.
	const nodesByIdRef = useRef(nodesById);
	nodesByIdRef.current = nodesById;

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
			nodesByIdRef.current = new Map(nodesByIdRef.current).set(
				node.nodeId,
				node,
			);
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

		// First open goes through the SAME provenance rule as a remote update.
		// The sync hook cannot apply it — it has no DAG — so it leaves the editor
		// alone for us, and everything the writer ends up looking at is decided
		// here, once, with the tree in hand.
		const handle = getHandleRef.current();
		const editorText = handle?.getCanonicalMarkdown() ?? "";

		// Local input outranks anything from the server: keystrokes that landed
		// before the DAG resolved, or a draft recovered from localStorage (which
		// the sync hook does seed, because it is this writer's own unsaved work).
		const pending = pendingRecordRef.current;
		pendingRecordRef.current = null;
		const localInput =
			pending?.markdown ??
			(editorText !== "" &&
			editorText !== rootMarkdown &&
			editorText !== serverMarkdown
				? editorText
				: null);

		// Opening is the first thing this device has seen, so there is no earlier
		// baseline for the server to be newer than.
		const serverDraft = trustedServerDraft({
			headNodeId: serverCurrentNodeId,
			materialized: rootMarkdown,
			serverMarkdown,
			serverMarkdownHeadNodeId,
			isNewerThanBaseline: true,
		});

		const shown = localInput ?? serverDraft ?? rootMarkdown;
		if (editorText !== shown) handle?.seed(shown, { programmatic: true });
		if (shown !== rootMarkdown) {
			// An OPEN draft on the node, not silent editor text: undo, a version
			// tag or an AI replacement all flush first, so this text becomes a real
			// child node instead of being dropped by the navigation.
			controller.record(shown, pending?.selection ?? null);
		}
		if (localInput === null) {
			// Server-derived text — tell the sync hook this is the baseline, or it
			// will push it back up as though the writer had typed it. Local input
			// stays dirty and is deliberately NOT reported as saved.
			onRemoteProjectionRef.current?.(shown, serverUpdatedAt ?? 0);
		}
	}, [
		enabled,
		documentId,
		dagRows,
		serverCurrentNodeId,
		serverMarkdown,
		serverMarkdownHeadNodeId,
		serverUpdatedAt,
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
		if (!currentNodeIdRef.current) return;
		// Flush FIRST: an open draft (typed text, or a draft rescued from another
		// device) becomes a node here, and that node is what we undo from. Reading
		// the pointer before the flush would step back one level too far.
		controllerRef.current?.flush();
		const map = nodesByIdRef.current;
		const node = map.get(currentNodeIdRef.current ?? "");
		const parent = node?.parentNodeId;
		if (parent && map.has(parent)) navigateTo(parent);
	}, [navigateTo]);

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
			controllerRef.current?.flush();
			// Re-read after the flush: it may have just turned an open draft into
			// the node the writer actually means to tag.
			const id = currentNodeIdRef.current;
			if (!id) return;
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

	/**
	 * The head autosave may write against — null while a remote head is queued.
	 *
	 * Adopting the winner's head here would be worse than useless: this device's
	 * editor still holds ITS text, so passing the compare-and-set would write that
	 * text under the winner's branch, which is exactly what the CAS exists to
	 * stop. The head stays tied to what the editor and controller actually hold,
	 * and only `reconcileRemote` moves it — after the projection that makes it
	 * true.
	 */
	const getHeadNodeId = useCallback(
		() => (pendingRemotePointerRef.current ? null : headNodeIdRef.current),
		[],
	);
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

		const map = nodesByIdRef.current;
		if (!map.has(target.nodeId)) return false; // node not synced yet

		let materialized: string;
		try {
			materialized = materialize(target.nodeId, map);
		} catch {
			return false;
		}

		// The other device's autosave can be AHEAD of its last node: a writer who
		// never pauses long enough to close a grouping boundary has their text in
		// documents.markdown and nowhere else. Projecting the node's text would
		// erase it, and accepting that as the sync baseline would then overwrite
		// it on this device's next save.
		//
		// Trusting it needs PROVENANCE, though. `markdownHeadNodeId` is the head
		// the stored markdown was written against; when it is absent (a legacy
		// client saving without the compare-and-set) or names a different head,
		// that text may belong to another branch entirely and must never be
		// promoted into this one. Then the node's own materialization is the only
		// thing we know to be true.
		const draft = trustedServerDraft({
			headNodeId: target.nodeId,
			materialized,
			serverMarkdown,
			serverMarkdownHeadNodeId,
			isNewerThanBaseline:
				(serverUpdatedAt ?? 0) > (getBaselineUpdatedAt?.() ?? 0),
		});
		const trustedDraft = draft !== null;
		const editorText = draft ?? materialized;

		const alreadyThere = target.nodeId === currentNodeIdRef.current;
		// The pointer has not moved and there is no newer trusted draft to show:
		// the observation is already reflected here.
		if (alreadyThere && !trustedDraft) {
			pendingRemotePointerRef.current = null;
			return true;
		}

		// Never re-project over text the tree has not captured: those keystrokes
		// exist nowhere else yet.
		if (controllerRef.current?.hasPendingDraft) return false;
		// Idle, not unfocused. In vim and full-screen the editor keeps DOM focus
		// forever, so a focus gate would defer this indefinitely.
		if (!editorIdleRef.current) return false;

		// A preview-only pane has a handle whose seed is a no-op. Advancing the
		// pointer against it would leave the tree claiming a projection that never
		// reached any editor; wait for a writable lens instead.
		const handle = getHandleRef.current();
		if (!handle || handle.readOnly) return false;

		const caretBefore = handle.exportCaret().head;
		navigatingRef.current = true;
		handle.seed(editorText, { programmatic: true });
		// The remote text is a different document; the old offset may not exist in
		// it, so clamp rather than dropping the caret to the top.
		handle.importCaret(caretAtOffset(caretBefore, editorText.length));
		controllerRef.current?.setCurrent(target.nodeId, materialized);
		if (trustedDraft) {
			// Hold the rescued draft as an OPEN draft on the node, not as silent
			// editor text. Every path that leaves this state — undo, branch switch,
			// version tag, mode switch — flushes first, so the draft becomes a real
			// child node instead of being discarded by the navigation.
			controllerRef.current?.record(editorText, null);
		}
		setPointer(target.nodeId);
		headNodeIdRef.current = target.nodeId;
		pendingRemotePointerRef.current = null;
		window.setTimeout(() => {
			navigatingRef.current = false;
		}, 200);

		// The sync hook must accept what is ON SCREEN as the new baseline, or it
		// will flush the projected text back as though the writer had typed it —
		// and if that text were the materialization, the flush would clobber the
		// draft this projection just rescued.
		onRemoteProjectionRef.current?.(editorText, serverUpdatedAt ?? 0);
		toast("Updated from another device", "info");
		return true;
	}, [
		getBaselineUpdatedAt,
		serverMarkdown,
		serverMarkdownHeadNodeId,
		serverUpdatedAt,
		setPointer,
	]);

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
		// Queue EVERY observation, including one naming the head we are already on:
		// a newer revision pointing back at our own head is how a queued pointer
		// that has since been superseded gets cleared. Filtering those out left
		// stale targets in the queue waiting to be projected.
		queueRemotePointer({
			nodeId: serverCurrentNodeId,
			revision: serverPointerRevision,
		});
		reconcileRemote();
	}, [
		serverCurrentNodeId,
		serverPointerRevision,
		nodesById,
		queueRemotePointer,
		reconcileRemote,
		reconcileTick,
	]);

	// A projection deferred for want of a writable editor (preview-only pane) has
	// nothing else to wake it: no query changes, no keystroke, no blur. Poll while
	// something is queued, and stop as soon as it lands.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconcileTick re-arms the poll after each attempt
	useEffect(() => {
		if (pendingRemotePointerRef.current === null) return;
		const timer = window.setInterval(() => {
			if (pendingRemotePointerRef.current === null) return;
			const handle = getHandleRef.current();
			if (!handle || handle.readOnly) return;
			setReconcileTick((tick) => tick + 1);
		}, HANDLE_RETRY_MS);
		return () => window.clearInterval(timer);
	}, [reconcileTick, serverCurrentNodeId, serverPointerRevision]);

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
