"use client";

import { useAuth } from "@clerk/nextjs";
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
	type BlockedWrite,
	type HistoryController,
	useDocumentHistory,
} from "@/lib/history/use-document-history";
import { deriveTitleFromMarkdown } from "@/lib/markdown";
import { useReviewerHistory } from "@/lib/review/use-reviewer-history";
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
	/** Null until the history hook has decided what this document shows. */
	markdown: string | null;
	/**
	 * Identifies the current publication, scoped to the host instance and the
	 * document. Panes key their mode snapshot on it.
	 */
	projectionGeneration: string;
	/** Work the server has not confirmed yet — queued or in flight. */
	hasPendingWrites: boolean;
	/** A write the server refused; terminal until the writer resolves it. */
	blockedWrite: BlockedWrite | null;
	/** Discard the refused write and everything behind it, keeping the text. */
	resolveBlockedWrite: () => void;
	handleEditorChange: () => void;
	flushMarkdown: (markdown: string) => Promise<void>;
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

type SyncHostProps = {
	documentId: Id<"documents">;
	activePaneId: string;
	registry: DocumentModelRegistry;
	onSyncUpdate: (documentId: Id<"documents">, state: DocumentSyncState) => void;
	onHistoryUpdate: (
		documentId: Id<"documents">,
		controller: HistoryController,
	) => void;
};

/**
 * Per-document sync/history host dispatcher (plan 010 Phase C). The OWNER sync
 * path (`OwnerSyncHost`) writes `documents.markdown` + advances
 * `documents.currentNodeId`. A GRANTEE on a doc shared WITH them must do NEITHER
 * — so for any non-owner grantee we mount `ReviewerSyncHost` INSTEAD (a full
 * replacement, never both): it seeds the editor from the owner's current
 * materialized markdown and, for a `suggester`, routes edits to the reviewer's
 * shadow branch via `review.reviewerAppend`. It NEVER reaches the owner-only sync
 * mutations. A `commenter` gets the same read-only seed (so comments anchor
 * against the live text) but no editing write path at all — its edits are
 * dropped, not appended.
 *
 * The branch decision keys on `review.documentShareState`: a non-null `role`
 * other than "owner" means the caller opened a shared-with-me doc.
 */
function DocumentSyncHost(props: SyncHostProps) {
	const shareState = useQuery(api.review.documentShareState, {
		documentId: props.documentId,
	});

	// Loading: render nothing rather than briefly mounting the owner path for a
	// doc that may turn out to be shared-with-me (which would risk an owner write).
	if (shareState === undefined) return null;

	const isGrantee = shareState !== null && shareState.role !== "owner";

	if (isGrantee) {
		return (
			<ReviewerSyncHost
				{...props}
				canSuggest={shareState.role === "suggester"}
			/>
		);
	}
	return <OwnerSyncHost {...props} />;
}

