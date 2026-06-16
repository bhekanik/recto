import type { PaneLeaf, WorkspaceState } from "./types";
import { DEFAULT_VIEW_STATE } from "./types";

/** Create a new empty pane leaf. */
export function createEmptyPane(): PaneLeaf {
	return {
		type: "pane",
		paneId: crypto.randomUUID(),
		documentId: null,
		mode: "rich",
		viewState: { ...DEFAULT_VIEW_STATE },
	};
}

/** Default workspace for a brand-new user: one empty pane. */
export function createDefaultWorkspace(): WorkspaceState {
	const pane = createEmptyPane();
	return {
		paneTree: pane,
		activePaneId: pane.paneId,
	};
}

/** Clone a pane leaf inheriting document binding from a source pane. */
export function clonePaneForSplit(source: PaneLeaf): PaneLeaf {
	return {
		type: "pane",
		paneId: crypto.randomUUID(),
		documentId: source.documentId,
		mode: source.mode,
		viewState: { ...DEFAULT_VIEW_STATE },
	};
}
