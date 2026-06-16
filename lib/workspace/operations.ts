import type { Id } from "@/convex/_generated/dataModel";
import type { Mode } from "@/lib/modes/types";
import { clonePaneForSplit, createEmptyPane } from "./defaults";
import {
	collectLeaves,
	containsPane,
	countPanes,
	findLeaf,
	findParentSplit,
	nextPaneId,
	openDocumentIdsFromTree,
	perPaneViewStateFromTree,
} from "./queries";
import type {
	PaneLeaf,
	PaneNode,
	PaneSplit,
	PaneTree,
	PaneViewState,
} from "./types";
import { DEFAULT_VIEW_STATE, MAX_OPEN_PANES } from "./types";

/** Renormalize size percentages to sum to 100. */
export function renormalizeSizes(sizes: number[]): number[] {
	const sum = sizes.reduce((acc, value) => acc + value, 0);
	if (sum <= 0) {
		return sizes.map(() => 100 / sizes.length);
	}
	return sizes.map((value) => (value / sum) * 100);
}

function createSplit(
	direction: PaneSplit["direction"],
	children: PaneNode[],
	sizes?: number[],
): PaneSplit {
	const defaultSizes =
		sizes ?? children.map(() => 100 / Math.max(children.length, 1));
	return {
		type: "split",
		splitId: crypto.randomUUID(),
		direction,
		children,
		sizes: renormalizeSizes(defaultSizes),
	};
}

function mapTree(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
	if (node.type === "pane") return fn(node);
	return {
		...node,
		children: node.children.map((child) => mapTree(child, fn)),
	};
}

function updateLeaf(
	tree: PaneTree,
	paneId: string,
	updater: (leaf: PaneLeaf) => PaneLeaf,
): PaneTree {
	return mapTree(tree, (leaf) =>
		leaf.paneId === paneId ? updater(leaf) : leaf,
	) as PaneTree;
}

/** Replace a subtree matched by predicate. */
function replaceSubtree(
	node: PaneNode,
	predicate: (node: PaneNode) => boolean,
	replacement: PaneNode,
): PaneNode {
	if (predicate(node)) return replacement;
	if (node.type === "pane") return node;
	return {
		...node,
		children: node.children.map((child) =>
			replaceSubtree(child, predicate, replacement),
		),
	};
}

function collapseSplit(split: PaneSplit): PaneNode {
	let node: PaneNode = split;
	while (node.type === "split" && node.children.length === 1) {
		const onlyChild: PaneNode | undefined = node.children[0];
		if (!onlyChild) break;
		node = onlyChild;
	}
	return node;
}

export type SplitPaneResult = {
	tree: PaneTree;
	newPaneId: string;
};

/**
 * Split the target pane vertically or horizontally.
 * Same-direction splits flatten into the parent group when possible.
 */
export function splitPane(
	tree: PaneTree,
	paneId: string,
	direction: PaneSplit["direction"],
	newLeaf?: PaneLeaf,
): SplitPaneResult | null {
	if (!containsPane(tree, paneId)) return null;
	if (countPanes(tree) >= MAX_OPEN_PANES) return null;

	const parentInfo = findParentSplit(tree, paneId);
	const target = findLeaf(tree, paneId);
	if (!target) return null;

	const inserted = newLeaf ?? clonePaneForSplit(target);

	if (parentInfo && parentInfo.parent.direction === direction) {
		const { parent, index } = parentInfo;
		const newSizes = [...parent.sizes];
		const removedSize = newSizes[index] ?? 50;
		newSizes.splice(index + 1, 0, removedSize / 2);
		newSizes[index] = removedSize / 2;

		const newChildren = [...parent.children];
		newChildren.splice(index + 1, 0, inserted);

		const updatedParent: PaneSplit = {
			...parent,
			children: newChildren,
			sizes: renormalizeSizes(newSizes),
		};

		const newTree = replaceSubtree(
			tree,
			(n) => n.type === "split" && n.splitId === parent.splitId,
			updatedParent,
		) as PaneTree;

		return { tree: newTree, newPaneId: inserted.paneId };
	}

	const replacement = createSplit(direction, [target, inserted], [50, 50]);
	const newTree = replaceSubtree(
		tree,
		(n) => n.type === "pane" && n.paneId === paneId,
		replacement,
	) as PaneTree;

	return { tree: newTree, newPaneId: inserted.paneId };
}

export type ClosePaneResult = {
	tree: PaneTree;
	activePaneId: string;
};

