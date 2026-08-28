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
	reconcileDraft,
	saveDraft,
} from "@/lib/sync/draft-buffer";

export const DEBOUNCE_MS = 500;

export type SyncStatus = "idle" | "saving" | "saved" | "unsynced";

/** A local draft restored from storage. `present: false` means there was none. */
export type RecoveredDraft = { present: boolean; markdown: string };

type UseDocumentSyncArgs = {
	documentId: Id<"documents"> | null;
	getEditorHandle: () => EditorHandle | null;
	serverMarkdown: string | undefined;
	serverUpdatedAt: number | undefined;
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
	acceptRemoteProjection: (markdown: string, serverUpdatedAt: number) => void;
	/** The server revision the editor currently reflects (ADR-19, Y1). */
	getBaselineUpdatedAt: () => number;
	/** A draft restored from storage on open, resolved without an editor. */
	getRecoveredDraft: () => RecoveredDraft | null;
	/** Report a recovered draft the history hook has put on screen (unsaved). */
	adoptRecoveredDraft: (markdown: string) => void;
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
	}, [documentId]);

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
			saveDraft(documentId, markdown);
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

			if (markdown === lastFlushedMarkdownRef.current) {
				pendingMarkdownRef.current = null;
				clearDraft(documentId);
				setSyncStatus("saved");
				return "done";
			}

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
					expectedUpdatedAtRef.current = result.updatedAt;
					lastHandledServerUpdatedAtRef.current = result.updatedAt;
					return "retry";
				}

				expectedUpdatedAtRef.current = result.updatedAt;
				lastWrittenUpdatedAtRef.current = result.updatedAt;
				lastHandledServerUpdatedAtRef.current = result.updatedAt;
				lastFlushedMarkdownRef.current = markdown;
				projectedBaselineUpdatedAtRef.current = result.updatedAt;
				pendingMarkdownRef.current = null;
				clearDraft(documentId);
				setSyncStatus("saved");
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
		if (documentId) saveDraft(documentId, markdown);
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

		const { markdown, hadConflict, draftOrigin } = reconcileDraft(
			serverMarkdown,
			serverUpdatedAt ?? 0,
			documentId,
		);
		// A draft that deletes everything is still a draft the writer meant to
		// keep, so presence is a flag rather than "the text is non-empty".
		const present = markdown !== serverMarkdown;
		recoveredRef.current = { present, markdown };

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
	}, [enabled, documentId, reconcileRemote, serverMarkdown, serverUpdatedAt]);

	const getRecoveredDraft = useCallback(() => recoveredRef.current, []);

	/**
	 * The history hook has projected a recovered local draft. It is UNSAVED — the
	 * server has never seen it — so it must be reported dirty and its storage
	 * copy kept until a write actually succeeds. Treating it as flushed lost the
	 * draft on the next open: cleared from storage, never sent.
	 */
	const adoptRecoveredDraft = useCallback((markdown: string) => {
		setWordCount(countWords(markdown));
		pendingMarkdownRef.current = markdown;
		setSyncStatus("unsynced");
	}, []);

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
		(markdown: string, serverRevisionUpdatedAt: number) => {
			setWordCount(countWords(markdown));
			expectedUpdatedAtRef.current = serverRevisionUpdatedAt;
			lastWrittenUpdatedAtRef.current = serverRevisionUpdatedAt;
			lastHandledServerUpdatedAtRef.current = serverRevisionUpdatedAt;
			lastFlushedMarkdownRef.current = markdown;
			projectedBaselineUpdatedAtRef.current = serverRevisionUpdatedAt;
			pendingMarkdownRef.current = null;
			if (documentId) clearDraft(documentId);
			setSyncStatus("saved");
		},
		[documentId],
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
	};
}
