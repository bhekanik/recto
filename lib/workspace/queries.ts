import type { Id } from "@/convex/_generated/dataModel";
import type {
	PaneLeaf,
	PaneNode,
	PaneSplit,
	PaneTree,
	PerPaneViewStateMap,
} from "./types";

/** Walk all leaves in tree order. */
export function walkLeaves(
	root: PaneTree,
	visit: (leaf: PaneLeaf) => void,
): void {
	if (root.type === "pane") {
		visit(root);
		return;
	}
	for (const child of root.children) {
		walkLeaves(child, visit);
	}
}

/** Collect all leaves in tree order. */
export function collectLeaves(root: PaneTree): PaneLeaf[] {
	const leaves: PaneLeaf[] = [];
	walkLeaves(root, (leaf) => leaves.push(leaf));
	return leaves;
}

/** Whether the tree contains a pane id. */
export function containsPane(root: PaneTree, paneId: string): boolean {
	if (root.type === "pane") return root.paneId === paneId;
	return root.children.some((child) => containsPane(child, paneId));
}

/** Find a leaf by paneId. */
export function findLeaf(root: PaneTree, paneId: string): PaneLeaf | null {
	let found: PaneLeaf | null = null;
	walkLeaves(root, (leaf) => {
		if (leaf.paneId === paneId) found = leaf;
	});
	return found;
}

/** Count leaves in the tree. */
export function countPanes(root: PaneTree): number {
	return collectLeaves(root).length;
}

/** Deduplicated open document ids from all leaves. */
export function openDocumentIdsFromTree(root: PaneTree): Id<"documents">[] {
	const ids = new Set<Id<"documents">>();
	walkLeaves(root, (leaf) => {
		if (leaf.documentId) ids.add(leaf.documentId);
	});
	return [...ids];
}

/** Denormalized paneId → mode + viewState map for persistence. */
export function perPaneViewStateFromTree(root: PaneTree): PerPaneViewStateMap {
	const map: PerPaneViewStateMap = {};
	walkLeaves(root, (leaf) => {
		map[leaf.paneId] = {
			mode: leaf.mode,
			viewState: leaf.viewState,
		};
	});
	return map;
}

/** Stable React key for a pane node. */
export function paneKey(node: PaneNode): string {
	return node.type === "pane" ? node.paneId : node.splitId;
}

/** Next pane in tree order (wrap). */
export function nextPaneId(root: PaneTree, currentId: string): string {
	const leaves = collectLeaves(root);
	if (leaves.length === 0) return currentId;
	const idx = leaves.findIndex((l) => l.paneId === currentId);
	const next = idx < 0 ? 0 : (idx + 1) % leaves.length;
	return leaves[next]?.paneId ?? currentId;
}

/** Previous pane in tree order (wrap). */
export function prevPaneId(root: PaneTree, currentId: string): string {
	const leaves = collectLeaves(root);
	if (leaves.length === 0) return currentId;
	const idx = leaves.findIndex((l) => l.paneId === currentId);
	const prev = idx < 0 ? 0 : (idx - 1 + leaves.length) % leaves.length;
	return leaves[prev]?.paneId ?? currentId;
}

export type SpatialDirection = "left" | "right" | "up" | "down";

/**
 * Nearest pane in a spatial direction, by rendered geometry (blueprint 09 §3.7).
 * Reads `[data-pane-id]` rects from the DOM; returns null if no pane lies that
 * way (callers fall back to tree-order cycling). Browser-only.
 */
export function focusDirectional(
	activePaneId: string,
	dir: SpatialDirection,
): string | null {
	if (typeof document === "undefined") return null;
	const els = Array.from(
		document.querySelectorAll<HTMLElement>("[data-pane-id]"),
	);
	const active = els.find((el) => el.dataset.paneId === activePaneId);
	if (!active) return null;

	const a = active.getBoundingClientRect();
	const ax = a.left + a.width / 2;
	const ay = a.top + a.height / 2;

	let best: { id: string; dist: number } | null = null;
	for (const el of els) {
		const id = el.dataset.paneId;
		if (!id || id === activePaneId) continue;
		const r = el.getBoundingClientRect();
		const dx = r.left + r.width / 2 - ax;
		const dy = r.top + r.height / 2 - ay;
		let inDir = false;
		if (dir === "left") inDir = dx < -1 && Math.abs(dx) >= Math.abs(dy);
		else if (dir === "right") inDir = dx > 1 && Math.abs(dx) >= Math.abs(dy);
		else if (dir === "up") inDir = dy < -1 && Math.abs(dy) >= Math.abs(dx);
		else inDir = dy > 1 && Math.abs(dy) >= Math.abs(dx);
		if (!inDir) continue;
		const dist = dx * dx + dy * dy;
		if (!best || dist < best.dist) best = { id, dist };
	}
	return best?.id ?? null;
}

/** Find parent split of a pane, if any. */
export function findParentSplit(
	root: PaneTree,
	paneId: string,
): { parent: PaneSplit; index: number } | null {
	if (root.type === "pane") return null;

	for (let i = 0; i < root.children.length; i++) {
		const child = root.children[i];
		if (!child) continue;
		if (child.type === "pane" && child.paneId === paneId) {
			return { parent: root, index: i };
		}
		if (child.type === "split") {
			const nested = findParentSplit(child, paneId);
			if (nested) return nested;
		}
	}
	return null;
}
