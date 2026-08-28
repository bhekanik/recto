"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { countWords } from "@/lib/markdown";
import { caretAtOffset } from "@/lib/modes/caret";
import { newProjectionId, type ProjectionKind } from "@/lib/sync/draft-buffer";
import { classifyRefusal } from "@/lib/sync/refusal";
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
	/**
	 * The head this device is committing onto, read from a ref that advances
	 * synchronously on commit and navigate. Rendered state lags a synchronous
	 * `flushHistory()` immediately followed by `flushMarkdown()` (mode switch),
	 * which would send the autosave CAS the previous head.
	 */
	getHeadNodeId: () => string | null;
	/**
	 * Writes this device has produced that the server has not confirmed — queued,
	 * or sent and still outstanding. A manual version tag creates no pending
	 * projection of its own, so without this the status bar said "Saved" while
	 * the version was still uncreated.
	 */
	hasPendingWrites: boolean;
	/**
	 * The write the queue is stuck on, refused or unclassified. Null while
	 * everything is moving. See BlockedWrite for why the distinction matters.
	 */
	blockedWrite: BlockedWrite | null;
	/**
	 * Send the stuck write again, unchanged — same arguments, same
	 * `clientMutationId`, which the server answers idempotently. The
	 * non-destructive way out, and the right one for anything not proven
	 * terminal. If the head has moved meanwhile the server answers with ordinary
	 * divergence.
	 */
	retryBlockedWrite: () => void;
	/**
	 * Give up on the stuck write AND everything queued behind it — those chain
	 * off a node the server never received — keeping what is on screen: the
	 * document is moved onto the head the server actually has, with the writer's
	 * text held as an open draft that their next edit commits as an ordinary
	 * child node. Destructive; the caller must confirm first.
	 */
	resolveBlockedWrite: () => void;
	/** Local input the tree has not captured yet — see GroupingController. */
	hasPendingDraft: () => boolean;
	/**
	 * Project the server's current undo-tree state into the editor, the grouping
	 * controller and the pointer together, if that is safe right now. Returns
	 * false when it was deferred (uncommitted local text, editor still active, or
	 * the node has not synced), in which case the caller must NOT treat the
	 * remote revision as handled — reconciliation is retried automatically.
	 */
	reconcileRemote: () => boolean;
};

const AUTO_VERSION_MS = 120_000; // tag an auto version ~2min after activity settles
/** How long the editor must be quiet before remote state may be projected. */
const EDITOR_IDLE_MS = 2_000;
/** How often to look for a writable editor while a projection is waiting. */
const HANDLE_RETRY_MS = 250;
/** Automatic ensureRoot attempts before the writer is asked to retry. */
const ENSURE_ROOT_MAX_ATTEMPTS = 4;
const ENSURE_ROOT_BASE_DELAY_MS = 400;

/** What the queue is holding, so a confirmation can name it exactly. */
export type DiscardSummary = {
	commits: number;
	/** Of those commits, how many an AI produced (`ai:*` origin). */
	aiCommits: number;
	pointers: number;
	versions: number;
};

/**
 * A write the queue is stuck on.
 *
 * `terminal` separates the two cases that must not be confused. A refusal the
 * SERVER classified can never succeed on a re-send, so the only way out is to
 * give the write up. Anything else — an OCC conflict that outlived Convex's own
 * retries, a rate limiter, a load-shedding disconnect — can succeed on an
 * identical later attempt, so it is offered as Retry and nothing is discarded.
 */
export type BlockedWrite = {
	kind: "commit" | "pointer";
	/** The server's own message, shown to the writer verbatim. */
	message: string;
	terminal: boolean;
	/** The server's refusal code, when it classified the failure. */
	code?: string;
	/** How long a rate limiter asked us to wait before retrying, in ms. */
	retryAfterMs?: number;
	/** What discarding would throw away. */
	discards: DiscardSummary;
};

/**
 * One history-dependent write, waiting its turn.
 *
 * Commits, pointer moves and version tags all go through a SINGLE ordered
 * queue, one at a time. They are not independent: a pointer move sent past a
 * commit the server has not answered would be overtaken when that commit lands,
 * silently reversing an undo the writer had already performed. The queue
 * preserves the order the writer produced the events in.
 */
type OutboxEntry = {
	/** The pointer move this entry settles, if any. */
	moveToken: number | null;
	/** The unsaved work it carries, for the acknowledgement to name. */
	projectionId: string | null;
} & (
	| {
			kind: "commit";
			args: {
				documentId: Id<"documents">;
				node: {
					nodeId: string;
					parentNodeId: string | null;
					patch: string;
					snapshot?: string;
					selection: { anchor: number; head: number } | null;
					origin: string;
					createdAt: number;
				};
				markdown: string;
				wordCount: number;
				expectedHeadNodeId: string;
				clientMutationId: string;
			};
	  }
	| {
			kind: "pointer";
			nodeId: string;
			markdown: string;
	  }
	| {
			kind: "version";
			nodeId: string;
			label: string;
			versionKind: "auto" | "manual";
	  }
);

/**
 * This client's own most recent pointer move, tracked until the server echoes it
 * back. `appliedAt` is the server `updatedAt` the move was written at, or null
 * while the write is still in flight. `token` identifies the individual move:
 * node ids repeat (undo to A, redo to B, undo to A again), so a response must
 * name the attempt it belongs to or the first A can settle the second.
 */
export type LocalPointerMove = {
	token: number;
	nodeId: string;
	/** `documents.pointerRevision` our write produced, or null while in flight. */
	appliedRevision: number | null;
	/** The text published for this move, so its acknowledgement can name it. */
	markdown: string;
	/** Identity of the unsaved work this move published (S2). */
	projectionId: string;
};

/** A remote pointer we have decided to adopt but could not project yet. */
export type QueuedRemotePointer = { nodeId: string; revision: number };

/**
 * The server's stored markdown, but only when it can be trusted as a draft
 * belonging to `headNodeId` — otherwise null, meaning "show the DAG instead".
 *
 * `documents.markdown` can be ahead of the head (a writer who never paused long
 * enough to close a grouping boundary) which is worth rescuing, or it can be
 * text a pre-deploy client saved with no idea which branch it belonged to,
 * which must never be promoted into this one. `markdownHeadNodeId` is the only
 * thing that tells those apart, so an absent or mismatched stamp is distrusted.
 *
 * Shared by first-open hydration and remote reconciliation so both answer the
 * question the same way.
 */
