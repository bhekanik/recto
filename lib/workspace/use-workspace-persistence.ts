"use client";

import { useMutation, useQuery } from "convex/react";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useDebouncedCallback } from "use-debounce";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { FOCUS_PANE_EVENT } from "@/lib/events";
import type { Mode } from "@/lib/modes/types";
import { createDefaultWorkspace } from "./defaults";
import { getDeviceId, WEB_DEVICE_CLASS } from "./device";
import {
	closePane,
	mergeViewStateFromMap,
	parsePaneTree,
	reconcileDanglingDocs,
	type SplitPaneResult,
	serializeWorkspace,
	setPaneDocument,
	setPaneMode,
	setPaneViewState,
	splitPane,
	updateSplitSizes,
} from "./operations";
import {
	collectLeaves,
	findLeaf,
	focusDirectional,
	nextPaneId,
	prevPaneId,
	type SpatialDirection,
} from "./queries";
import type { PaneTree, PaneViewState, WorkspaceState } from "./types";

/** Move keyboard focus into a pane's editor after a layout-driven focus change. */
function emitFocusPane(paneId: string): void {
	if (typeof window === "undefined") return;
	requestAnimationFrame(() => {
		window.dispatchEvent(
			new CustomEvent(FOCUS_PANE_EVENT, { detail: { paneId } }),
		);
	});
}

export const WORKSPACE_DEBOUNCE_MS = 500;
export const VIEW_STATE_DEBOUNCE_MS = 2000;

type UseWorkspacePersistenceArgs = {
	enabled: boolean;
	validDocumentIds: Set<string>;
};

/** The stored layout, whichever row it came from. */
type StoredLayout = {
	paneTree: string;
	activePaneId: string;
	perPaneViewState: string;
};

/**
 * Parse a device row's `json` blob; null when it is unusable. The server stores
 * it opaquely, so this is an untrusted string: narrowed from `unknown` rather
 * than cast, and a bad blob costs the layout, not the session.
 */
function parseStoredLayout(json: string): StoredLayout | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { paneTree, activePaneId, perPaneViewState } = parsed as Record<
		keyof StoredLayout,
		unknown
	>;
	if (
		typeof paneTree !== "string" ||
		typeof activePaneId !== "string" ||
		typeof perPaneViewState !== "string"
	) {
		return null;
	}
	return { paneTree, activePaneId, perPaneViewState };
}

export function useWorkspacePersistence({
	enabled,
	validDocumentIds,
}: UseWorkspacePersistenceArgs) {
	// Read on mount, not at module scope: this hook renders on the server first,
	// where there is no localStorage to mint an id in.
	const [deviceId, setDeviceId] = useState<string | null>(null);
	useEffect(() => {
		setDeviceId(getDeviceId());
	}, []);

	const deviceWorkspace = useQuery(
		api.workspaces.getForDevice,
		enabled && deviceId ? { deviceId } : "skip",
	);
	// One-time migration read: only when this device has no row of its own does
	// the old shared row matter, and only to seed from. Nothing writes it back.
	const legacyWorkspace = useQuery(
		api.workspaces.get,
		enabled && deviceWorkspace === null ? {} : "skip",
	);
	const saveWorkspace = useMutation(api.workspaces.saveForDevice);

	const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
	const [hydrated, setHydrated] = useState(false);
	const hydratedRef = useRef(false);
	const workspaceRef = useRef(workspace);
	workspaceRef.current = workspace;
	const deviceIdRef = useRef(deviceId);
	deviceIdRef.current = deviceId;

	const persist = useCallback(
		async (state: WorkspaceState) => {
			const currentDeviceId = deviceIdRef.current;
			if (!currentDeviceId) return;
			const payload = serializeWorkspace(state.paneTree);
			await saveWorkspace({
				deviceId: currentDeviceId,
				deviceClass: WEB_DEVICE_CLASS,
				json: JSON.stringify({
					paneTree: payload.paneTree,
					openDocumentIds: payload.openDocumentIds,
					activePaneId: state.activePaneId,
					perPaneViewState: payload.perPaneViewState,
				}),
			});
		},
		[saveWorkspace],
	);

	const debouncedPersist = useDebouncedCallback((state: WorkspaceState) => {
		void persist(state);
	}, WORKSPACE_DEBOUNCE_MS);

	const debouncedViewStatePersist = useDebouncedCallback(
		(state: WorkspaceState) => {
			void persist(state);
		},
		VIEW_STATE_DEBOUNCE_MS,
	);

	const scheduleSave = useCallback(
		(state: WorkspaceState, kind: "structure" | "viewState" = "structure") => {
			if (kind === "viewState") {
				debouncedViewStatePersist(state);
			} else {
				debouncedPersist(state);
			}
		},
		[debouncedPersist, debouncedViewStatePersist],
	);

	const flushSave = useCallback(async () => {
		debouncedPersist.flush();
		debouncedViewStatePersist.flush();
		const state = workspaceRef.current;
		if (state) await persist(state);
	}, [debouncedPersist, debouncedViewStatePersist, persist]);

	useEffect(() => {
		if (!enabled || deviceWorkspace === undefined) return;
		// Still waiting on the legacy row this device would migrate from.
		if (deviceWorkspace === null && legacyWorkspace === undefined) return;
		if (hydratedRef.current) return;

		const stored: StoredLayout | null =
			deviceWorkspace !== null
				? parseStoredLayout(deviceWorkspace.json)
				: (legacyWorkspace ?? null);

		const finish = (state: WorkspaceState) => {
			setWorkspace(state);
			hydratedRef.current = true;
			setHydrated(true);
		};

		if (stored === null) {
			finish(createDefaultWorkspace());
			return;
		}

		let tree = parsePaneTree(stored.paneTree);
		if (!tree) {
			finish(createDefaultWorkspace());
			return;
		}

		try {
			const viewMap = JSON.parse(stored.perPaneViewState) as Record<
				string,
				{ mode: Mode; viewState: PaneViewState }
			>;
			tree = mergeViewStateFromMap(tree, viewMap);
		} catch {
			// paneTree wins; ignore malformed view state
		}

		tree = reconcileDanglingDocs(tree, validDocumentIds);

		const leaves = collectLeaves(tree);
		const activePaneId = leaves.some((l) => l.paneId === stored.activePaneId)
			? stored.activePaneId
			: (leaves[0]?.paneId ?? createDefaultWorkspace().activePaneId);

		finish({ paneTree: tree, activePaneId });
	}, [enabled, deviceWorkspace, legacyWorkspace, validDocumentIds]);

	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				void flushSave();
			}
		};
		const onUnload = () => {
			void flushSave();
		};
		window.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("beforeunload", onUnload);
		return () => {
			window.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("beforeunload", onUnload);
		};
	}, [flushSave]);

	useEffect(() => {
		return () => {
			debouncedPersist.flush();
			debouncedViewStatePersist.flush();
		};
	}, [debouncedPersist, debouncedViewStatePersist]);

	return {
		workspace,
		setWorkspace,
		scheduleSave,
		flushSave,
		isHydrated: hydrated,
		loading: enabled && (deviceWorkspace === undefined || !hydrated),
	};
}

