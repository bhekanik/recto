import type { Id } from "@/convex/_generated/dataModel";
import type { Mode } from "@/lib/modes/types";

/** Cursor + scroll for a single pane (mode-agnostic offsets). */
export type PaneViewState = {
	selection: { anchor: number; head: number } | null;
	scrollTop: number;
};

/** A leaf: one document shown through one mode. */
export type PaneLeaf = {
	type: "pane";
	paneId: string;
	documentId: Id<"documents"> | null;
	mode: Mode;
	viewState: PaneViewState;
};

/** An internal resizable group node. */
export type PaneSplit = {
	type: "split";
	splitId: string;
	direction: "vertical" | "horizontal";
	children: PaneNode[];
	sizes: number[];
};

export type PaneNode = PaneLeaf | PaneSplit;

/** Root persisted as JSON in workspaces.paneTree. */
export type PaneTree = PaneNode;

export type PerPaneViewStateEntry = {
	mode: Mode;
	viewState: PaneViewState;
};

export type PerPaneViewStateMap = Record<string, PerPaneViewStateEntry>;

export type WorkspaceState = {
	paneTree: PaneTree;
	activePaneId: string;
};

export const MIN_PANE_PERCENT = 10;
export const MAX_OPEN_PANES = 6;

export const DEFAULT_VIEW_STATE: PaneViewState = {
	selection: null,
	scrollTop: 0,
};
