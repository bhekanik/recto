"use client";

import { useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import { countWords } from "@/lib/markdown";
import {
	clearDraft,
	isOwnDraftOrigin,
	loadDraft,
	newProjectionId,
	reconcileDraft,
	saveDraft,
} from "@/lib/sync/draft-buffer";

export const DEBOUNCE_MS = 500;

/**
 * `unsynced` is ordinary: we have work the server has not confirmed, and it
 * clears on its own — Convex keeps a mutation pending across a disconnection
 * and retries until the server answers. `unresolved` is the one that needs the
 * writer: the server REFUSED a write, so it will never clear by waiting.
 */
export type SyncStatus =
	| "idle"
	| "saving"
	| "saved"
	| "unsynced"
	| "unresolved";

/** A local draft restored from storage. `present: false` means there was none. */
export type RecoveredDraft = {
	present: boolean;
	markdown: string;
	/**
	 * The work's identity and kind, carried across the reload. Without them the
	 * history hook cannot tell a recovered POINTER move from plain text, so it
	 * rebuilt no queue entry and the next markdown acknowledgement retired the
	 * move — reporting "Saved" for a pointer the server never took.
	 */
	projectionId?: string;
	kind?: PendingProjection["kind"];
	/** For pointer work: the node the move was trying to reach. */
	pointerNodeId?: string;
};

/** Unsaved work waiting on the server. */
export type PendingProjection = {
	id: string;
	/**
	 * `draft` is plain autosaved markdown; `commit` is a node the undo tree
	 * created; `pointer` is a move that changes no text at all. They are not
	 * interchangeable: matching content proves a DRAFT was reverted, but a node
	 * commit is a separate fact the server must confirm, and a pointer move
	 * changes nothing a content match could speak for.
	 */
	kind: "draft" | "commit" | "pointer";
	markdown: string;
	/** For pointer work: the node the move was trying to reach. */
	pointerNodeId?: string;
};

type UseDocumentSyncArgs = {
	documentId: Id<"documents"> | null;
	getEditorHandle: () => EditorHandle | null;
	serverMarkdown: string | undefined;
	serverUpdatedAt: number | undefined;
	/**
	 * `documents.currentNodeId`. Draft recovery judges a stored POINTER move
	 * against the head the SERVER is on, which is the only thing that can say
	 * whether the move landed. It used to be handed this device's own head,
	 * which is still null while recovery runs, so the check never fired.
	 */
	serverCurrentNodeId?: string | undefined;
	enabled: boolean;
	deriveTitle?: (markdown: string) => string | undefined;
	isManualTitle?: boolean;
	/**
	 * The undo-tree head this device's text belongs to, read at flush time. The
	 * server rejects a draft written against a head another device has moved on
	 * from, so this is what keeps `documents.markdown` in step with
	 * `documents.currentNodeId` (ADR-19).
	 */
	getCurrentHeadNodeId?: () => string | null;
	/** Local keystrokes the undo tree has not captured yet (history hook). */
	getHasPendingDraft?: () => boolean;
	/**
	 * Ask the history hook to project the server's undo-tree state into the
	 * editor. Returns false when it deferred, in which case this hook must not
	 * mark the revision handled — the projection is retried.
	 */
	reconcileRemote?: () => boolean;
};

type UseDocumentSyncResult = {
	wordCount: number;
	syncStatus: SyncStatus;
	pendingConflict: boolean;
	handleEditorChange: () => void;
	flushSync: () => Promise<void>;
	flushMarkdown: (markdown: string) => Promise<void>;
	getCurrentMarkdown: () => string;
	/** Called by the history hook once it has projected remote state (R3). */
	acceptRemoteProjection: (
		markdown: string,
		serverUpdatedAt: number,
		resolvedProjectionId?: string,
	) => void;
	/** The server revision the editor currently reflects (ADR-19, Y1). */
	getBaselineUpdatedAt: () => number;
	/** A draft restored from storage on open, resolved without an editor. */
	getRecoveredDraft: () => RecoveredDraft | null;
	/** The unsaved work on screen, or null when everything is acknowledged. */
	getPendingProjectionId: () => string | null;
	/** Report a recovered draft the history hook has put on screen (unsaved). */
	adoptRecoveredDraft: (
		markdown: string,
		kindOverride?: PendingProjection["kind"],
	) => void;
	/** A local transition is on screen but the server has not taken it yet. */
	markLocalProjectionPending: (
		markdown: string,
		projectionId: string,
		kind: "draft" | "commit" | "pointer",
		pointerNodeId?: string,
	) => void;
	/** That transition was accepted (or refused) by the server. */
	settleLocalProjection: (settled: {
		projectionId: string;
		markdown: string;
		serverUpdatedAt: number;
		ok: boolean;
	}) => void;
};

/** Whether a reactive query update is from a remote writer (not this client's echo). */
export function isRemoteServerUpdate(
	serverUpdatedAt: number,
	lastWrittenUpdatedAt: number,
	expectedUpdatedAt: number,
): boolean {
	if (serverUpdatedAt <= lastWrittenUpdatedAt) return false;
	if (serverUpdatedAt === expectedUpdatedAt) return false;
	return true;
}

/** Debounced editor↔Convex sync with D11 hydrate-on-idle contract. */
export function useDocumentSync({
	documentId,
	getEditorHandle,
	serverMarkdown,
	serverUpdatedAt,
	serverCurrentNodeId,
	enabled,
	deriveTitle,
	isManualTitle = false,
	getCurrentHeadNodeId,
	getHasPendingDraft,
	reconcileRemote,
}: UseDocumentSyncArgs): UseDocumentSyncResult {
	const updateMarkdown = useMutation(api.documents.updateMarkdown);

	const [wordCount, setWordCount] = useState(0);
	const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
	const [pendingConflict, setPendingConflict] = useState(false);

	const expectedUpdatedAtRef = useRef<number>(0);
	// The server revision the EDITOR is actually showing. Distinct from
	// expectedUpdatedAtRef, which is a compare-and-set token: that one advances
	// when a remote update is DEFERRED, so that a later save can still pass the
	// CAS. Using it to answer "is this newer than what the writer sees" made a
	// deferred projection look already-seen and project stale text over a draft.
	const projectedBaselineUpdatedAtRef = useRef<number>(0);
	const lastWrittenUpdatedAtRef = useRef<number>(0);
	const lastHandledServerUpdatedAtRef = useRef<number>(0);
	const hasSeededRef = useRef(false);
	// Draft recovery is resolved from storage alone. Gating it on an editor
	// handle lost the draft entirely when the only pane was preview (which
	// registers no handle), and `present` is a flag rather than a non-empty
	// string because deleting everything is a draft a writer meant to keep.
	const recoveredRef = useRef<RecoveredDraft | null>(null);
	// The unsaved work currently on screen. Acknowledgements match on its id,
	// never on text: equality cannot tell our own write coming back from
	// someone else's that happens to carry the same words, and a stale host
	// acknowledging an old commit would otherwise clear a newer draft.
	//
	// `kind` matters because two nodes can hold identical markdown: a content
	// match proves a text draft was reverted, but says nothing about whether a
	// pointer move landed, so it must never retire pointer work.
	const pendingProjectionRef = useRef<PendingProjection | null>(null);
	// The newest server revision any acknowledgement has accepted. Only the
	// owner of that revision may declare what the server now holds.
	const lastAcceptedRevisionRef = useRef(0);
	const pendingMarkdownRef = useRef<string | null>(null);
	const flushInFlightRef = useRef(false);
	const pendingFlushAfterInFlightRef = useRef(false);
	// null means "nothing has been flushed yet", which "" cannot express: an
	// intentionally empty recovered draft equalled the initial value and was
	// skipped by the no-op fast path, so it was never written.
	const lastFlushedMarkdownRef = useRef<string | null>(null);
	const getEditorHandleRef = useRef(getEditorHandle);
	getEditorHandleRef.current = getEditorHandle;

	// Reset seed state when document changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on document switch
	useEffect(() => {
		hasSeededRef.current = false;
		expectedUpdatedAtRef.current = 0;
		lastWrittenUpdatedAtRef.current = 0;
		lastHandledServerUpdatedAtRef.current = 0;
		lastFlushedMarkdownRef.current = null;
		projectedBaselineUpdatedAtRef.current = 0;
		recoveredRef.current = null;
		pendingProjectionRef.current = null;
		lastAcceptedRevisionRef.current = 0;
	}, [documentId]);

	/**
	 * Record where the server got to. Revisions only ever move forwards, and
	 * only the acknowledgement that owns the newest accepted revision may say
	 * what the server now holds — an older completion arriving late would
	 * otherwise declare its stale text to be the current baseline.
	 */
	const observeServerRevision = useCallback(
		(serverUpdatedAt: number, markdown: string | null) => {
			if (serverUpdatedAt <= 0) return;
			expectedUpdatedAtRef.current = Math.max(
				expectedUpdatedAtRef.current,
				serverUpdatedAt,
			);
			lastWrittenUpdatedAtRef.current = Math.max(
				lastWrittenUpdatedAtRef.current,
				serverUpdatedAt,
			);
			lastHandledServerUpdatedAtRef.current = Math.max(
				lastHandledServerUpdatedAtRef.current,
				serverUpdatedAt,
			);
			projectedBaselineUpdatedAtRef.current = Math.max(
				projectedBaselineUpdatedAtRef.current,
				serverUpdatedAt,
			);
			if (markdown === null) return;
			if (serverUpdatedAt < lastAcceptedRevisionRef.current) return;
			lastAcceptedRevisionRef.current = serverUpdatedAt;
			lastFlushedMarkdownRef.current = markdown;
		},
		[],
	);

	/**
	 * Retire the pending work an acknowledgement names, if it is still ours to
	 * retire. BOTH the in-memory record and the stored one must name it: the
	 * stored copy is shared across hosts, so a host acknowledging its own old
	 * write would otherwise delete a draft another host had written since.
	 */
	const retirePending = useCallback(
		(
			projectionId: string,
			opts?: { onlyKinds: ReadonlyArray<PendingProjection["kind"]> },
		): boolean => {
			if (!documentId) return false;
			const pending = pendingProjectionRef.current;
			if (pending?.id !== projectionId) return false;
			// Each kind of work is retired by its OWN acknowledgement. A markdown
			// write proves the text reached the server; it proves nothing about a
			// node commit or a pointer move, and after a reload the recovered
			// pointer work carries the id the autosave then reuses — so without
			// this the automatic save deleted the recovery record and reported
			// "Saved" for a move the server never took.
			if (opts && !opts.onlyKinds.includes(pending.kind)) return false;
			const stored = loadDraft(documentId);
			if (!stored || stored.projectionId !== projectionId) return false;
			pendingProjectionRef.current = null;
			pendingMarkdownRef.current = null;
			clearDraft(documentId);
			setSyncStatus("saved");
			return true;
		},
		[documentId],
	);

	const performFlush = useCallback(
		async (
			markdownOverride?: string,
		): Promise<"done" | "skipped" | "retry"> => {
			if (!documentId) return "skipped";

			const markdown =
				markdownOverride ??
				getEditorHandleRef.current()?.getCanonicalMarkdown() ??
				pendingMarkdownRef.current ??
				"";
			const words = countWords(markdown);
			setWordCount(words);
			pendingMarkdownRef.current = markdown;

			const expected = expectedUpdatedAtRef.current;
			if (expected === 0) return "skipped";

			// R1: without a head there is no compare-and-set, and a headless write
			// would land under whichever branch currently owns the document. The
			// draft stays dirty; workspace-context re-flushes once history hydrates.
			if (getCurrentHeadNodeId && getCurrentHeadNodeId() === null) {
				setSyncStatus("unsynced");
				return "skipped";
			}

			// The text already matches what the server holds, so there is nothing
			// to write. That proves a TEXT draft was reverted; it proves nothing
			// about a pointer move, because two nodes can carry identical markdown
			// and retiring pointer work here lost an undo the server never took.
			if (markdown === lastFlushedMarkdownRef.current) {
				const pending = pendingProjectionRef.current;
				// Only a plain autosaved DRAFT. A node commit is a separate fact —
				// the tree gained a node — that an identical body says nothing about,
				// and retiring it here reported an unsaved node as saved.
				if (pending && pending.kind === "draft") {
					retirePending(pending.id);
				} else if (!pending) {
					pendingMarkdownRef.current = null;
					setSyncStatus("saved");
				}
				return "done";
			}

			// Claim identity only now, with a write actually going out. Creating it
			// earlier marked the document dirty on every no-op flush, which left a
			// pending id nothing would ever acknowledge.
			if (pendingProjectionRef.current === null) {
				const id = newProjectionId();
				pendingProjectionRef.current = { id, kind: "draft", markdown };
				saveDraft(documentId, markdown, id);
			}
			const projectionId = pendingProjectionRef.current.id;
			setSyncStatus("saving");

			try {
				const derivedTitle =
					!isManualTitle && deriveTitle ? deriveTitle(markdown) : undefined;
				const result = await updateMarkdown({
					documentId,
					markdown,
					wordCount: words,
					expectedUpdatedAt: expected,
					title: derivedTitle,
					expectedHeadNodeId: getCurrentHeadNodeId?.() ?? undefined,
				});

				if (result.headMoved) {
					// Another device owns the head now. Retrying would republish this
					// draft on top of their branch, detaching documents.markdown from
					// documents.currentNodeId.
					//
					// The draft deliberately stays DIRTY. Only a completed projection
					// clears it (acceptRemoteProjection): dropping it here would
					// discard the writer's text before anything had replaced it.
					setSyncStatus("unsynced");
					return "done";
				}

				if (result.stale) {
					observeServerRevision(result.updatedAt, null);
					return "retry";
				}

				observeServerRevision(result.updatedAt, markdown);
				// Only retire what this write actually carried, and only if what it
				// carried was a plain text draft. The writer may have typed on while
				// it was in flight, and that text is still unsaved.
				retirePending(projectionId, { onlyKinds: ["draft"] });
				return "done";
			} catch {
				setSyncStatus("unsynced");
				return "done";
			}
		},
		[
			documentId,
			deriveTitle,
			getCurrentHeadNodeId,
			isManualTitle,
			observeServerRevision,
			retirePending,
			updateMarkdown,
		],
	);

	const runFlush = useCallback(
		async (markdownOverride?: string) => {
			if (flushInFlightRef.current) {
				pendingFlushAfterInFlightRef.current = true;
				return;
			}

			flushInFlightRef.current = true;
			try {
				do {
					pendingFlushAfterInFlightRef.current = false;
					let outcome = await performFlush(markdownOverride);
					markdownOverride = undefined;
					while (outcome === "retry") {
						outcome = await performFlush();
					}
				} while (pendingFlushAfterInFlightRef.current);
			} finally {
				flushInFlightRef.current = false;
			}
		},
		[performFlush],
	);

	const flush = useCallback(async () => {
		await runFlush();
	}, [runFlush]);

	// maxWait guarantees a flush even while the writer never pauses (D11 safety
	// net): a continuous typist still persists at least every ~5s.
	const debouncedFlush = useDebouncedCallback(flush, DEBOUNCE_MS, {
		maxWait: 5000,
	});

	const flushMarkdown = useCallback(
		async (markdown: string) => {
			debouncedFlush.cancel();
			await runFlush(markdown);
		},
		[debouncedFlush, runFlush],
	);

	const flushSync = useCallback(async () => {
		debouncedFlush.cancel();
		await flush();
		while (flushInFlightRef.current) {
			await new Promise((r) => setTimeout(r, 10));
		}
	}, [debouncedFlush, flush]);

	const getBaselineUpdatedAt = useCallback(
		() => projectedBaselineUpdatedAtRef.current,
		[],
	);

	const getCurrentMarkdown = useCallback(() => {
		return (
			getEditorHandleRef.current()?.getCanonicalMarkdown() ??
			pendingMarkdownRef.current ??
			""
		);
	}, []);

	const handleEditorChange = useCallback(() => {
		const editorRef = getEditorHandleRef.current();
		if (!editorRef) return;
		const markdown = editorRef.getCanonicalMarkdown();
		const words = countWords(markdown);
		setWordCount(words);
		// Typing supersedes whatever was pending: a later acknowledgement of the
		// older work must not retire this text.
		const projectionId = newProjectionId();
		pendingProjectionRef.current = {
			id: projectionId,
			kind: "draft",
			markdown,
		};
		if (documentId) {
			saveDraft(documentId, markdown, projectionId, { kind: "draft" });
		}
		pendingMarkdownRef.current = markdown;
		setSyncStatus("unsynced");
		debouncedFlush();
	}, [debouncedFlush, documentId]);

	// Resolve draft recovery on open. Deliberately NOT gated on an editor
	// handle: a preview-only pane registers none, and waiting for one meant the
	// draft was never recovered at all — history then read an empty editor as
	// "no local input", accepted server text, and cleared the draft from storage.
	useEffect(() => {
		if (!enabled || !documentId || serverMarkdown === undefined) return;
		if (hasSeededRef.current) return;

		const {
			markdown,
			hadConflict,
			draftOrigin,
			pendingPointerNodeId,
			projectionId,
			projectionKind,
		} = reconcileDraft(
			serverMarkdown,
			serverUpdatedAt ?? 0,
			documentId,
			serverCurrentNodeId,
		);
		// A draft that deletes everything is still a draft the writer meant to
		// keep, so presence is a flag rather than "the text is non-empty" — and a
		// pending POINTER move is present even though its text matches the
		// server's exactly, because a move changes no text at all.
		const present = markdown !== serverMarkdown || pendingPointerNodeId != null;
		recoveredRef.current = {
			present,
			markdown,
			projectionId,
			kind: projectionKind,
			pointerNodeId: pendingPointerNodeId,
		};

		expectedUpdatedAtRef.current = serverUpdatedAt ?? 0;
		lastWrittenUpdatedAtRef.current = serverUpdatedAt ?? 0;
		lastHandledServerUpdatedAtRef.current = serverUpdatedAt ?? 0;
		hasSeededRef.current = true;

		if (present && hadConflict && !isOwnDraftOrigin(draftOrigin)) {
			setPendingConflict(true);
		}

		// With a projection owner, the history hook decides what reaches the
		// editor — it is the only thing that can tell a trustworthy draft from a
		// legacy body. Without one (the reviewer surface) this hook still seeds.
		if (reconcileRemote) return;

		const trySeed = (): boolean => {
			const editorRef = getEditorHandleRef.current();
			if (!editorRef) return false;
			editorRef.seed(markdown, { programmatic: true });
			setWordCount(countWords(markdown));
			lastFlushedMarkdownRef.current = markdown;
			projectedBaselineUpdatedAtRef.current = serverUpdatedAt ?? 0;
			return true;
		};
		if (trySeed()) return;
		const interval = window.setInterval(() => {
			if (trySeed()) window.clearInterval(interval);
		}, 50);
		return () => window.clearInterval(interval);
	}, [
		enabled,
		documentId,
		reconcileRemote,
		serverCurrentNodeId,
		serverMarkdown,
		serverUpdatedAt,
	]);

	const getRecoveredDraft = useCallback(() => recoveredRef.current, []);

	/**
	 * A local transition (an AI accept, a version restore, an undo) is showing,
	 * but the server has not acknowledged it. Programmatic seeds never reach
	 * `handleEditorChange`, so without this nothing would mark them dirty: a
	 * rejected commit would lose the text on reload, with no recovery copy and a
	 * status still reading "saved".
	 */
	const markLocalProjectionPending = useCallback(
		(
			markdown: string,
			projectionId: string,
			kind: "draft" | "commit" | "pointer",
			pointerNodeId?: string,
		) => {
			setWordCount(countWords(markdown));
			pendingMarkdownRef.current = markdown;
			pendingProjectionRef.current = {
				id: projectionId,
				kind,
				markdown,
				pointerNodeId,
			};
			// The kind is persisted too: on reload a pointer move must still be
			// recognisable as one, or recovery judges it by its body and throws it
			// away.
			if (documentId) {
				saveDraft(documentId, markdown, projectionId, { kind, pointerNodeId });
			}
			setSyncStatus("unsynced");
		},
		[documentId],
	);

	/** The server took it (or did not). Only success may retire the draft. */
	const settleLocalProjection = useCallback(
		(settled: {
			projectionId: string;
			markdown: string;
			serverUpdatedAt: number;
			ok: boolean;
		}) => {
			if (!settled.ok) return; // stays dirty, stays recoverable
			observeServerRevision(settled.serverUpdatedAt, settled.markdown);
			retirePending(settled.projectionId);
		},
		[observeServerRevision, retirePending],
	);

	const getPendingProjectionId = useCallback(
		() => pendingProjectionRef.current?.id ?? null,
		[],
	);

	/**
	 * The history hook has projected a recovered local draft. It is UNSAVED — the
	 * server has never seen it — so it must be reported dirty and its storage
	 * copy kept until a write actually succeeds. Treating it as flushed lost the
	 * draft on the next open: cleared from storage, never sent.
	 */
	const adoptRecoveredDraft = useCallback(
		(markdown: string, kindOverride?: PendingProjection["kind"]) => {
			setWordCount(countWords(markdown));
			pendingMarkdownRef.current = markdown;
			// Adopt the STORED identity, not a fresh one. Without it the next flush
			// saw nothing pending, claimed a new id and re-stamped the record as a
			// plain draft — which erased the fact that a pointer move was still
			// waiting, and the reload after that threw it away.
			const stored = documentId ? loadDraft(documentId) : null;
			if (!documentId || !stored?.projectionId) {
				setSyncStatus("unsynced");
				return;
			}
			// The history hook may DEMOTE recovered pointer work whose target no
			// longer exists in the tree: nothing can apply that move, so only the
			// text is left. Storage has to agree, or the next reload resurrects it.
			const kind = kindOverride ?? stored.projectionKind ?? "draft";
			pendingProjectionRef.current = {
				id: stored.projectionId,
				kind,
				markdown,
				pointerNodeId: kind === "pointer" ? stored.pointerNodeId : undefined,
			};
			if (kind !== stored.projectionKind) {
				saveDraft(documentId, markdown, stored.projectionId, { kind });
			}
			setSyncStatus("unsynced");
		},
		[documentId],
	);

	// Idle re-hydrate when remote write arrives (G7.4 origin/updatedAt guard)
	useEffect(() => {
		if (!enabled || !documentId || serverMarkdown === undefined) return;
		if (!hasSeededRef.current) return;
		const editorRef = getEditorHandleRef.current();
		if (!editorRef) return;
		if (serverUpdatedAt === undefined) return;

		if (lastHandledServerUpdatedAtRef.current === serverUpdatedAt) return;

		const isRemote = isRemoteServerUpdate(
			serverUpdatedAt,
			lastWrittenUpdatedAtRef.current,
			expectedUpdatedAtRef.current,
		);

		if (!isRemote) {
			lastHandledServerUpdatedAtRef.current = serverUpdatedAt;
			return;
		}

		// Don't re-seed (clobber local text) while the writer is focused OR while
		// there are unsaved local edits not yet flushed to the server. `isFocused()`
		// alone is insufficient: briefly clicking a panel/header blurs the editor, so
		// a remote write landing in that window would otherwise overwrite the typed-
		// but-unflushed text. `pendingMarkdownRef` is null only after a successful
		// flush, so it's the precise "no unsaved local edits" signal.
		// Don't re-seed over keystrokes the undo tree has not captured. This asks
		// the history hook rather than checking `pendingMarkdownRef`: that ref
		// stays dirty until a projection completes (R2), so using it here would
		// deadlock — the thing that clears it is the thing it would be blocking.
		if (getHasPendingDraft?.()) {
			expectedUpdatedAtRef.current = serverUpdatedAt;
			return;
		}

		// Projection is the history hook's job — it owns the DAG, and editor text,
		// grouping controller and pointer have to move together (R3). This hook
		// used to seed on its own, which is how the pointer and the visible text
		// drifted apart. If it defers, the revision is NOT marked handled.
		if (reconcileRemote) {
			if (!reconcileRemote()) {
				expectedUpdatedAtRef.current = serverUpdatedAt;
				return;
			}
			lastHandledServerUpdatedAtRef.current = serverUpdatedAt;
			return;
		}

		editorRef.seed(serverMarkdown, { programmatic: true });
		setWordCount(countWords(serverMarkdown));
		expectedUpdatedAtRef.current = serverUpdatedAt;
		lastWrittenUpdatedAtRef.current = serverUpdatedAt;
		lastHandledServerUpdatedAtRef.current = serverUpdatedAt;
		lastFlushedMarkdownRef.current = serverMarkdown;
		clearDraft(documentId);
		setSyncStatus("saved");
	}, [
		enabled,
		documentId,
		getHasPendingDraft,
		reconcileRemote,
		serverMarkdown,
		serverUpdatedAt,
	]);

	/**
	 * The history hook has just projected remote state into the editor. Accept it
	 * as the new baseline — otherwise the next flush would push the projected
	 * text back up as though the writer had typed it — and only now retire the
	 * dirty draft, since something has finally replaced it.
	 */
	const acceptRemoteProjection = useCallback(
		(
			markdown: string,
			serverRevisionUpdatedAt: number,
			resolvedProjectionId?: string,
		) => {
			setWordCount(countWords(markdown));
			observeServerRevision(serverRevisionUpdatedAt, markdown);
			// This projection RESOLVES the transition it names — the server refused
			// that move and this is the state it kept instead. Without saying so,
			// the pane showed the server's head while the document stayed unsynced
			// and storage still held the refused target.
			if (resolvedProjectionId !== undefined) {
				retirePending(resolvedProjectionId);
				return;
			}
			// Anything else pending is work the server has not answered; remote
			// text cannot speak for it.
			if (pendingProjectionRef.current !== null) return;
			pendingMarkdownRef.current = null;
			if (documentId) clearDraft(documentId);
			setSyncStatus("saved");
		},
		[documentId, observeServerRevision, retirePending],
	);

	useEffect(() => {
		return () => {
			debouncedFlush.flush();
		};
	}, [debouncedFlush]);

	useEffect(() => {
		function onBeforeUnload(e: BeforeUnloadEvent) {
			if (pendingMarkdownRef.current !== null || flushInFlightRef.current) {
				e.preventDefault();
				e.returnValue = "";
			}
		}
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);

	return {
		wordCount,
		syncStatus,
		pendingConflict,
		handleEditorChange,
		flushSync,
		flushMarkdown,
		getCurrentMarkdown,
		acceptRemoteProjection,
		getBaselineUpdatedAt,
		getRecoveredDraft,
		adoptRecoveredDraft,
		markLocalProjectionPending,
		settleLocalProjection,
		getPendingProjectionId,
	};
}