export type WorkspaceActions = {
	setActivePane: (paneId: string) => void;
	splitActivePane: (
		direction: "vertical" | "horizontal",
	) => SplitPaneResult | null;
	closeActivePane: () => void;
	closePane: (paneId: string) => void;
	setPaneDocument: (paneId: string, documentId: Id<"documents"> | null) => void;
	setPaneMode: (paneId: string, mode: Mode) => void;
	setPaneViewState: (paneId: string, viewState: PaneViewState) => void;
	updateSplitSizes: (splitId: string, sizes: number[]) => void;
	focusNextPane: () => void;
	focusPrevPane: () => void;
	focusDirection: (direction: SpatialDirection) => void;
	replaceWorkspace: (tree: PaneTree, activePaneId: string) => void;
};

export function createWorkspaceActions(
	_getWorkspace: () => WorkspaceState | null,
	setWorkspace: Dispatch<SetStateAction<WorkspaceState | null>>,
	scheduleSave: (
		state: WorkspaceState,
		kind?: "structure" | "viewState",
	) => void,
): WorkspaceActions {
	const commit = (
		updater: (current: WorkspaceState) => WorkspaceState,
		kind: "structure" | "viewState" = "structure",
	) => {
		setWorkspace((current) => {
			if (!current) return current;
			const next = updater(current);
			scheduleSave(next, kind);
			return next;
		});
	};

	return {
		setActivePane: (paneId) => {
			commit((current) => ({ ...current, activePaneId: paneId }));
		},
		splitActivePane: (direction) => {
			let result: SplitPaneResult | null = null;
			commit((current) => {
				result = splitPane(current.paneTree, current.activePaneId, direction);
				if (!result) return current;
				return {
					paneTree: result.tree,
					activePaneId: result.newPaneId,
				};
			});
			return result;
		},
		closeActivePane: () => {
			commit((current) => {
				const closed = closePane(
					current.paneTree,
					current.activePaneId,
					current.activePaneId,
				);
				return {
					paneTree: closed.tree,
					activePaneId: closed.activePaneId,
				};
			});
		},
		closePane: (paneId) => {
			commit((current) => {
				const closed = closePane(
					current.paneTree,
					paneId,
					current.activePaneId,
				);
				return {
					paneTree: closed.tree,
					activePaneId: closed.activePaneId,
				};
			});
		},
		setPaneDocument: (paneId, documentId) => {
			commit((current) => ({
				...current,
				paneTree: setPaneDocument(current.paneTree, paneId, documentId),
			}));
		},
		setPaneMode: (paneId, mode) => {
			commit((current) => ({
				...current,
				paneTree: setPaneMode(current.paneTree, paneId, mode),
			}));
		},
		setPaneViewState: (paneId, viewState) => {
			commit(
				(current) => ({
					...current,
					paneTree: setPaneViewState(current.paneTree, paneId, viewState),
				}),
				"viewState",
			);
		},
		updateSplitSizes: (splitId, sizes) => {
			commit((current) => ({
				...current,
				paneTree: updateSplitSizes(current.paneTree, splitId, sizes),
			}));
		},
		focusNextPane: () => {
			commit((current) => {
				const target = nextPaneId(current.paneTree, current.activePaneId);
				emitFocusPane(target);
				return { ...current, activePaneId: target };
			});
		},
		focusPrevPane: () => {
			commit((current) => {
				const target = prevPaneId(current.paneTree, current.activePaneId);
				emitFocusPane(target);
				return { ...current, activePaneId: target };
			});
		},
		focusDirection: (direction) => {
			commit((current) => {
				const spatial = focusDirectional(current.activePaneId, direction);
				const target =
					spatial ??
					(direction === "right" || direction === "down"
						? nextPaneId(current.paneTree, current.activePaneId)
						: prevPaneId(current.paneTree, current.activePaneId));
				if (target === current.activePaneId) return current;
				emitFocusPane(target);
				return { ...current, activePaneId: target };
			});
		},
		replaceWorkspace: (tree, activePaneId) => {
			commit(() => ({ paneTree: tree, activePaneId }));
		},
	};
}

export function getActiveLeaf(workspace: WorkspaceState | null) {
	if (!workspace) return null;
	return findLeaf(workspace.paneTree, workspace.activePaneId);
}
