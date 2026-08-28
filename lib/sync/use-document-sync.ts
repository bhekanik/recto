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
};

type UseDocumentSyncResult = {
	wordCount: number;
	syncStatus: SyncStatus;
	pendingConflict: boolean;
	useDraft: () => void;
	useServer: () => void;
	handleEditorChange: () => void;
	flushSync: () => Promise<void>;
	flushMarkdown: (markdown: string) => Promise<void>;
	getCurrentMarkdown: () => string;
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
}: UseDocumentSyncArgs): UseDocumentSyncResult {
	const updateMarkdown = useMutation(api.documents.updateMarkdown);

	const [wordCount, setWordCount] = useState(0);
	const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
	const [pendingConflict, setPendingConflict] = useState(false);

	const expectedUpdatedAtRef = useRef<number>(0);
	const lastWrittenUpdatedAtRef = useRef<number>(0);
	const lastHandledServerUpdatedAtRef = useRef<number>(0);
	const hasSeededRef = useRef(false);
	const pendingMarkdownRef = useRef<string | null>(null);
	const flushInFlightRef = useRef(false);
	const pendingFlushAfterInFlightRef = useRef(false);
	const lastFlushedMarkdownRef = useRef<string>("");
	const getEditorHandleRef = useRef(getEditorHandle);
	getEditorHandleRef.current = getEditorHandle;

	// Reset seed state when document changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on document switch
	useEffect(() => {
		hasSeededRef.current = false;
		expectedUpdatedAtRef.current = 0;
		lastWrittenUpdatedAtRef.current = 0;
		lastHandledServerUpdatedAtRef.current = 0;
		lastFlushedMarkdownRef.current = "";
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
					// documents.currentNodeId. Stand down and let the history hook's
					// pointer adoption re-seed; the text is not lost — it is in the
					// local draft buffer and in the node commitEdit stored anyway.
					pendingMarkdownRef.current = null;
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

	const seedEditor = useCallback((markdown: string) => {
		const editorRef = getEditorHandleRef.current();
		editorRef?.seed(markdown, { programmatic: true });
		setWordCount(countWords(markdown));
	}, []);

	// Seed on open — retry until editor ref is ready
	useEffect(() => {
		if (!enabled || !documentId || serverMarkdown === undefined) return;
		if (hasSeededRef.current) return;

		const trySeed = (): boolean => {
			const editorRef = getEditorHandleRef.current();
			if (!editorRef) return false;

			const { markdown, hadConflict, draftOrigin } = reconcileDraft(
				serverMarkdown,
				serverUpdatedAt ?? 0,
				documentId,
			);

			editorRef.seed(markdown, { programmatic: true });
			setWordCount(countWords(markdown));
			expectedUpdatedAtRef.current = serverUpdatedAt ?? 0;
			lastWrittenUpdatedAtRef.current = serverUpdatedAt ?? 0;
			lastHandledServerUpdatedAtRef.current = serverUpdatedAt ?? 0;
			lastFlushedMarkdownRef.current = markdown;
			hasSeededRef.current = true;

			if (hadConflict && !isOwnDraftOrigin(draftOrigin)) {
				setPendingConflict(true);
			}
			return true;
		};

		if (trySeed()) return;

		const interval = window.setInterval(() => {
			if (trySeed()) window.clearInterval(interval);
		}, 50);

		return () => window.clearInterval(interval);
	}, [enabled, documentId, serverMarkdown, serverUpdatedAt]);

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
		if (editorRef.isFocused() || pendingMarkdownRef.current !== null) {
			// Keep local edits; adopt server version for the next save attempt.
			expectedUpdatedAtRef.current = serverUpdatedAt;
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
	}, [enabled, documentId, serverMarkdown, serverUpdatedAt]);

	const useDraft = useCallback(() => {
		if (!documentId) return;
		const draft = reconcileDraft(
			serverMarkdown ?? "",
			serverUpdatedAt ?? 0,
			documentId,
		);
		seedEditor(draft.markdown);
		setPendingConflict(false);
		debouncedFlush();
	}, [documentId, debouncedFlush, seedEditor, serverMarkdown, serverUpdatedAt]);

	const useServer = useCallback(() => {
		if (serverMarkdown === undefined) return;
		seedEditor(serverMarkdown);
		if (documentId) clearDraft(documentId);
		setPendingConflict(false);
	}, [documentId, seedEditor, serverMarkdown]);

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
		useDraft,
		useServer,
		handleEditorChange,
		flushSync,
		flushMarkdown,
		getCurrentMarkdown,
	};
}
