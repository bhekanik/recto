"use client";

import { useMutation } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { type GroupCommit, GroupingController } from "@/lib/history/grouping";
import {
	childrenByParent,
	type DocNode,
	indexNodes,
	materialize,
} from "@/lib/history/materialize";
import type {
	HistoryController,
	HistoryNode,
} from "@/lib/history/use-document-history";
import { appendArgsFromNode, reviewerNodeFromCommit } from "./reviewer-branch";

/**
 * Reviewer-mode history controller (plan 010 Phase C).
 *
 * The OWNER's `useDocumentHistory` advances `documents.currentNodeId` and writes
 * `documents.markdown`. A REVIEWER must do neither. This controller is the
 * isolation boundary in the client: it seeds the editor ONCE from the owner's
 * current materialized markdown (via `review.getReviewerDocument`, since
 * `documents.get` returns null for a non-owner), then on every edit it appends an
 * immutable node to the reviewer's OWN shadow branch via `review.reviewerAppend`
 * — the only mutation it ever calls. It tracks its branch head + the reviewer's
 * own nodes locally for in-branch undo/redo.
 *
 * It NEVER imports or calls the owner-only document autosave / pointer-advance
 * mutations (the plan's done criteria assert this with a grep over lib/review).
 * The owner's live document is untouched until the owner accepts the branch —
 * that merge happens server-side in `review.acceptBranch`.
 *
 * Exposes the same `HistoryController` shape as `useDocumentHistory` so the
 * workspace can mount it interchangeably, but version-tagging is a no-op (a
 * reviewer tags nothing on the owner's tree).
 */
