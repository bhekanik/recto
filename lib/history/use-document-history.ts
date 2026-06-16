"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { countWords } from "@/lib/markdown";

import { type GroupCommit, GroupingController } from "./grouping";
import {
	childrenByParent,
	type DocNode,
	indexNodes,
	materialize,
	unionMerge,
} from "./materialize";

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
	flush: () => void;
	tagVersion: (label: string, kind?: "auto" | "manual") => Promise<void>;
	materializeAt: (nodeId: string) => string | null;
};

const POINTER_DEBOUNCE_MS = 1200;
const AUTO_VERSION_MS = 120_000; // tag an auto version ~2min after activity settles

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
	const appendNode = useMutation(api.docNodes.append);
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

	// Reset per document.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on document rebind
	useEffect(() => {
		controllerRef.current?.dispose();
		controllerRef.current = null;
		hydratedRef.current = false;
		ensureRootSentRef.current = false;
		lastAutoNodeIdRef.current = null;
		setLocalNodes([]);
		setCurrentNodeId(null);
	}, [documentId]);

	// Merge the reactive DAG with any optimistically-appended local nodes.
	const nodes = useMemo<HistoryNode[]>(() => {
		const remote = (dagRows ?? []) as HistoryNode[];
		return unionMerge(remote, localNodes) as HistoryNode[];
	}, [dagRows, localNodes]);

	const nodesById = useMemo(() => indexNodes(nodes), [nodes]);

	const debouncedPointer = useDebouncedCallback((nodeId: string) => {
		if (!documentId) return;
		const handle = getHandleRef.current();
		const md = handle?.getCanonicalMarkdown() ?? serverMarkdown ?? "";
		void updatePointer({
			documentId,
			currentNodeId: nodeId,
			markdown: md,
			wordCount: countWords(md),
			updatedAt: Date.now(),
		}).catch(() => {});
	}, POINTER_DEBOUNCE_MS);

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

	const onCommit = useCallback(
		(commit: GroupCommit) => {
			if (!documentId) return;
			const node: HistoryNode = {
				nodeId: commit.nodeId,
				parentNodeId: commit.parentNodeId,
				patch: commit.patch,
				snapshot: commit.snapshot,
				selection: commit.selection,
				origin,
				createdAt: Date.now(),
			};
			setLocalNodes((prev) => [...prev, node]);
			setCurrentNodeId(commit.nodeId);
			void appendNode({
				documentId,
				nodeId: commit.nodeId,
				parentNodeId: commit.parentNodeId,
				patch: commit.patch,
				snapshot: commit.snapshot,
				selection: commit.selection,
				origin,
				createdAt: node.createdAt,
			}).catch(() => {});
			debouncedPointer(commit.nodeId);
			debouncedAutoVersion();
		},
		[appendNode, debouncedPointer, debouncedAutoVersion, documentId, origin],
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

		controllerRef.current = new GroupingController({
			rootNodeId: serverCurrentNodeId,
			rootMarkdown,
			onCommit,
		});
		setCurrentNodeId(serverCurrentNodeId);
		hydratedRef.current = true;
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
		const controller = controllerRef.current;
		if (!controller || navigatingRef.current) return;
		try {
			const handle = getHandleRef.current();
			if (!handle) return;
			const markdown = handle.getCanonicalMarkdown();
			const caret = handle.exportCaret();
			controller.record(
				markdown,
				{ anchor: caret.anchor, head: caret.head },
				opts,
			);
		} catch {
			// History is additive — never disturb the edit path.
		}
	}, []);

	const flush = useCallback(() => {
		controllerRef.current?.flush();
		debouncedPointer.flush();
	}, [debouncedPointer]);

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
			void updatePointer({
				documentId,
				currentNodeId: nodeId,
				markdown,
				wordCount: countWords(markdown),
				updatedAt: Date.now(),
			}).catch(() => {});
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
			await createVersion({ documentId, nodeId: id, label, kind }).catch(
				() => {},
			);
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
		flush,
		tagVersion,
		materializeAt,
	};
}
