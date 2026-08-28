"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { countWords } from "@/lib/markdown";
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
};

const AUTO_VERSION_MS = 120_000; // tag an auto version ~2min after activity settles

/**
 * This client's own most recent pointer move, tracked until the server echoes it
 * back. `appliedAt` is the server `updatedAt` the move was written at, or null
 * while the write is still in flight.
 */
export type LocalPointerMove = { nodeId: string; appliedAt: number | null };

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
	serverUpdatedAt: number;
	localMove: LocalPointerMove | null;
}): PointerDecision {
	const { serverCurrentNodeId, serverUpdatedAt, localMove } = args;
	if (!localMove) return "adopt";
	// The server caught up with us; there is nothing left to reconcile.
	if (serverCurrentNodeId === localMove.nodeId) return "settled";
	// Our move has not reached the server, so everything we see predates it.
	if (localMove.appliedAt === null) return "ignore";
	// The write landed but this query result was produced before it.
	if (serverUpdatedAt <= localMove.appliedAt) return "ignore";
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
	enabled: boolean;
	origin: string;
}): HistoryController {
	const {
		documentId,
		getEditorHandle,
		serverCurrentNodeId,
		serverMarkdown,
		serverUpdatedAt,
		enabled,
		origin,
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
	const currentNodeIdRef = useRef<string | null>(null);
	currentNodeIdRef.current = currentNodeId;
	const ensureRootSentRef = useRef(false);
	const localMoveRef = useRef<LocalPointerMove | null>(null);
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
		pendingRecordRef.current = null;
		setLocalNodes([]);
		setCurrentNodeId(null);
	}, [documentId]);

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
			setCurrentNodeId(commit.nodeId);
			localMoveRef.current = { nodeId: commit.nodeId, appliedAt: null };

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
					if (localMoveRef.current?.nodeId !== commit.nodeId) return;
					if (result.committed) {
						localMoveRef.current.appliedAt = result.updatedAt;
						return;
					}
					// Another writer owns the head. The node is stored either way, so
					// nothing is lost — drop the guard and let the remote pointer win.
					localMoveRef.current = null;
				})
				.catch(() => {
					// The write may never have landed; a stuck guard would deafen this
					// client to every later remote pointer move.
					if (localMoveRef.current?.nodeId === commit.nodeId) {
						localMoveRef.current = null;
					}
				});
			debouncedAutoVersion();
		},
		[commitEdit, debouncedAutoVersion, documentId, origin],
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
		setCurrentNodeId(serverCurrentNodeId);
		hydratedRef.current = true;

		// Replay anything typed before the DAG query resolved, as one node.
		const pending = pendingRecordRef.current;
		pendingRecordRef.current = null;
		if (pending && pending.markdown !== rootMarkdown) {
			controller.record(pending.markdown, pending.selection, {
				structural: true,
			});
		}
	}, [
		enabled,
		documentId,
		dagRows,
		serverCurrentNodeId,
		serverMarkdown,
		ensureRoot,
		onCommit,
	]);

	// Suppress grouping while a navigation re-projects state into the editor, so
	// undo/redo/branch-switch never grow the tree (they are pointer moves).
	const navigatingRef = useRef(false);

	const recordChange = useCallback((opts?: { structural?: boolean }) => {
		if (navigatingRef.current) return;
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
	}, []);

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
			setCurrentNodeId(nodeId);
			// Release the guard after the async re-seed cascade (idle-rehydrate, etc.).
			window.setTimeout(() => {
				navigatingRef.current = false;
			}, 200);
			localMoveRef.current = { nodeId, appliedAt: null };
			void updatePointer({
				documentId,
				currentNodeId: nodeId,
				markdown,
				wordCount: countWords(markdown),
				updatedAt: Date.now(),
			})
				.then((result) => {
					if (localMoveRef.current?.nodeId !== nodeId) return;
					if (result.applied) {
						localMoveRef.current.appliedAt = result.updatedAt;
						return;
					}
					localMoveRef.current = null;
				})
				.catch(() => {
					if (localMoveRef.current?.nodeId === nodeId) {
						localMoveRef.current = null;
					}
					toast("Couldn't sync undo position", "error");
				});
		},
		[documentId, nodesById, updatePointer],
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

	// Adopt a remote pointer move (cross-device LWW) when idle.
	useEffect(() => {
		if (!hydratedRef.current) return;
		if (serverCurrentNodeId === undefined) return;
		if (serverUpdatedAt === undefined) return;
		const decision = decideServerPointer({
			serverCurrentNodeId,
			serverUpdatedAt,
			localMove: localMoveRef.current,
		});
		if (decision === "ignore") return;
		localMoveRef.current = null;
		if (decision === "settled") return;
		if (serverCurrentNodeId === currentNodeIdRef.current) return;
		const handle = getHandleRef.current();
		if (handle?.isFocused()) return; // don't disturb an active writer
		if (!nodesById.has(serverCurrentNodeId)) return;
		controllerRef.current?.setCurrent(
			serverCurrentNodeId,
			materialize(serverCurrentNodeId, nodesById),
		);
		setCurrentNodeId(serverCurrentNodeId);
	}, [serverCurrentNodeId, serverUpdatedAt, nodesById]);

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
	};
}