export function useReviewerHistory(args: {
	documentId: Id<"documents"> | null;
	reviewerUserId: string;
	getEditorHandle: () => EditorHandle | null;
	/** The owner's current materialized markdown (the branch fork point). */
	seedMarkdown: string | undefined;
	/** The owner's currentNodeId at open time — the reviewer branch's base. */
	baseNodeId: string | undefined;
	enabled: boolean;
}): HistoryController {
	const {
		documentId,
		reviewerUserId,
		getEditorHandle,
		seedMarkdown,
		baseNodeId,
		enabled,
	} = args;

	const reviewerAppend = useMutation(api.review.reviewerAppend);

	// The reviewer's OWN branch nodes (base node + each appended node), kept local
	// so the branch is undoable without re-reading the owner's reactive history.
	const [localNodes, setLocalNodes] = useState<HistoryNode[]>([]);
	const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);

	const controllerRef = useRef<GroupingController | null>(null);
	const hydratedRef = useRef(false);
	const getHandleRef = useRef(getEditorHandle);
	getHandleRef.current = getEditorHandle;
	const currentNodeIdRef = useRef<string | null>(null);
	currentNodeIdRef.current = currentNodeId;
	// The reviewer's branch head — what the next appended node parents onto, and
	// what `reviewerAppend` advances `reviewBranches.headNodeId` to.
	const branchHeadRef = useRef<string | null>(null);
	// The server-resolved reviewBranches id, learned from the first append.
	const branchIdRef = useRef<Id<"reviewBranches"> | null>(null);

	// Reset per document rebind.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on document rebind
	useEffect(() => {
		controllerRef.current?.dispose();
		controllerRef.current = null;
		hydratedRef.current = false;
		branchHeadRef.current = null;
		branchIdRef.current = null;
		setLocalNodes([]);
		setCurrentNodeId(null);
	}, [documentId]);

	const nodes = localNodes;
	const nodesById = useMemo(() => indexNodes(nodes), [nodes]);

	const onCommit = useCallback(
		(commit: GroupCommit) => {
			if (!documentId) return;
			const head = branchHeadRef.current;
			if (!head) return;
			const createdAt = Date.now();
			const node = reviewerNodeFromCommit(
				commit,
				head,
				reviewerUserId,
				createdAt,
			);
			const historyNode: HistoryNode = {
				nodeId: node.nodeId,
				parentNodeId: node.parentNodeId,
				patch: node.patch,
				snapshot: node.snapshot,
				selection: node.selection,
				origin: node.origin,
				createdAt,
			};
			setLocalNodes((prev) => [...prev, historyNode]);
			setCurrentNodeId(node.nodeId);
			branchHeadRef.current = node.nodeId;

			// THE ONLY WRITE PATH for a reviewer: append-only, access-gated, never
			// touches the documents row. Learn the branch id back on the first append.
			void reviewerAppend(
				appendArgsFromNode(
					documentId,
					node,
					branchIdRef.current ?? undefined,
				) as Parameters<typeof reviewerAppend>[0],
			)
				.then((res) => {
					if (res?.branchId) branchIdRef.current = res.branchId;
				})
				.catch(() => {
					// Suggestions are additive — never disturb the reviewer's edit path.
				});
		},
		[documentId, reviewerAppend, reviewerUserId],
	);

	// Hydrate the grouping controller once the seed markdown + base node are known.
	useEffect(() => {
		if (!enabled || !documentId) return;
		if (hydratedRef.current) return;
		if (seedMarkdown === undefined || baseNodeId === undefined) return;

		// The base (owner's current) node anchors the branch: it is the grouping
		// controller's root and the first appended node's parent. We record it as a
		// snapshot-bearing local node so in-branch undo can walk back to the seed.
		const baseNode: HistoryNode = {
			nodeId: baseNodeId,
			parentNodeId: null,
			patch: JSON.stringify({ from: 0, to: 0, insert: seedMarkdown }),
			snapshot: seedMarkdown,
			selection: null,
			origin: "review-base",
			createdAt: Date.now(),
		};
		setLocalNodes([baseNode]);
		setCurrentNodeId(baseNodeId);
		branchHeadRef.current = baseNodeId;

		controllerRef.current = new GroupingController({
			rootNodeId: baseNodeId,
			rootMarkdown: seedMarkdown,
			onCommit,
		});
		hydratedRef.current = true;
	}, [enabled, documentId, seedMarkdown, baseNodeId, onCommit]);

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
			// Append-only — never disturb the edit path.
		}
	}, []);

	const flush = useCallback(() => {
		controllerRef.current?.flush();
	}, []);

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

	const navigateTo = useCallback(
		(nodeId: string) => {
			const controller = controllerRef.current;
			const map = nodesById;
			if (!map.has(nodeId)) return;
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
			// Moving the reviewer's local cursor also moves where the NEXT append
			// parents — undo/redo stay within the reviewer's branch.
			branchHeadRef.current = nodeId;
			window.setTimeout(() => {
				navigatingRef.current = false;
			}, 200);
		},
		[nodesById],
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
		const children = childrenByParent(nodes as DocNode[]).get(id);
		if (!children || children.length === 0) return;
		const target = children[children.length - 1];
		if (target) navigateTo(target);
	}, [navigateTo, nodes]);

	const canUndo = useMemo(() => {
		const node = currentNodeId ? nodesById.get(currentNodeId) : null;
		return Boolean(node?.parentNodeId && nodesById.has(node.parentNodeId));
	}, [currentNodeId, nodesById]);

	const canRedo = useMemo(() => {
		if (!currentNodeId) return false;
		const children = childrenByParent(nodes as DocNode[]).get(currentNodeId);
		return Boolean(children && children.length > 0);
	}, [currentNodeId, nodes]);

	// A reviewer never restores/tags/commits-programmatically on the owner's tree.
	const noopRestore = useCallback(() => {}, []);
	const noopTag = useCallback(async () => {}, []);
	const noopCommitProgrammatic = useCallback(() => null, []);

	// A reviewer edits their own shadow branch through review.reviewerAppend, not
	// commitEdit, so there is no head compare-and-set and no remote pointer to
	// reconcile against. Reporting "nothing pending, nothing to project" keeps
	// the sync hook on its own seeding path for this surface.
	const getHeadNodeId = useCallback(() => currentNodeIdRef.current, []);
	const noPendingDraft = useCallback(() => false, []);
	const noRemoteToReconcile = useCallback(() => true, []);

	return {
		nodes,
		currentNodeId,
		canUndo,
		canRedo,
		undo,
		redo,
		navigateTo,
		restoreVersion: noopRestore,
		recordChange,
		commitProgrammatic: noopCommitProgrammatic,
		flush,
		tagVersion: noopTag,
		materializeAt,
		getHeadNodeId,
		hasPendingDraft: noPendingDraft,
		reconcileRemote: noRemoteToReconcile,
	};
}
