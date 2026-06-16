"use client";

import { useQuery } from "convex/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BridgeSession } from "@/lib/bridge/coordinator";
import { getDeviceOrigin } from "@/lib/history/origin";
import {
	type HistoryController,
	useDocumentHistory,
} from "@/lib/history/use-document-history";
import { deriveTitleFromMarkdown } from "@/lib/markdown";
import { type SyncStatus, useDocumentSync } from "@/lib/sync/use-document-sync";
import { DocumentModelRegistry } from "./document-registry";
import { openDocumentIdsFromTree } from "./queries";
import type { WorkspaceState } from "./types";
import {
	createWorkspaceActions,
	getActiveLeaf,
	useWorkspacePersistence,
	type WorkspaceActions,
} from "./use-workspace-persistence";

export type DocumentSyncState = {
	wordCount: number;
	syncStatus: SyncStatus;
	pendingConflict: boolean;
	markdown: string;
	handleEditorChange: () => void;
	flushMarkdown: (markdown: string) => Promise<void>;
	useDraft: () => void;
	useServer: () => void;
	recordHistory: (opts?: { structural?: boolean }) => void;
	flushHistory: () => void;
};

type WorkspaceContextValue = {
	workspace: WorkspaceState | null;
	actions: WorkspaceActions;
	registry: DocumentModelRegistry;
	loading: boolean;
	documentSwitcherOpen: boolean;
	setDocumentSwitcherOpen: (open: boolean) => void;
	getDocumentSync: (documentId: Id<"documents">) => DocumentSyncState | null;
	getDocumentHistory: (documentId: Id<"documents">) => HistoryController | null;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
	const ctx = useContext(WorkspaceContext);
	if (!ctx)
		throw new Error("useWorkspace must be used within WorkspaceProvider");
	return ctx;
}

export function useDocumentSyncFor(documentId: Id<"documents"> | null) {
	const { getDocumentSync } = useWorkspace();
	if (!documentId) return null;
	return getDocumentSync(documentId);
}

export function useDocumentHistoryFor(documentId: Id<"documents"> | null) {
	const { getDocumentHistory } = useWorkspace();
	if (!documentId) return null;
	return getDocumentHistory(documentId);
}

function DocumentSyncHost({
	documentId,
	activePaneId,
	registry,
	onSyncUpdate,
	onHistoryUpdate,
}: {
	documentId: Id<"documents">;
	activePaneId: string;
	registry: DocumentModelRegistry;
	onSyncUpdate: (documentId: Id<"documents">, state: DocumentSyncState) => void;
	onHistoryUpdate: (
		documentId: Id<"documents">,
		controller: HistoryController,
	) => void;
}) {
	const document = useQuery(api.documents.get, { documentId });
	const [editorReady, setEditorReady] = useState(false);

	const getEditorHandle = useCallback(
		() => registry.getPrimaryHandle(documentId, activePaneId),
		[registry, documentId, activePaneId],
	);

	const enabled = editorReady && document !== undefined && document !== null;

	const sync = useDocumentSync({
		documentId,
		getEditorHandle,
		serverMarkdown: document?.markdown,
		serverUpdatedAt: document?.updatedAt,
		enabled,
		deriveTitle: deriveTitleFromMarkdown,
		isManualTitle: registry.isManuallyRenamed(documentId),
	});

	const history = useDocumentHistory({
		documentId,
		getEditorHandle,
		serverCurrentNodeId: document?.currentNodeId,
		serverMarkdown: document?.markdown,
		serverUpdatedAt: document?.updatedAt,
		enabled,
		origin: getDeviceOrigin(),
	});

	// One change handler feeds both the autosave and the undo-tree grouping.
	const syncChange = sync.handleEditorChange;
	const recordHistory = history.recordChange;
	const handleEditorChange = useCallback(() => {
		syncChange();
		recordHistory();
	}, [syncChange, recordHistory]);

	useEffect(() => {
		if (document) {
			const t = setTimeout(() => setEditorReady(true), 50);
			return () => clearTimeout(t);
		}
		setEditorReady(false);
	}, [document]);

	// Keep the latest sync bundle (including fresh function refs) in a ref so we
	// can push it up without depending on the unstable `sync` object identity.
	const stateRef = useRef<DocumentSyncState | null>(null);
	stateRef.current = {
		wordCount: sync.wordCount,
		syncStatus: sync.syncStatus,
		pendingConflict: sync.pendingConflict,
		markdown: document?.markdown ?? "",
		handleEditorChange,
		flushMarkdown: sync.flushMarkdown,
		useDraft: sync.useDraft,
		useServer: sync.useServer,
		recordHistory: history.recordChange,
		flushHistory: history.flush,
	};

	const historyRef = useRef<HistoryController>(history);
	historyRef.current = history;

	// Only re-run when display-relevant primitives change — never on every
	// render — so we don't trigger an infinite update loop in the provider.
	// biome-ignore lint/correctness/useExhaustiveDependencies: primitives are intentional change triggers; the body reads the live stateRef
	useEffect(() => {
		if (stateRef.current) onSyncUpdate(documentId, stateRef.current);
	}, [
		documentId,
		sync.wordCount,
		sync.syncStatus,
		sync.pendingConflict,
		document?.markdown,
		onSyncUpdate,
	]);

	// Push the history controller whenever the tree shape or pointer changes so
	// the visualizer/version panel and the undo/redo chords see live state.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pointer + node count are the display-relevant triggers
	useEffect(() => {
		onHistoryUpdate(documentId, historyRef.current);
	}, [
		documentId,
		history.currentNodeId,
		history.nodes.length,
		onHistoryUpdate,
	]);

	return null;
}