/** Remove a pane; collapse splits; never yield an empty tree. */
export function closePane(
	tree: PaneTree,
	paneId: string,
	activePaneId: string,
): ClosePaneResult {
	const leaves = collectLeaves(tree);
	if (leaves.length <= 1) {
		const empty = createEmptyPane();
		return { tree: empty, activePaneId: empty.paneId };
	}

	const parentInfo = findParentSplit(tree, paneId);
	if (!parentInfo) {
		const empty = createEmptyPane();
		return { tree: empty, activePaneId: empty.paneId };
	}

	const { parent, index } = parentInfo;
	const newChildren = parent.children.filter((_, i) => i !== index);
	const newSizes = parent.sizes.filter((_, i) => i !== index);

	let replacement: PaneNode;
	if (newChildren.length === 1) {
		replacement = collapseSplit({
			...parent,
			children: newChildren,
			sizes: renormalizeSizes(newSizes),
		});
	} else {
		replacement = {
			...parent,
			children: newChildren,
			sizes: renormalizeSizes(newSizes),
		};
	}

	let newTree = replaceSubtree(
		tree,
		(n) => n.type === "split" && n.splitId === parent.splitId,
		replacement,
	) as PaneTree;

	if (newTree.type === "split") {
		newTree = collapseSplit(newTree) as PaneTree;
	}

	const nextActive =
		activePaneId === paneId ? nextPaneId(newTree, paneId) : activePaneId;

	return { tree: newTree, activePaneId: nextActive };
}

/** Rebind a leaf's document; reset viewState. */
export function setPaneDocument(
	tree: PaneTree,
	paneId: string,
	documentId: Id<"documents"> | null,
): PaneTree {
	return updateLeaf(tree, paneId, (leaf) => ({
		...leaf,
		documentId,
		viewState: { ...DEFAULT_VIEW_STATE },
	}));
}

/** Record a leaf's mode. */
export function setPaneMode(
	tree: PaneTree,
	paneId: string,
	mode: Mode,
): PaneTree {
	return updateLeaf(tree, paneId, (leaf) => ({ ...leaf, mode }));
}

/** Update a leaf's cursor/scroll. */
export function setPaneViewState(
	tree: PaneTree,
	paneId: string,
	viewState: PaneViewState,
): PaneTree {
	return updateLeaf(tree, paneId, (leaf) => ({ ...leaf, viewState }));
}

/** Update sizes on a split node from react-resizable-panels onLayout. */
export function updateSplitSizes(
	tree: PaneTree,
	splitId: string,
	sizes: number[],
): PaneTree {
	if (tree.type === "split" && tree.splitId === splitId) {
		return { ...tree, sizes: renormalizeSizes(sizes) };
	}
	if (tree.type === "pane") return tree;
	return {
		...tree,
		children: tree.children.map((child) =>
			updateSplitSizes(child as PaneTree, splitId, sizes),
		),
	};
}

/** Reconcile panes bound to a deleted document. */
export function reconcileDeletedDocument(
	tree: PaneTree,
	deletedId: Id<"documents">,
	fallbackDocumentId?: Id<"documents"> | null,
): PaneTree {
	return mapTree(tree, (leaf) => {
		if (leaf.documentId !== deletedId) return leaf;
		return {
			...leaf,
			documentId: fallbackDocumentId ?? null,
			viewState: { ...DEFAULT_VIEW_STATE },
		};
	}) as PaneTree;
}

/** Drop dangling document references on restore. */
export function reconcileDanglingDocs(
	tree: PaneTree,
	validDocIds: Set<string>,
): PaneTree {
	return mapTree(tree, (leaf) => {
		if (!leaf.documentId || validDocIds.has(leaf.documentId)) return leaf;
		return {
			...leaf,
			documentId: null,
			viewState: { ...DEFAULT_VIEW_STATE },
		};
	}) as PaneTree;
}

/** Parse persisted paneTree JSON safely. */
export function parsePaneTree(json: string): PaneTree | null {
	try {
		const parsed = JSON.parse(json) as PaneTree;
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.type !== "pane" && parsed.type !== "split") return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Merge perPaneViewState into tree leaves; paneTree wins for structure. */
export function mergeViewStateFromMap(
	tree: PaneTree,
	map: Record<string, { mode: Mode; viewState: PaneViewState }>,
): PaneTree {
	return mapTree(tree, (leaf) => {
		const entry = map[leaf.paneId];
		if (!entry) return leaf;
		return {
			...leaf,
			mode: entry.mode,
			viewState: entry.viewState,
		};
	}) as PaneTree;
}

/** Serialize workspace for Convex save. */
export function serializeWorkspace(tree: PaneTree): {
	paneTree: string;
	openDocumentIds: Id<"documents">[];
	perPaneViewState: string;
} {
	return {
		paneTree: JSON.stringify(tree),
		openDocumentIds: openDocumentIdsFromTree(tree),
		perPaneViewState: JSON.stringify(perPaneViewStateFromTree(tree)),
	};
}