export function trustedServerDraft(args: {
	headNodeId: string;
	materialized: string;
	serverMarkdown: string | undefined;
	serverMarkdownHeadNodeId: string | undefined;
	/** False when the observation is not newer than what the editor shows. */
	isNewerThanBaseline: boolean;
}): string | null {
	const {
		headNodeId,
		materialized,
		serverMarkdown,
		serverMarkdownHeadNodeId,
		isNewerThanBaseline,
	} = args;
	if (serverMarkdown === undefined) return null;
	if (serverMarkdownHeadNodeId !== headNodeId) return null;
	if (serverMarkdown === materialized) return null;
	if (!isNewerThanBaseline) return null;
	return serverMarkdown;
}

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
	/** `documents.pointerRevision` of the observation being judged. */
	serverPointerRevision: number;
	localMove: LocalPointerMove | null;
}): PointerDecision {
	const { serverCurrentNodeId, serverPointerRevision, localMove } = args;
	if (!localMove) return "adopt";
	// The server caught up with us; there is nothing left to reconcile.
	if (serverCurrentNodeId === localMove.nodeId) return "settled";
	// Our move has not reached the server, so everything we see predates it.
	if (localMove.appliedRevision === null) return "ignore";
	// Strictly older observations are echoes of the state we moved off. An EQUAL
	// revision naming a different node cannot happen — one revision is one
	// pointer write — so treating it as adoptable is the safe direction: the
	// failure being fixed is ignoring real remote moves, never adopting too eagerly.
	if (serverPointerRevision < localMove.appliedRevision) return "ignore";
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
	/** `documents.pointerRevision`; orders pointer observations (ADR-19). */
	serverPointerRevision: number | undefined;
	/**
	 * `documents.markdownHeadNodeId` — the head `serverMarkdown` belongs to.
	 * Undefined means unknown provenance (a legacy headless save), and is never
	 * trusted as a draft.
	 */
	serverMarkdownHeadNodeId: string | undefined;
	/**
	 * The server `updatedAt` this device's editor already reflects, from the sync
	 * hook. A "newer draft" must be newer than this or there is nothing to show.
	 */
	getBaselineUpdatedAt?: () => number;
	enabled: boolean;
	origin: string;
	/**
	 * Called after remote state has been projected into the editor, so the sync
	 * hook can accept the text as the new baseline instead of flushing it back
	 * as a local edit. Projection is the ONLY thing that clears a dirty draft.
	 */
	/**
	 * Publish the document's canonical text. EVERY transition goes through this —
	 * local commits, AI commits, undo, redo, branch switches and remote
	 * projections — because it is what the panes render. A transition that
	 * updated only the editor handle left a preview pane of the same document
	 * showing the previous node.
	 */
	onProjection?: (projection: {
		markdown: string;
		serverUpdatedAt: number;
		/** Where the text came from, which decides whether it counts as saved. */
		source: "server" | "recovered-draft" | "local";
		/** Identity of the unsaved work, for anything but a server projection. */
		projectionId?: string;
		/** Whether this work is text the writer produced or a pointer move. */
		kind?: ProjectionKind;
		/** For pointer work: the node the move was trying to reach. */
		pointerNodeId?: string;
		/**
		 * For a server projection that RESOLVES a refused transition: the id it
		 * settles. Without it the pane showed the server's head while the
		 * document stayed unsynced and storage kept the refused target.
		 */
		resolvedProjectionId?: string;
	}) => void;
	/**
	 * A local projection has been accepted or refused by the server. Until this
	 * says `ok`, the text it names is unsaved and must stay recoverable.
	 */
	onProjectionSettled?: (settled: {
		projectionId: string;
		markdown: string;
		serverUpdatedAt: number;
		ok: boolean;
	}) => void;
	/**
	 * A draft restored from storage on open, resolved without an editor. `kind`
	 * and `pointerNodeId` are what make a recovered POINTER move replayable:
	 * without them it looked like plain text, no queue entry was rebuilt, and the
	 * next markdown acknowledgement retired a move the server never took.
	 */
	getRecoveredDraft?: () => {
		present: boolean;
		markdown: string;
		projectionId?: string;
		kind?: ProjectionKind;
		pointerNodeId?: string;
	} | null;
	/** Unsaved local work the server has not answered yet (S2/S3). */
	getPendingProjectionId?: () => string | null;
}): HistoryController {
	const {
		documentId,
		getEditorHandle,
		serverCurrentNodeId,
		serverMarkdown,
		serverUpdatedAt,
		serverPointerRevision,
		serverMarkdownHeadNodeId,
		getBaselineUpdatedAt,
		enabled,
		origin,
		onProjection,
		onProjectionSettled,
		getRecoveredDraft,
		getPendingProjectionId,
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
	// Written through setPointer, NOT during render. An effect that runs in the
	// same commit as a pointer change has to see the new value: reading a
	// render-lagged ref made the hook treat its own hydration as a remote move,
	// re-seeding the editor and toasting on every document open.
	const currentNodeIdRef = useRef<string | null>(null);
	const ensureRootSentRef = useRef(false);
	const ensureRootAttemptsRef = useRef(0);
	// Binds a retry to the attempt that started it. A response or timer that
	// arrives after the hook has moved on — unmounted, or rebound to another
	// document — would otherwise resurrect a retry loop against state that no
	// longer exists.
	const ensureRootTokenRef = useRef(0);
	const ensureRootTimerRef = useRef<number | null>(null);
	// Set once the automatic attempts are spent, so the failure is reported once
	// rather than on every retry.
	const [rootFailed, setRootFailed] = useState(false);
	const localMoveRef = useRef<LocalPointerMove | null>(null);
	const moveTokenRef = useRef(0);
	// History-dependent writes waiting on the server, oldest first. A rejected
	// commitEdit means the transaction ROLLED BACK — the node never landed — so
	// sending its descendants would chain the tree off a node the server has
	// never seen.
	const outboxRef = useRef<OutboxEntry[]>([]);
	// The entry currently in flight. Without it, anything that queued more work
	// re-entered the pump and sent the head a SECOND time: two quick version
	// tags inserted the first tag twice, because versions.create is not
	// idempotent.
	const outboxActiveRef = useRef<OutboxEntry | null>(null);
	// Queue depth, mirrored into state because it is what the status bar reads.
	// A version tag publishes no projection of its own, so it was invisible to
	// the sync status and a manual version could sit uncreated under "Saved".
	const [pendingWriteCount, setPendingWriteCount] = useState(0);
	// A write the server refused. Terminal — see BlockedWrite. Mirrored in a ref
	// because the pump reads it synchronously: the rejection that sets it and the
	// next enqueue can land in the same tick, before React has re-rendered.
	const blockedRef = useRef<BlockedWrite | null>(null);
	const [blockedWrite, setBlockedWriteState] = useState<BlockedWrite | null>(
		null,
	);
	/** Ref and state together, so the two can never disagree. */
	const setBlockedWrite = useCallback((next: BlockedWrite | null) => {
		blockedRef.current = next;
		setBlockedWriteState(next);
	}, []);
	// The `documents.pointerRevision` this client's own causal chain has reached:
	// hydration, its own successful writes, and projections it has ADOPTED.
	// Deliberately NOT advanced by a raw query observation, which is what a
	// queued pointer move compares against — see the pointer send in pumpOutbox.
	const confirmedPointerRevisionRef = useRef(0);
	// Armed only by an explicit Retry that the server asked us to delay
	// (`retryAfter`). Never an automatic retry loop.
	const retryTimerRef = useRef<number | null>(null);
	// What each in-flight write carries, kept independently of the pointer-move
	// slot. That slot is cleared as soon as the server echoes the new head —
	// which Convex delivers BEFORE the mutation's own result — so an
	// acknowledgement that looked there found nothing and the work it was
	// acknowledging stayed pending forever.
	const inFlightRef = useRef(
		new Map<number, { projectionId: string; markdown: string }>(),
	);
	// The one pending projection an automatic re-sync may resolve: the pointer
	// move whose write failed. Anything the writer produced after it is newer
	// than the failure and is not ours to overwrite.
	const resyncProjectionIdRef = useRef<string | null>(null);
	// A remote pointer we have decided to adopt but cannot project yet — the
	// writer is mid-sentence, or the node has not reached this client's DAG.
	// Held until the next safe moment instead of being dropped.
	const pendingRemotePointerRef = useRef<QueuedRemotePointer | null>(null);
	// The head autosave commits against. A ref, not rendered state: a mode switch
	// flushes history and markdown in the same tick, and state would still hold
	// the previous head (R5).
	const headNodeIdRef = useRef<string | null>(null);
	// Whether the editor has settled. Remote state is projected on idle rather
	// than on blur: in vim and full-screen the editor never loses DOM focus, so
	// a focus-gated adoption would never fire at all (R4).
	const editorIdleRef = useRef(true);
	const onProjectionRef = useRef(onProjection);
	onProjectionRef.current = onProjection;
	const onProjectionSettledRef = useRef(onProjectionSettled);
	onProjectionSettledRef.current = onProjectionSettled;
	// Bumped whenever something happens that could unblock a queued adoption
	// (a local move settles, the editor blurs). The reconciliation lives in an
	// effect, so it needs a state dependency to re-run on.
	const [reconcileTick, setReconcileTick] = useState(0);
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
		ensureRootAttemptsRef.current = 0;
		// Invalidate BEFORE clearing the timer: a callback already queued cannot
		// be cancelled, so it has to be able to recognise itself as stale.
		ensureRootTokenRef.current += 1;
		if (ensureRootTimerRef.current !== null) {
			window.clearTimeout(ensureRootTimerRef.current);
			ensureRootTimerRef.current = null;
		}
		setRootFailed(false);
		lastAutoNodeIdRef.current = null;
		localMoveRef.current = null;
		inFlightRef.current.clear();
		outboxRef.current = [];
		outboxActiveRef.current = null;
		setPendingWriteCount(0);
		setBlockedWrite(null);
		confirmedPointerRevisionRef.current = 0;
		if (retryTimerRef.current !== null) {
			window.clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		pendingRemotePointerRef.current = null;
		pendingRecordRef.current = null;
		headNodeIdRef.current = null;
		editorIdleRef.current = true;
		setLocalNodes([]);
		currentNodeIdRef.current = null;
		setCurrentNodeId(null);
	}, [documentId]);

	/**
	 * The single place canonical text leaves this hook. Local transitions publish
	 * for the panes only; the sync hook already knows their dirty state.
	 */
	const publishProjection = useCallback(
		(
			markdown: string,
			source: "server" | "recovered-draft" | "local",
			serverUpdatedAt = 0,
			projectionId?: string,
			extra?: {
				kind?: ProjectionKind;
				pointerNodeId?: string;
				resolvedProjectionId?: string;
			},
		) => {
			onProjectionRef.current?.({
				markdown,
				serverUpdatedAt,
				source,
				projectionId,
				kind: extra?.kind,
				pointerNodeId: extra?.pointerNodeId,
				resolvedProjectionId: extra?.resolvedProjectionId,
			});
		},
		[],
	);

	/** Move the pointer, keeping the ref and the rendered state in step. */
	const setPointer = useCallback((nodeId: string | null) => {
		currentNodeIdRef.current = nodeId;
		setCurrentNodeId(nodeId);
	}, []);

	/** Claim the pointer for a move this client is about to write. */
	const startLocalMove = useCallback(
		(nodeId: string, markdown: string, projectionId: string): number => {
			moveTokenRef.current += 1;
			localMoveRef.current = {
				token: moveTokenRef.current,
				nodeId,
				appliedRevision: null,
				markdown,
				projectionId,
			};
			inFlightRef.current.set(moveTokenRef.current, {
				projectionId,
				markdown,
			});
			headNodeIdRef.current = nodeId;
			return moveTokenRef.current;
		},
		[],
	);

	/**
	 * Record what became of a pointer move this client started. `appliedAt` is
	 * the server `updatedAt` it was written at, or null when the move never took
	 * — a failed write, or a head another writer owns. Either way the guard has
	 * to go: keeping it would deafen this client to every later remote move.
	 *
	 * The tick is bumped either way. A move that settles to null unblocks a
	 * remote pointer this client was ignoring while the move was in flight, and
	 * nothing else would re-run the reconciliation for it.
	 */
	const settleLocalMove = useCallback(
		(
			token: number | null,
			appliedRevision: number | null,
			serverUpdatedAt = 0,
		) => {
			// A version tag settles no pointer move.
			if (token === null) return;
			// A local transition is only SAVED once the server has taken it. Until
			// then its text must stay recoverable: a programmatic seed (AI accept,
			// version restore) never goes through the editor's change handler, so
			// nothing else would mark it dirty, and a rejected commit would lose it
			// on reload. This is reported from the in-flight record, not from the
			// pointer slot, which the server's echo may already have cleared.
			const inFlight = inFlightRef.current.get(token);
			if (inFlight) {
				inFlightRef.current.delete(token);
				onProjectionSettledRef.current?.({
					projectionId: inFlight.projectionId,
					markdown: inFlight.markdown,
					serverUpdatedAt,
					ok: appliedRevision !== null,
				});
			}
			const move = localMoveRef.current;
			if (move?.token !== token) return;
			if (appliedRevision === null) localMoveRef.current = null;
			else move.appliedRevision = appliedRevision;
			setReconcileTick((tick) => tick + 1);
		},
		[],
	);

	// The editor counts as settled 2s after the last change. Adoption keys off
	// this rather than DOM focus, which never leaves in vim or full-screen.
	const markEditorIdle = useDebouncedCallback(() => {
		editorIdleRef.current = true;
		if (pendingRemotePointerRef.current === null) return;
		setReconcileTick((tick) => tick + 1);
	}, EDITOR_IDLE_MS);

	/** Queue a remote head, keeping the newest observation of it. */
	const queueRemotePointer = useCallback((next: QueuedRemotePointer) => {
		const queued = pendingRemotePointerRef.current;
		if (queued && queued.revision > next.revision) return;
		pendingRemotePointerRef.current = next;
	}, []);

	/** What the queue currently holds, named exactly, for the confirmation. */
	const summariseQueue = useCallback((): DiscardSummary => {
		const discards: DiscardSummary = {
			commits: 0,
			aiCommits: 0,
			pointers: 0,
			versions: 0,
		};
		for (const queued of outboxRef.current) {
			if (queued.kind === "commit") {
				discards.commits += 1;
				if (queued.args.node.origin.startsWith("ai:")) discards.aiCommits += 1;
			} else if (queued.kind === "pointer") {
				discards.pointers += 1;
			} else {
				discards.versions += 1;
			}
		}
		return discards;
	}, []);

	/** Queue a write and report the new depth, then try to send. */
	const enqueue = useCallback(
		(entry: OutboxEntry) => {
			outboxRef.current.push(entry);
			setPendingWriteCount(outboxRef.current.length);
			// Editing stays enabled while the queue is stuck, so work keeps arriving
			// behind the write the writer is being asked about. The summary they are
			// shown has to keep up: it was taken once, at the first rejection, so a
			// confirmation could say "1 unsaved edit" and then discard four.
			if (blockedRef.current !== null) {
				setBlockedWrite({
					...blockedRef.current,
					discards: summariseQueue(),
				});
			}
			pumpOutboxRef.current();
		},
		[setBlockedWrite, summariseQueue],
	);

	// Merge the reactive DAG with any optimistically-appended local nodes.
	const nodes = useMemo<HistoryNode[]>(() => {
		const remote = (dagRows ?? []) as HistoryNode[];
		return unionMerge(remote, localNodes) as HistoryNode[];
	}, [dagRows, localNodes]);

	const nodesById = useMemo(() => indexNodes(nodes), [nodes]);
	// The same map, but advanced synchronously by onCommit. A flush inside undo /
	// navigateTo / tagVersion creates a node those callers must then look up, and
	// the memo above only catches up on the next render.
	const nodesByIdRef = useRef(nodesById);
	nodesByIdRef.current = nodesById;

	// Auto-versioning on the idle path (blueprint 08 §4, phase-4 C2): a periodic
	// "auto" tag of the current node, deduped — never a duplicate when nothing
	// changed since the last auto version (G5).
	const lastAutoNodeIdRef = useRef<string | null>(null);
	const debouncedAutoVersion = useDebouncedCallback(() => {
		if (!documentId) return;
		const id = currentNodeIdRef.current;
		if (!id || id === lastAutoNodeIdRef.current) return;
		lastAutoNodeIdRef.current = id;
		enqueue({
			kind: "version",
			moveToken: null,
			projectionId: null,
			nodeId: id,
			label: `Autosave ${new Date().toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})}`,
			versionKind: "auto",
		});
	}, AUTO_VERSION_MS);

	// A one-shot origin override consumed by the next commit (AI transforms tag
	// their node `ai:<label>`); cleared after use so normal edits keep the device
	// origin (plan 009).
	const originOverrideRef = useRef<string | null>(null);

	/**
	 * Send the head of the queue, and only the head.
	 *
	 * Nothing behind an unanswered write may go out. A commit's descendants would
	 * chain off a node the server may not have; a pointer move sent past a
	 * waiting commit is overtaken when that commit finally lands, silently
	 * reversing an undo the writer had already performed.
	 */
	const pumpOutbox = useCallback(() => {
		// One write at a time. Re-entering the pump while the head was in flight
		// sent it twice — and versions.create is not idempotent, so two quick
		// tags inserted the first one twice.
		if (outboxActiveRef.current !== null) return;
		// Stuck: the head needs the writer's decision (Retry, or give it up).
		if (blockedRef.current !== null) return;
		if (retryTimerRef.current !== null) return;
		const entry = outboxRef.current[0];
		if (!entry) return;
		if (!documentId) return;
		outboxActiveRef.current = entry;

		// The latch is cleared EXACTLY ONCE, by whichever of the paths below runs
		// first, and always before the queue advances or the entry goes terminal.
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			if (outboxActiveRef.current === entry) outboxActiveRef.current = null;
		};

		const onAnswered = () => {
			release();
			if (outboxRef.current[0] !== entry) return false;
			outboxRef.current.shift();
			setPendingWriteCount(outboxRef.current.length);
			return true;
		};

		/**
		 * The write came back rejected. What that MEANS is the whole question.
		 *
		 * Convex retries offline and internal failures itself, so a rejection is
		 * never a lost response — but it is not automatically a permanent refusal
		 * either. An OCC conflict that outlived Convex's own retries, or an
		 * application rate limiter, will succeed on an identical later call; only
		 * a refusal the SERVER classified (a ConvexError carrying a `code`) can
		 * never succeed. Either way the queue stops and the entry stays at the
		 * head with its work pending and recoverable — but a transient failure is
		 * offered as Retry, and nothing is discarded for it.
		 */
		const onFailed = (kind: "commit" | "pointer", error: unknown) => {
			release();
			if (outboxRef.current[0] !== entry) return;
			const refusal = classifyRefusal(error);
			setBlockedWrite({
				kind,
				message: refusal.message,
				terminal: refusal.terminal,
				code: refusal.code,
				retryAfterMs: refusal.retryAfterMs,
				discards: summariseQueue(),
			});
			toast(
				refusal.terminal
					? "This change was refused. Your text is safe — see the status bar."
					: "Couldn't reach the server for this change. Your text is safe — see the status bar.",
				"error",
			);
		};

		if (entry.kind === "commit") {
			void commitEdit(entry.args)
				.then((result) => {
					if (!onAnswered()) return;
					if (result.committed) {
						confirmedPointerRevisionRef.current = Math.max(
							confirmedPointerRevisionRef.current,
							result.pointerRevision,
						);
						settleLocalMove(
							entry.moveToken,
							result.pointerRevision,
							result.updatedAt,
						);
					} else {
						// Another writer owns the head. Queue theirs so the next safe
						// moment adopts it; the writer is probably still mid-sentence,
						// and re-projecting under their caret is not an option.
						// Deliberately NOT advanced here: this is a head we have merely
						// been TOLD about, not one we have adopted. Taking it would let
						// a move still queued behind this commit pass the compare-and-set
						// and overwrite the winner.
						queueRemotePointer({
							nodeId: result.remoteHeadNodeId,
							revision: result.remotePointerRevision,
						});
						// The server has definitively refused this transition, so it is
						// resolved and reconciliation may replace it. Work it has NOT
						// answered stays untouchable.
						resyncProjectionIdRef.current = entry.projectionId;
						settleLocalMove(entry.moveToken, null);
					}
					pumpOutboxRef.current();
				})
				.catch((error) => onFailed("commit", error));
			return;
		}

		if (entry.kind === "pointer") {
			// Ordered by the server's own revision counter, not by a clock. The
			// wall-clock rule compared `Date.now()` here against a server-generated
			// `doc.updatedAt`: a slow browser clock, or an earlier queued markdown
			// write executing first, made the server reject a move the writer had
			// just made. `updatedAt` is still sent for clients of this mutation
			// that predate the compare-and-set.
			void updatePointer({
				documentId,
				currentNodeId: entry.nodeId,
				markdown: entry.markdown,
				wordCount: countWords(entry.markdown),
				updatedAt: Date.now(),
				// The revision this move FOLLOWS — what this client's own causal chain
				// has reached, never what it has merely been shown.
				//
				// Reading `documents.pointerRevision` off the latest snapshot let an
				// observation the client had deliberately IGNORED (a review accept on
				// another device, arriving while a local move was pending) become the
				// expectation, so a queued move passed the compare-and-set and
				// knocked the head off the accepted node. What advances this ref is
				// the whole guard: this client's own landed writes, and projections
				// it has actually adopted. Nothing else.
				expectedPointerRevision: confirmedPointerRevisionRef.current,
			})
				.then((result) => {
					if (!onAnswered()) return;
					if (result.applied) {
						confirmedPointerRevisionRef.current = Math.max(
							confirmedPointerRevisionRef.current,
							result.pointerRevision,
						);
					}
					if (result.applied) {
						// Only now is the queue known to be superseded. Clearing it
						// before the write would drop a remote head this move never
						// managed to overwrite.
						pendingRemotePointerRef.current = null;
						settleLocalMove(
							entry.moveToken,
							result.pointerRevision,
							result.updatedAt,
						);
					} else {
						// Refused by the compare-and-set: the server told us which head
						// won, and at which revision — keep both.
						queueRemotePointer({
							nodeId: result.currentNodeId,
							revision: result.pointerRevision,
						});
						resyncProjectionIdRef.current = entry.projectionId;
						settleLocalMove(entry.moveToken, null);
					}
					pumpOutboxRef.current();
				})
				.catch((error) => onFailed("pointer", error));
			return;
		}

		void createVersion({
			documentId,
			nodeId: entry.nodeId,
			label: entry.label,
			kind: entry.versionKind,
		})
			.then(() => {
				if (!onAnswered()) return;
				pumpOutboxRef.current();
			})
			.catch(() => {
				// A version tag names no text and nothing chains off it, so a refusal
				// is reported and the queue moves on. Holding the queue for it would
				// strand unrelated later writes behind a label.
				if (!onAnswered()) return;
				toast("Couldn't create that version.", "error");
				pumpOutboxRef.current();
			});
	}, [
		commitEdit,
		createVersion,
		documentId,
		queueRemotePointer,
		setBlockedWrite,
		settleLocalMove,
		summariseQueue,
		updatePointer,
	]);

	// The pump re-enters itself through a ref so a response answered under an
	// older render still reaches the current implementation.
	const pumpOutboxRef = useRef(pumpOutbox);
	pumpOutboxRef.current = pumpOutbox;

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
			nodesByIdRef.current = new Map(nodesByIdRef.current).set(
				node.nodeId,
				node,
			);
			setPointer(commit.nodeId);
			const projectionId = newProjectionId();
			const moveToken = startLocalMove(
				commit.nodeId,
				commit.markdown,
				projectionId,
			);
			publishProjection(commit.markdown, "local", 0, projectionId, {
				kind: "commit",
			});

			// One transaction: the node, the pointer, the markdown. See the
			// documents.commitEdit doc comment for why these can't be separate.
			enqueue({
				kind: "commit",
				moveToken,
				projectionId,
				args: {
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
					// The node's own id: stable, unique per commit, so the server
					// recognises Convex's own re-delivery as the same attempt.
					clientMutationId: commit.nodeId,
				},
			});
			debouncedAutoVersion();
		},
		[
			debouncedAutoVersion,
			documentId,
			enqueue,
			origin,
			publishProjection,
			setPointer,
			startLocalMove,
		],
	);

	// Hydrate the grouping controller once the DAG + pointer are known.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconcileTick is a retry signal, not a value the body reads — a failed ensureRoot bumps it to re-attempt hydration
	useEffect(() => {
		if (!enabled || !documentId) return;
		if (hydratedRef.current) return;
		if (dagRows === undefined || serverCurrentNodeId === undefined) return;

		// Legacy document with no nodes yet — create a root lazily (ADR-17 #1).
		if (dagRows.length === 0) {
			// A legacy document with no root cannot hydrate, so the pane stays in
			// loading and nothing typed can be committed — this call has to be
			// retried. Bounded, backing off, and reported once: an unbounded loop
			// hammered the server and raised a toast on every attempt.
			if (!ensureRootSentRef.current && !rootFailed) {
				ensureRootSentRef.current = true;
				const attemptToken = ensureRootTokenRef.current;
				void ensureRoot({ documentId }).catch(() => {
					if (attemptToken !== ensureRootTokenRef.current) return;
					ensureRootSentRef.current = false;
					ensureRootAttemptsRef.current += 1;
					if (ensureRootAttemptsRef.current >= ENSURE_ROOT_MAX_ATTEMPTS) {
						setRootFailed(true);
						toast(
							"Couldn't open this document's history. Reload to try again.",
							"error",
						);
						return;
					}
					const delay =
						ENSURE_ROOT_BASE_DELAY_MS *
						2 ** (ensureRootAttemptsRef.current - 1);
					ensureRootTimerRef.current = window.setTimeout(() => {
						if (attemptToken !== ensureRootTokenRef.current) return;
						ensureRootTimerRef.current = null;
						setReconcileTick((tick) => tick + 1);
					}, delay);
				});
			}
			return; // wait for the query to refetch with the root
		}

		// SAFETY: docNodes rows carry createdAt/origin/selection; the query type
		// is the narrower DocNode, so this widens to what the rows actually hold.
		const map = indexNodes(dagRows as HistoryNode[]);
		confirmedPointerRevisionRef.current = Math.max(
			confirmedPointerRevisionRef.current,
			serverPointerRevision ?? 0,
		);

		// Local input outranks anything from the server: keystrokes that landed
		// before the DAG resolved, or a draft recovered from storage. The recovery
		// result is a tagged flag rather than a non-empty string, because a draft
		// that deletes everything is still one the writer meant to keep.
		const pending = pendingRecordRef.current;
		pendingRecordRef.current = null;
		const recovered = getRecoveredDraft?.() ?? null;

		// A pointer move the server never confirmed, restored from storage.
		// Recovery reconstructed no queue entry for it, so the automatic markdown
		// save that follows hydration retired the recovered record and reported
		// "Saved" for a move the server never took. It is replayed instead, under
		// its STORED identity, so only its own acknowledgement can retire it.
		//
		// Not when keystrokes beat the DAG: those already rewrote the stored
		// record as a plain draft, so the id here could never be acknowledged, and
		// the writer has moved on from the move anyway.
		const recoveredPointer =
			recovered?.present &&
			recovered.kind === "pointer" &&
			recovered.pointerNodeId !== undefined &&
			recovered.projectionId !== undefined &&
			recovered.pointerNodeId !== serverCurrentNodeId &&
			pending === null
				? {
						nodeId: recovered.pointerNodeId,
						projectionId: recovered.projectionId,
					}
				: null;
		const replayPointer =
			recoveredPointer && map.has(recoveredPointer.nodeId)
				? recoveredPointer
				: null;
		// The target is not in the DAG: the commit that would have created it
		// never landed, so this move is dead and nobody can apply it. What
		// survives is the TEXT, so the record is demoted to a plain draft. Left
		// claiming a pointer move it would never be retired by anything — the
		// document would sit unsynced for ever and its own autosave could not
		// clear it.
		const demoteRecovered = recoveredPointer !== null && replayPointer === null;

		// Hydrate where the writer left off, which for a replayed move is its
		// target rather than the head the server is still showing.
		const headNodeId = replayPointer?.nodeId ?? serverCurrentNodeId;
		const rootMarkdown = map.has(headNodeId)
			? materialize(headNodeId, map)
			: (serverMarkdown ?? "");

		const controller = new GroupingController({
			rootNodeId: headNodeId,
			rootMarkdown,
			onCommit,
		});
		controllerRef.current = controller;
		setPointer(headNodeId);
		headNodeIdRef.current = headNodeId;
		hydratedRef.current = true;

		// First open goes through the SAME provenance rule as a remote update.
		// The sync hook cannot apply it — it has no DAG — so it leaves the editor
		// alone for us, and everything the writer ends up looking at is decided
		// here, once, with the tree in hand.
		const handle = getHandleRef.current();
		const editorText = handle?.getCanonicalMarkdown() ?? "";

		if (replayPointer) {
			if (editorText !== rootMarkdown) {
				handle?.seed(rootMarkdown, { programmatic: true });
			}
			const moveToken = startLocalMove(
				headNodeId,
				rootMarkdown,
				replayPointer.projectionId,
			);
			publishProjection(rootMarkdown, "local", 0, replayPointer.projectionId, {
				kind: "pointer",
				pointerNodeId: headNodeId,
			});
			enqueue({
				kind: "pointer",
				moveToken,
				projectionId: replayPointer.projectionId,
				nodeId: headNodeId,
				markdown: rootMarkdown,
			});
			return;
		}

		const localInput =
			pending?.markdown ?? (recovered?.present ? recovered.markdown : null);

		// Opening is the first thing this device has seen, so there is no earlier
		// baseline for the server to be newer than.
		const serverDraft = trustedServerDraft({
			headNodeId,
			materialized: rootMarkdown,
			serverMarkdown,
			serverMarkdownHeadNodeId,
			isNewerThanBaseline: true,
		});

		const shown = localInput ?? serverDraft ?? rootMarkdown;
		if (editorText !== shown) handle?.seed(shown, { programmatic: true });
		if (shown !== rootMarkdown) {
			// An OPEN draft on the node, not silent editor text: undo, a version
			// tag or an AI replacement all flush first, so this text becomes a real
			// child node instead of being dropped by the navigation.
			controller.record(shown, pending?.selection ?? null);
		}
		// Publish it either way — the pane renders from this, which is the only
		// way the text reaches a preview-only surface. `serverDerived` decides
		// whether it counts as saved: local input stays dirty until it is written.
		publishProjection(
			shown,
			localInput === null ? "server" : "recovered-draft",
			serverUpdatedAt ?? 0,
			undefined,
			demoteRecovered ? { kind: "draft" } : undefined,
		);
	}, [
		enabled,
		documentId,
		dagRows,
		enqueue,
		reconcileTick,
		rootFailed,
		serverCurrentNodeId,
		serverMarkdown,
		serverMarkdownHeadNodeId,
		serverPointerRevision,
		serverUpdatedAt,
		ensureRoot,
		getRecoveredDraft,
		onCommit,
		publishProjection,
		setPointer,
		startLocalMove,
	]);

	// Suppress grouping while a navigation re-projects state into the editor, so
	// undo/redo/branch-switch never grow the tree (they are pointer moves).
	const navigatingRef = useRef(false);

	const recordChange = useCallback(
		(opts?: { structural?: boolean }) => {
			if (navigatingRef.current) return;
			editorIdleRef.current = false;
			markEditorIdle();
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
		},
		[markEditorIdle],
	);

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
			setPointer(nodeId);
			// Release the guard after the async re-seed cascade (idle-rehydrate, etc.).
			window.setTimeout(() => {
				navigatingRef.current = false;
			}, 200);
			const projectionId = newProjectionId();
			const moveToken = startLocalMove(nodeId, markdown, projectionId);
			// A navigation changes no text, so a later content match cannot prove
			// it landed — two nodes can hold identical markdown.
			publishProjection(markdown, "local", 0, projectionId, {
				kind: "pointer",
				pointerNodeId: nodeId,
			});
			// Through the SAME queue as commits. Sent directly, this move would be
			// overtaken by a commit still waiting ahead of it, which silently
			// reversed an undo the writer had already performed.
			enqueue({
				kind: "pointer",
				moveToken,
				projectionId,
				nodeId,
				markdown,
			});
		},
		[
			documentId,
			enqueue,
			nodesById,
			publishProjection,
			setPointer,
			startLocalMove,
		],
	);

	const undo = useCallback(() => {
		if (!currentNodeIdRef.current) return;
		// Flush FIRST: an open draft (typed text, or a draft rescued from another
		// device) becomes a node here, and that node is what we undo from. Reading
		// the pointer before the flush would step back one level too far.
		controllerRef.current?.flush();
		const map = nodesByIdRef.current;
		const node = map.get(currentNodeIdRef.current ?? "");
		const parent = node?.parentNodeId;
		if (parent && map.has(parent)) navigateTo(parent);
	}, [navigateTo]);

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
			controllerRef.current?.flush();
			// Re-read after the flush: it may have just turned an open draft into
			// the node the writer actually means to tag.
			const id = currentNodeIdRef.current;
			if (!id) return;
			// Queued behind the commit that created this node. Sent directly, a tag
			// can reach the server before the node it names exists.
			enqueue({
				kind: "version",
				moveToken: null,
				projectionId: null,
				nodeId: id,
				label,
				versionKind: kind,
			});
		},
		[documentId, enqueue],
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
			// Close any open draft BEFORE claiming the origin. Setting it first gave
			// the writer's own pending text the `ai:<label>` tag and left the AI's
			// node tagged as an ordinary device edit — and, because `before` was
			// read ahead of the flush, an AI result identical to the current text
			// still looked like it had committed something.
			controller.flush();
			const before = controller.currentNodeId;
			if (opts?.origin) originOverrideRef.current = opts.origin;
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

	/**
	 * The head autosave may write against — null while a remote head is queued.
	 *
	 * Adopting the winner's head here would be worse than useless: this device's
	 * editor still holds ITS text, so passing the compare-and-set would write that
	 * text under the winner's branch, which is exactly what the CAS exists to
	 * stop. The head stays tied to what the editor and controller actually hold,
	 * and only `reconcileRemote` moves it — after the projection that makes it
	 * true.
	 */
	const getHeadNodeId = useCallback(
		() => (pendingRemotePointerRef.current ? null : headNodeIdRef.current),
		[],
	);
	const hasPendingDraft = useCallback(
		() => controllerRef.current?.hasPendingDraft ?? false,
		[],
	);

	/**
	 * The writer's way out of a refused write. Everything queued goes — the
	 * blocked entry, and everything behind it, which chains off a node the server
	 * never received — but the TEXT stays: the document is moved onto the head
	 * the server actually has, with what is on screen held as an open draft, so
	 * the next edit commits it as an ordinary child of that head.
	 */
	const retryBlockedWrite = useCallback(() => {
		if (blockedRef.current === null) return;
		const wait = blockedRef.current.retryAfterMs ?? 0;
		setBlockedWrite(null);
		if (wait <= 0) {
			pumpOutboxRef.current();
			return;
		}
		// A rate limiter told us how long to wait. Sending before that just earns
		// another refusal, so the retry the writer asked for is scheduled rather
		// than fired — this is the ONLY timer that re-sends anything, and only a
		// person can arm it.
		retryTimerRef.current = window.setTimeout(() => {
			retryTimerRef.current = null;
			pumpOutboxRef.current();
		}, wait);
	}, [setBlockedWrite]);

	const resolveBlockedWrite = useCallback(() => {
		if (blockedRef.current === null) return;
		const discarded = outboxRef.current;
		outboxRef.current = [];
		outboxActiveRef.current = null;
		setPendingWriteCount(0);
		setBlockedWrite(null);
		if (retryTimerRef.current !== null) {
			window.clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		// Every discarded identity is answered, so nothing is left waiting on a
		// write that will never be sent. Refused, never accepted, so no text is
		// reported saved on the strength of this.
		for (const entry of discarded) settleLocalMove(entry.moveToken, null);
		localMoveRef.current = null;
		inFlightRef.current.clear();
		resyncProjectionIdRef.current = null;

		// The discarded commits created nodes the server never received. Left in
		// the local tree they still show in the history panel, and clicking one
		// sends a pointer to a node the server does not have — blocking the
		// document all over again.
		const orphaned = new Set(
			discarded.flatMap((entry) =>
				entry.kind === "commit" ? [entry.args.node.nodeId] : [],
			),
		);
		if (orphaned.size > 0) {
			setLocalNodes((prev) => prev.filter((n) => !orphaned.has(n.nodeId)));
			const pruned = new Map(nodesByIdRef.current);
			for (const nodeId of orphaned) pruned.delete(nodeId);
			nodesByIdRef.current = pruned;
		}

		// Move onto the server's head. The editor is deliberately NOT re-seeded:
		// the whole point is that the writer keeps what they were looking at.
		const serverHead = serverCurrentNodeId ?? currentNodeIdRef.current;
		const map = nodesByIdRef.current;
		if (!serverHead || !map.has(serverHead)) return;
		let materialized: string;
		try {
			materialized = materialize(serverHead, map);
		} catch {
			return;
		}
		const controller = controllerRef.current;
		controller?.setCurrent(serverHead, materialized);
		setPointer(serverHead);
		headNodeIdRef.current = serverHead;
		pendingRemotePointerRef.current = null;
		confirmedPointerRevisionRef.current = Math.max(
			confirmedPointerRevisionRef.current,
			serverPointerRevision ?? 0,
		);

		// Say what is now true of the recovery record, rather than leaving it
		// describing work that no longer exists. A refused POINTER move between
		// two nodes with identical text used to leave its record dirty and its
		// projection pending: the button cleared the blocked state, the document
		// stayed unsynced, and the next reload replayed the very move the writer
		// had just discarded.
		const onScreen =
			getHandleRef.current()?.getCanonicalMarkdown() ?? materialized;
		if (onScreen === materialized) {
			// Nothing is unsaved: the server's head IS what is on screen. Publish it
			// as the server's state, naming the pending work it settles, so the
			// record is cleared instead of surviving the reload.
			publishProjection(
				materialized,
				"server",
				serverUpdatedAt ?? 0,
				undefined,
				{ resolvedProjectionId: getPendingProjectionId?.() ?? undefined },
			);
		} else {
			// The writer's text differs from the head, so it IS unsaved — but as an
			// ordinary draft under a fresh identity, not as the commit or move that
			// was just given up.
			controller?.record(onScreen, null);
			publishProjection(onScreen, "local", 0, newProjectionId(), {
				kind: "draft",
			});
		}
		setReconcileTick((tick) => tick + 1);
	}, [
		getPendingProjectionId,
		publishProjection,
		serverCurrentNodeId,
		serverPointerRevision,
		serverUpdatedAt,
		setBlockedWrite,
		setPointer,
		settleLocalMove,
	]);

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

	/**
	 * Project the queued remote state into the editor, the grouping controller
	 * and the pointer TOGETHER, or defer. One function so those three can never
	 * disagree: adoption used to move the pointer while leaving the editor
	 * showing the old text, and the sync hook re-seeded on a separate path.
	 *
	 * Returns false when it deferred, which is the caller's signal NOT to mark
	 * the remote revision handled.
	 */
	const reconcileRemote = useCallback((): boolean => {
		// A markdown-only update moves no pointer, so nothing queues one — but a
		// newer trusted draft at the head we are already on is still a change the
		// writer must see. Treat the current head as an implicit target.
		// A remote move we decided to adopt, if there is one. Only THIS is a fact
		// about the pointer; the fallback below is not.
		const queued = pendingRemotePointerRef.current;
		const target =
			queued ??
			(currentNodeIdRef.current
				? {
						nodeId: currentNodeIdRef.current,
						revision: serverPointerRevision ?? 0,
					}
				: null);
		if (target === null) return true; // nothing outstanding

		const map = nodesByIdRef.current;
		if (!map.has(target.nodeId)) return false; // node not synced yet

		let materialized: string;
		try {
			materialized = materialize(target.nodeId, map);
		} catch {
			return false;
		}

		// The other device's autosave can be AHEAD of its last node: a writer who
		// never pauses long enough to close a grouping boundary has their text in
		// documents.markdown and nowhere else. Projecting the node's text would
		// erase it, and accepting that as the sync baseline would then overwrite
		// it on this device's next save.
		//
		// Trusting it needs PROVENANCE, though. `markdownHeadNodeId` is the head
		// the stored markdown was written against; when it is absent (a legacy
		// client saving without the compare-and-set) or names a different head,
		// that text may belong to another branch entirely and must never be
		// promoted into this one. Then the node's own materialization is the only
		// thing we know to be true.
		const draft = trustedServerDraft({
			headNodeId: target.nodeId,
			materialized,
			serverMarkdown,
			serverMarkdownHeadNodeId,
			isNewerThanBaseline:
				(serverUpdatedAt ?? 0) > (getBaselineUpdatedAt?.() ?? 0),
		});
		const trustedDraft = draft !== null;
		const editorText = draft ?? materialized;

		const alreadyThere = target.nodeId === currentNodeIdRef.current;
		// The pointer has not moved and there is no newer trusted draft to show:
		// the observation is already reflected here.
		if (alreadyThere && !trustedDraft) {
			pendingRemotePointerRef.current = null;
			// Only a remote move we actually reconciled with advances the chain.
			// The fallback target above carries `documents.pointerRevision` off the
			// latest snapshot, which may be somebody ELSE's move that this client
			// has not adopted — taking it let a queued move pass the CAS against a
			// head it had never seen.
			if (queued) {
				confirmedPointerRevisionRef.current = Math.max(
					confirmedPointerRevisionRef.current,
					queued.revision,
				);
			}
			return true;
		}

		// Never re-project over text the tree has not captured: those keystrokes
		// exist nowhere else yet.
		if (controllerRef.current?.hasPendingDraft) return false;
		// Nor over work the server has not answered. Once a draft closes into a
		// node, hasPendingDraft goes quiet while that node may still be stuck
		// behind a failed pointer move — projecting then discarded it.
		const pendingId = getPendingProjectionId?.() ?? null;
		if (pendingId !== null && pendingId !== resyncProjectionIdRef.current) {
			return false;
		}
		// Idle, not unfocused. In vim and full-screen the editor keeps DOM focus
		// forever, so a focus gate would defer this indefinitely.
		if (!editorIdleRef.current) return false;

		// A preview-only pane registers no writable handle, but the projection is
		// PUBLISHED to the pane and rendered from there, so it does reach the
		// writer either way. Seed when there is somewhere to seed; never make the
		// projection conditional on it, or a preview pane would sit on stale text
		// forever waiting for an editor it does not have.
		const handle = getHandleRef.current();
		navigatingRef.current = true;
		if (handle && !handle.readOnly) {
			const caretBefore = handle.exportCaret().head;
			handle.seed(editorText, { programmatic: true });
			// The remote text is a different document; the old offset may not exist
			// in it, so clamp rather than dropping the caret to the top.
			handle.importCaret(caretAtOffset(caretBefore, editorText.length));
		}
		controllerRef.current?.setCurrent(target.nodeId, materialized);
		if (trustedDraft) {
			// Hold the rescued draft as an OPEN draft on the node, not as silent
			// editor text. Every path that leaves this state — undo, branch switch,
			// version tag, mode switch — flushes first, so the draft becomes a real
			// child node instead of being discarded by the navigation.
			controllerRef.current?.record(editorText, null);
		}
		setPointer(target.nodeId);
		headNodeIdRef.current = target.nodeId;
		pendingRemotePointerRef.current = null;
		// ADOPTED, not merely observed: this device is now on that state, so the
		// next move it makes genuinely follows this revision. Same rule as above —
		// only a queued remote move is a pointer fact.
		if (queued) {
			confirmedPointerRevisionRef.current = Math.max(
				confirmedPointerRevisionRef.current,
				queued.revision,
			);
		}
		window.setTimeout(() => {
			navigatingRef.current = false;
		}, 200);

		// The sync hook must accept what is ON SCREEN as the new baseline, or it
		// will flush the projected text back as though the writer had typed it —
		// and if that text were the materialization, the flush would clobber the
		// draft this projection just rescued.
		// If this projection is the resolution of a refused transition, say so:
		// the server kept this state INSTEAD of that move, which settles it.
		publishProjection(editorText, "server", serverUpdatedAt ?? 0, undefined, {
			resolvedProjectionId: resyncProjectionIdRef.current ?? undefined,
		});
		resyncProjectionIdRef.current = null;
		toast("Updated from another device", "info");
		return true;
	}, [
		getBaselineUpdatedAt,
		getPendingProjectionId,
		publishProjection,
		serverMarkdown,
		serverMarkdownHeadNodeId,
		serverPointerRevision,
		serverUpdatedAt,
		setPointer,
	]);

	// Decide what the latest server observation means, then try to apply it.
	//
	// Deciding to adopt and being able to adopt are separate: uncommitted local
	// text, an active writer, or a node that has not synced all defer the
	// projection. Whatever cannot be applied now is QUEUED rather than dropped —
	// this effect only re-runs on its own dependencies, so a pointer skipped once
	// used to be skipped forever, and with commitEdit's head check that would
	// leave a writer diverging on every commit with no way back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconcileTick is a re-run signal, not a value the body reads — settling a move, idling, or blurring bumps it so a queued pointer is reconsidered
	useEffect(() => {
		if (!hydratedRef.current) return;
		if (serverCurrentNodeId === undefined) return;
		if (serverPointerRevision === undefined) return;

		// NOTHING advances the compare-and-set expectation here. This effect sees
		// every snapshot, including the ones `decideServerPointer` is about to
		// ignore because a local move is still pending — and taking a revision
		// from one of those let a queued move pass the CAS against a head it had
		// never seen, silently reversing another device's review accept. Only a
		// projection this client ADOPTS advances the chain (see reconcileRemote).

		const decision = decideServerPointer({
			serverCurrentNodeId,
			serverPointerRevision,
			localMove: localMoveRef.current,
		});
		// Our own move is still resolving; it decides the pointer, not the server.
		if (decision === "ignore") return;
		localMoveRef.current = null;
		if (decision === "settled") {
			// The server is on our node, so anything queued has been overtaken.
			pendingRemotePointerRef.current = null;
			return;
		}
		// Queue EVERY observation, including one naming the head we are already on:
		// a newer revision pointing back at our own head is how a queued pointer
		// that has since been superseded gets cleared. Filtering those out left
		// stale targets in the queue waiting to be projected.
		queueRemotePointer({
			nodeId: serverCurrentNodeId,
			revision: serverPointerRevision,
		});
		reconcileRemote();
	}, [
		serverCurrentNodeId,
		serverPointerRevision,
		nodesById,
		queueRemotePointer,
		reconcileRemote,
		reconcileTick,
	]);

	// A projection deferred for want of a writable editor (preview-only pane) has
	// nothing else to wake it: no query changes, no keystroke, no blur. Poll while
	// something is queued, and stop as soon as it lands.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconcileTick re-arms the poll after each attempt
	useEffect(() => {
		if (pendingRemotePointerRef.current === null) return;
		const timer = window.setInterval(() => {
			if (pendingRemotePointerRef.current === null) return;
			const handle = getHandleRef.current();
			if (!handle || handle.readOnly) return;
			setReconcileTick((tick) => tick + 1);
		}, HANDLE_RETRY_MS);
		return () => window.clearInterval(timer);
	}, [reconcileTick, serverCurrentNodeId, serverPointerRevision]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: teardown reads live refs; the debounced callbacks are stable
	useEffect(() => {
		return () => {
			// The grouping controller goes FIRST. Its idle timer is the one thing
			// here that can still create work: left armed, it fired after teardown,
			// published a recovery id through a host that no longer exists, and
			// sent a commit for a document the writer had already closed — which a
			// reopened host then had to reconcile against.
			controllerRef.current?.dispose();
			controllerRef.current = null;

			outboxRef.current = [];
			outboxActiveRef.current = null;
			inFlightRef.current.clear();
			if (retryTimerRef.current !== null) {
				window.clearTimeout(retryTimerRef.current);
				retryTimerRef.current = null;
			}
			// Every other hook-owned timer, so nothing survives to touch state or
			// storage behind us.
			markEditorIdle.cancel();
			debouncedAutoVersion.cancel();
			// Invalidate first, then cancel: an in-flight ensureRoot rejection has
			// no timer to clear and would otherwise schedule a new one after the
			// hook is gone.
			ensureRootTokenRef.current += 1;
			if (ensureRootTimerRef.current === null) return;
			window.clearTimeout(ensureRootTimerRef.current);
			ensureRootTimerRef.current = null;
		};
	}, []);

	// Leaving the editor is an extra chance to reconcile, on top of the idle
	// timer. `focusout` bubbles where `blur` does not, so one window listener
	// covers every lens; the ref check keeps unrelated focus changes free.
	useEffect(() => {
		const onFocusOut = () => {
			if (pendingRemotePointerRef.current === null) return;
			editorIdleRef.current = true;
			setReconcileTick((tick) => tick + 1);
		};
		window.addEventListener("focusout", onFocusOut);
		return () => window.removeEventListener("focusout", onFocusOut);
	}, []);

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
		getHeadNodeId,
		hasPendingWrites: pendingWriteCount > 0,
		blockedWrite,
		retryBlockedWrite,
		resolveBlockedWrite,
		hasPendingDraft,
		reconcileRemote,
	};
}