function OwnerSyncHost({
	documentId,
	activePaneId,
	registry,
	onSyncUpdate,
	onHistoryUpdate,
}: SyncHostProps) {
	const document = useQuery(api.documents.get, { documentId });
	const [editorReady, setEditorReady] = useState(false);

	const getEditorHandle = useCallback(
		() => registry.getPrimaryHandle(documentId, activePaneId),
		[registry, documentId, activePaneId],
	);

	const enabled = editorReady && document !== undefined && document !== null;

	// The two hooks are mutually dependent: sync needs history's head and its
	// projection, history needs to tell sync when a projection has landed. The
	// sync hook is declared first, so its side of the contract goes through a ref
	// this render keeps current. Every getter reads a ref INSIDE the history hook
	// that advances synchronously on commit/navigate, so a mode switch that
	// flushes history and markdown in one tick sees the new head (R5).
	const historyApiRef = useRef<HistoryController | null>(null);
	const getCurrentHeadNodeId = useCallback(
		() => historyApiRef.current?.getHeadNodeId() ?? null,
		[],
	);
	const getHasPendingDraft = useCallback(
		() => historyApiRef.current?.hasPendingDraft() ?? false,
		[],
	);
	const reconcileRemote = useCallback(
		() => historyApiRef.current?.reconcileRemote() ?? false,
		[],
	);

	const sync = useDocumentSync({
		documentId,
		getEditorHandle,
		serverMarkdown: document?.markdown,
		serverUpdatedAt: document?.updatedAt,
		serverCurrentNodeId: document?.currentNodeId,
		enabled,
		deriveTitle: deriveTitleFromMarkdown,
		isManualTitle: registry.isManuallyRenamed(documentId),
		getCurrentHeadNodeId,
		getHasPendingDraft,
		reconcileRemote,
	});

	// V2: what the panes render. NOT documents.markdown — that value has no
	// provenance, so a preview pane would show a legacy body and a switch to raw
	// would flush it back under the current head, stamping it. Null until the
	// history hook has made its first decision; panes treat that as loading.
	const [projectedMarkdown, setProjectedMarkdown] = useState<string | null>(
		null,
	);
	// Every publication supersedes the last. Panes key their mode-switch
	// snapshot on this rather than on the text, because an undo can republish
	// markdown a superseded snapshot was keyed on.
	//
	// It is a STRING scoped to this host instance and this document, not a bare
	// counter: a counter restarts at 0 for every host and every document, so a
	// snapshot taken in document A — or by a host that has since remounted —
	// matched document B's first publication and flushed A's text under B.
	const hostInstanceIdRef = useRef<string>("");
	if (hostInstanceIdRef.current === "") {
		hostInstanceIdRef.current = crypto.randomUUID();
	}
	const projectionCountRef = useRef(0);
	const [projectionGeneration, setProjectionGeneration] = useState(
		() => `${hostInstanceIdRef.current}:${documentId}:0`,
	);
	const acceptRemoteProjection = sync.acceptRemoteProjection;
	const adoptRecoveredDraft = sync.adoptRecoveredDraft;
	const markLocalProjectionPending = sync.markLocalProjectionPending;
	const settleLocalProjection = sync.settleLocalProjection;
	const onProjection = useCallback(
		(projection: {
			markdown: string;
			serverUpdatedAt: number;
			source: "server" | "recovered-draft" | "local";
			projectionId?: string;
			kind?: "draft" | "commit" | "pointer";
			pointerNodeId?: string;
			resolvedProjectionId?: string;
		}) => {
			// Publish first: this is how the text reaches a preview-only pane, and
			// nothing may be treated as accepted before it has.
			setProjectedMarkdown(projection.markdown);
			projectionCountRef.current += 1;
			setProjectionGeneration(
				`${hostInstanceIdRef.current}:${documentId}:${projectionCountRef.current}`,
			);
			if (projection.source === "server") {
				acceptRemoteProjection(
					projection.markdown,
					projection.serverUpdatedAt,
					projection.resolvedProjectionId,
				);
			} else if (projection.source === "recovered-draft") {
				adoptRecoveredDraft(projection.markdown, projection.kind);
			} else {
				// A programmatic seed (AI accept, version restore) never reaches
				// handleEditorChange, and a pointer move changes no text at all, so
				// nothing else would mark either dirty. They stay unsaved — and
				// recoverable — until the server acknowledges them.
				markLocalProjectionPending(
					projection.markdown,
					projection.projectionId ?? crypto.randomUUID(),
					projection.kind ?? "draft",
					projection.pointerNodeId,
				);
			}
		},
		[
			acceptRemoteProjection,
			adoptRecoveredDraft,
			documentId,
			markLocalProjectionPending,
		],
	);

	const history = useDocumentHistory({
		documentId,
		getEditorHandle,
		serverCurrentNodeId: document?.currentNodeId,
		serverMarkdown: document?.markdown,
		serverUpdatedAt: document?.updatedAt,
		serverPointerRevision: document?.pointerRevision,
		serverMarkdownHeadNodeId: document?.markdownHeadNodeId,
		getBaselineUpdatedAt: sync.getBaselineUpdatedAt,
		enabled,
		origin: getDeviceOrigin(),
		onProjection,
		onProjectionSettled: settleLocalProjection,
		getPendingProjectionId: sync.getPendingProjectionId,
		getRecoveredDraft: sync.getRecoveredDraft,
	});
	historyApiRef.current = history;

	// R1: autosave holds the draft while the head is unknown. Flush once history
	// hydrates and the compare-and-set can actually be satisfied.
	const headKnown = history.currentNodeId !== null;
	const flushSync = sync.flushSync;
	useEffect(() => {
		if (!headKnown) return;
		void flushSync();
	}, [headKnown, flushSync]);

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
		markdown: projectedMarkdown,
		projectionGeneration,
		hasPendingWrites: history.hasPendingWrites,
		blockedWrite: history.blockedWrite,
		resolveBlockedWrite: history.resolveBlockedWrite,
		handleEditorChange,
		flushMarkdown: sync.flushMarkdown,
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
		history.hasPendingWrites,
		history.blockedWrite,
		// The PROJECTION, not documents.markdown: a change that only moves what
		// the panes should render — an undo, a branch switch, a remote projection
		// at the same word count — never touched the raw field, so it never
		// reached the store and a preview pane stayed on the previous node.
		projectedMarkdown,
		projectionGeneration,
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

/**
 * Reviewer-mode sync/history host (plan 010 Phase C). Mounted INSTEAD of
 * `OwnerSyncHost` for a doc shared-with-me (any non-owner grantee). It
 * deliberately does NOT run `useDocumentSync` (the owner autosave) nor the owner
 * `useDocumentHistory` (which advances the owner pointer). Instead it seeds the
 * editor once from `review.getReviewerDocument` and — for a `suggester` only —
 * routes edits to the reviewer's shadow branch via `useReviewerHistory` →
 * `review.reviewerAppend`. A `commenter` gets the same read-only seed (so
 * comments anchor against the live text) but its edits are dropped.
 *
 * This is the UI-side isolation boundary: the owner's `documents` row is never
 * written by a grantee's keystrokes. The `DocumentSyncState` it publishes has a
 * neutral "synced" status (reviewer suggestions are append-only and don't carry
 * the owner's save lifecycle) and a no-op `flushMarkdown`/conflict surface.
 */
function ReviewerSyncHost({
	documentId,
	activePaneId,
	registry,
	onSyncUpdate,
	onHistoryUpdate,
	canSuggest,
}: SyncHostProps & { canSuggest: boolean }) {
	const { userId } = useAuth();
	const shared = useQuery(api.review.getReviewerDocument, { documentId });
	const [editorReady, setEditorReady] = useState(false);
	const seededRef = useRef(false);

	const getEditorHandle = useCallback(
		() => registry.getPrimaryHandle(documentId, activePaneId),
		[registry, documentId, activePaneId],
	);

	const enabled = editorReady && shared !== undefined;
	const wordCount = shared
		? shared.markdown.trim()
			? shared.markdown.trim().split(/\s+/).length
			: 0
		: 0;

	const history = useReviewerHistory({
		documentId,
		reviewerUserId: userId ?? "",
		getEditorHandle,
		seedMarkdown: shared?.markdown,
		baseNodeId: shared?.baseNodeId,
		enabled,
	});

	// Seed the reviewer editor ONCE from the owner's current materialized markdown.
	// The editor then owns live state — it is NEVER re-bound to this reactive query
	// (re-seeding would clobber the reviewer's in-progress branch). Retry until the
	// editor handle is mounted.
	useEffect(() => {
		if (!enabled || seededRef.current || shared === undefined || !shared)
			return;
		const trySeed = (): boolean => {
			const handle = getEditorHandle();
			if (!handle) return false;
			handle.seed(shared.markdown, { programmatic: true });
			seededRef.current = true;
			return true;
		};
		if (trySeed()) return;
		const interval = window.setInterval(() => {
			if (trySeed()) window.clearInterval(interval);
		}, 50);
		return () => window.clearInterval(interval);
	}, [enabled, getEditorHandle, shared]);

	useEffect(() => {
		if (shared) {
			const t = setTimeout(() => setEditorReady(true), 50);
			return () => clearTimeout(t);
		}
		setEditorReady(false);
	}, [shared]);

	// Only a `suggester` records edits onto a branch; a `commenter` is read-only
	// (its keystrokes are dropped, never appended — the editor stays a viewer).
	const recordHistory = history.recordChange;
	const handleEditorChange = useCallback(() => {
		if (canSuggest) recordHistory();
	}, [canSuggest, recordHistory]);
	const noopRecord = useCallback(() => {}, []);
	const noopFlush = useCallback(() => {}, []);
	const noopResolveBlocked = useCallback(() => {}, []);

	const stateRef = useRef<DocumentSyncState | null>(null);
	stateRef.current = {
		wordCount,
		// Reviewer suggestions are append-only; there is no owner-save lifecycle to
		// surface, so show a settled status rather than the autosave states.
		syncStatus: "saved",
		pendingConflict: false,
		markdown: shared?.markdown ?? "",
		projectionGeneration: "reviewer",
		hasPendingWrites: false,
		blockedWrite: null,
		resolveBlockedWrite: noopResolveBlocked,
		handleEditorChange,
		// No owner write path for a grantee — flushing markdown is a no-op.
		flushMarkdown: async () => {},
		recordHistory: canSuggest ? history.recordChange : noopRecord,
		flushHistory: canSuggest ? history.flush : noopFlush,
	};

	const historyRef = useRef<HistoryController>(history);
	historyRef.current = history;

	// biome-ignore lint/correctness/useExhaustiveDependencies: word count + seed availability are the display-relevant triggers; body reads live stateRef
	useEffect(() => {
		if (stateRef.current) onSyncUpdate(documentId, stateRef.current);
	}, [documentId, wordCount, shared?.markdown, onSyncUpdate]);

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
				prev.markdown !== state.markdown ||
				// An undo can republish identical text; without this the panes never
				// learn that their mode snapshot has been superseded.
				prev.projectionGeneration !== state.projectionGeneration ||
				prev.hasPendingWrites !== state.hasPendingWrites ||
				prev.blockedWrite !== state.blockedWrite
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
		} else if (!session.isActive()) {
			// Race guard: only re-seed the bridge's in-memory mdast from the reactive
			// server markdown while the bridge is INACTIVE (a single pane / panes still
			// mounting — its mdast bus isn't driving a live cross-pane sync yet, so a
			// refresh is harmless and keeps it current for the next pane). Once the
			// bridge is ACTIVE (rich+raw both connected), the editors own live state and
			// every debounced-autosave echo would otherwise overwrite a just-typed mdast
			// here — reverting the complementary pane. Live deltas flow through
			// handleRichUpdate/handleRawUpdate (version/isApplying-guarded) instead.
			session.setMarkdown(markdown);
		}
	}, [documentId, markdown, registry]);

	return documentId ? registry.getBridge(documentId) : null;
}

export { getActiveLeaf };