export function WorkspaceProvider({
	enabled,
	children,
}: {
	enabled: boolean;
	children: ReactNode;
}) {
	const documents = useQuery(api.documents.list, enabled ? {} : "skip");
	const registryRef = useRef(new DocumentModelRegistry());
	const registry = registryRef.current;
	const syncStoreRef = useRef(new Map<Id<"documents">, DocumentSyncState>());
	const [syncVersion, setSyncVersion] = useState(0);
	const historyStoreRef = useRef(new Map<Id<"documents">, HistoryController>());
	const [historyVersion, setHistoryVersion] = useState(0);

	const validDocumentIds = useMemo(
		() => new Set(documents?.map((d) => d._id) ?? []),
		[documents],
	);

	const {
		workspace,
		setWorkspace,
		scheduleSave,
		loading: workspaceLoading,
	} = useWorkspacePersistence({ enabled, validDocumentIds });

	const [documentSwitcherOpen, setDocumentSwitcherOpen] = useState(false);

	const actions = useMemo(
		() => createWorkspaceActions(() => workspace, setWorkspace, scheduleSave),
		[workspace, setWorkspace, scheduleSave],
	);

	const openDocumentIds = useMemo(
		() => (workspace ? openDocumentIdsFromTree(workspace.paneTree) : []),
		[workspace],
	);

	const onSyncUpdate = useCallback(
		(documentId: Id<"documents">, state: DocumentSyncState) => {
			const prev = syncStoreRef.current.get(documentId);
			syncStoreRef.current.set(documentId, state);
			// Re-render consumers only when display-relevant values change; the
			// function refs in `state` are read lazily via getDocumentSync.
			if (
				!prev ||
				prev.wordCount !== state.wordCount ||
				prev.syncStatus !== state.syncStatus ||
				prev.pendingConflict !== state.pendingConflict ||
				prev.markdown !== state.markdown
			) {
				setSyncVersion((v) => v + 1);
			}
		},
		[],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: syncVersion bumps identity when display state changes
	const getDocumentSync = useCallback(
		(documentId: Id<"documents">) =>
			syncStoreRef.current.get(documentId) ?? null,
		[syncVersion],
	);

	const onHistoryUpdate = useCallback(
		(documentId: Id<"documents">, controller: HistoryController) => {
			const prev = historyStoreRef.current.get(documentId);
			historyStoreRef.current.set(documentId, controller);
			if (
				!prev ||
				prev.currentNodeId !== controller.currentNodeId ||
				prev.nodes.length !== controller.nodes.length
			) {
				setHistoryVersion((v) => v + 1);
			}
		},
		[],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: historyVersion bumps identity when the tree changes
	const getDocumentHistory = useCallback(
		(documentId: Id<"documents">) =>
			historyStoreRef.current.get(documentId) ?? null,
		[historyVersion],
	);

	const contextValue = useMemo(
		() => ({
			workspace,
			actions,
			registry,
			loading: workspaceLoading,
			documentSwitcherOpen,
			setDocumentSwitcherOpen,
			getDocumentSync,
			getDocumentHistory,
		}),
		[
			workspace,
			actions,
			registry,
			workspaceLoading,
			documentSwitcherOpen,
			getDocumentSync,
			getDocumentHistory,
		],
	);

	return (
		<WorkspaceContext.Provider value={contextValue}>
			{openDocumentIds.map((documentId) => (
				<DocumentSyncHost
					key={documentId}
					documentId={documentId}
					activePaneId={workspace?.activePaneId ?? ""}
					registry={registry}
					onSyncUpdate={onSyncUpdate}
					onHistoryUpdate={onHistoryUpdate}
				/>
			))}
			{children}
		</WorkspaceContext.Provider>
	);
}

/** Bridge session for same-document multi-pane live sync. */
export function useBridgeSession(
	documentId: Id<"documents"> | null,
	markdown: string,
): BridgeSession | null {
	const { registry } = useWorkspace();

	useEffect(() => {
		if (!documentId) return;
		let session = registry.getBridge(documentId);
		if (!session) {
			session = new BridgeSession(markdown);
			registry.setBridge(documentId, session);
		} else {
			session.setMarkdown(markdown);
		}
	}, [documentId, markdown, registry]);

	return documentId ? registry.getBridge(documentId) : null;
}

export { getActiveLeaf };
