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
};

type UseDocumentSyncResult = {
	wordCount: number;
	syncStatus: SyncStatus;
	needsRehydrate: boolean;
	confirmRehydrate: () => void;
	dismissRehydrate: () => void;
	pendingConflict: boolean;
	useDraft: () => void;
	useServer: () => void;
	handleEditorChange: () => void;
	flushSync: () => Promise<void>;
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
}: UseDocumentSyncArgs): UseDocumentSyncResult {
	const updateMarkdown = useMutation(api.documents.updateMarkdown);

	const [wordCount, setWordCount] = useState(0);
	const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
	const [needsRehydrate, setNeedsRehydrate] = useState(false);
	const [pendingConflict, setPendingConflict] = useState(false);

	const expectedUpdatedAtRef = useRef<number>(0);
	const lastWrittenUpdatedAtRef = useRef<number>(0);
	const lastHandledServerUpdatedAtRef = useRef<number>(0);
	const hasSeededRef = useRef(false);
	const pendingMarkdownRef = useRef<string | null>(null);
	const flushInFlightRef = useRef(false);
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

	const flush = useCallback(async () => {
		const editorRef = getEditorHandleRef.current();
		if (!documentId || !editorRef) return;

		const markdown = editorRef.getCanonicalMarkdown();
		const words = countWords(markdown);
		setWordCount(words);
		saveDraft(documentId, markdown);
		pendingMarkdownRef.current = markdown;

		const expected = expectedUpdatedAtRef.current;
		if (expected === 0) return;

		if (markdown === lastFlushedMarkdownRef.current) {
			pendingMarkdownRef.current = null;
			if (documentId) clearDraft(documentId);
			setSyncStatus("saved");
			return;
		}

		setSyncStatus("saving");
		flushInFlightRef.current = true;

		try {
			const result = await updateMarkdown({
				documentId,
				markdown,
				wordCount: words,
				expectedUpdatedAt: expected,
			});

			if (result.stale) {
				setSyncStatus("unsynced");
				setNeedsRehydrate(true);
				return;
			}

			expectedUpdatedAtRef.current = result.updatedAt;
			lastWrittenUpdatedAtRef.current = result.updatedAt;
			lastHandledServerUpdatedAtRef.current = result.updatedAt;
			lastFlushedMarkdownRef.current = markdown;
			pendingMarkdownRef.current = null;
			clearDraft(documentId);
			setSyncStatus("saved");
		} catch {
			setSyncStatus("unsynced");
		} finally {
			flushInFlightRef.current = false;
		}
	}, [documentId, updateMarkdown]);

	const debouncedFlush = useDebouncedCallback(flush, DEBOUNCE_MS);

	const flushSync = useCallback(async () => {
		debouncedFlush.flush();
		await flush();
		while (flushInFlightRef.current) {
			await new Promise((r) => setTimeout(r, 10));
		}
	}, [debouncedFlush, flush]);

	const getCurrentMarkdown = useCallback(() => {
		return getEditorHandleRef.current()?.getCanonicalMarkdown() ?? "";
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

		if (editorRef.isFocused()) {
			setNeedsRehydrate(true);
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
		setNeedsRehydrate(false);
		setSyncStatus("saved");
	}, [enabled, documentId, serverMarkdown, serverUpdatedAt]);

	const confirmRehydrate = useCallback(() => {
		const editorRef = getEditorHandleRef.current();
		if (!editorRef || serverMarkdown === undefined) return;
		editorRef.seed(serverMarkdown, { programmatic: true });
		setWordCount(countWords(serverMarkdown));
		if (serverUpdatedAt !== undefined) {
			expectedUpdatedAtRef.current = serverUpdatedAt;
			lastWrittenUpdatedAtRef.current = serverUpdatedAt;
			lastHandledServerUpdatedAtRef.current = serverUpdatedAt;
		}
		lastFlushedMarkdownRef.current = serverMarkdown;
		if (documentId) clearDraft(documentId);
		setNeedsRehydrate(false);
		setSyncStatus("saved");
	}, [documentId, serverMarkdown, serverUpdatedAt]);

	const dismissRehydrate = useCallback(() => {
		setNeedsRehydrate(false);
	}, []);

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
		needsRehydrate,
		confirmRehydrate,
		dismissRehydrate,
		pendingConflict,
		useDraft,
		useServer,
		handleEditorChange,
		flushSync,
		getCurrentMarkdown,
	};
}
