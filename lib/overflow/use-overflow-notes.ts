"use client";

import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MAX_OVERFLOW_BYTES, utf8Bytes } from "./notes";

/** Long enough to batch a burst of typing, short enough to feel saved. */
const SAVE_DELAY_MS = 500;

export type OverflowStatus =
	| "loading"
	| "saved"
	| "unsaved"
	| "saving"
	| "error"
	| "conflict";

type PendingSave = {
	clientMutationId: string;
	markdown: string;
	expectedRevision: number;
};

/**
 * A document's Overflow notes, edited locally and saved with the server's
 * revision as a compare-and-set (`overflow.save`).
 *
 * The server's copy is adopted only while nothing local is unsaved (D11), so a
 * remote change never replaces what the writer is typing. A conflict keeps
 * both copies until the writer picks one. A failed save keeps its request id,
 * so a retry after a lost reply is the same request and the server replays it.
 */
export function useOverflowNotes(documentId: Id<"documents"> | null) {
	const remote = useQuery(
		api.overflow.get,
		documentId ? { documentId } : "skip",
	);
	const saveMutation = useMutation(api.overflow.save);

	const [text, setTextState] = useState("");
	const [status, setStatus] = useState<OverflowStatus>("loading");
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<{
		markdown: string;
		revision: number;
	} | null>(null);

	const textRef = useRef("");
	const revisionRef = useRef(0);
	const dirtyRef = useRef(false);
	const pendingRef = useRef<PendingSave | null>(null);
	const inFlightRef = useRef<Promise<boolean> | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hydratedFor = useRef<Id<"documents"> | null>(null);

	// A new document starts over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: documentId is the trigger; the body resets refs and state for the new document
	useEffect(() => {
		hydratedFor.current = null;
		dirtyRef.current = false;
		pendingRef.current = null;
		setConflict(null);
		setStatus("loading");
	}, [documentId]);

	useEffect(() => {
		if (!remote || !documentId) return;
		const fresh = hydratedFor.current !== documentId;
		const idleAndBehind =
			!dirtyRef.current &&
			!pendingRef.current &&
			remote.revision > revisionRef.current;
		if (!fresh && !idleAndBehind) return;
		hydratedFor.current = documentId;
		textRef.current = remote.markdown;
		revisionRef.current = remote.revision;
		setTextState(remote.markdown);
		setStatus("saved");
	}, [remote, documentId]);

	const flush = useCallback(async (): Promise<boolean> => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		if (!documentId) return false;
		if (inFlightRef.current) await inFlightRef.current;
		if (!dirtyRef.current && !pendingRef.current) return true;
		const markdown = textRef.current;
		if (utf8Bytes(markdown) > MAX_OVERFLOW_BYTES) {
			setStatus("error");
			setError("Overflow can hold up to 64 KiB of notes.");
			return false;
		}
		// Reuse the pending request only when it still describes this text.
		const pending =
			pendingRef.current?.markdown === markdown
				? pendingRef.current
				: {
						clientMutationId: crypto.randomUUID(),
						markdown,
						expectedRevision: revisionRef.current,
					};
		pendingRef.current = pending;
		setStatus("saving");
		const attempt = (async () => {
			try {
				const result = await saveMutation({ documentId, ...pending });
				pendingRef.current = null;
				if (result.saved) {
					revisionRef.current = result.revision;
					if (textRef.current === pending.markdown) {
						dirtyRef.current = false;
						setStatus("saved");
					} else {
						setStatus("unsaved");
					}
					setError(null);
					return true;
				}
				setConflict({ markdown: result.markdown, revision: result.revision });
				setStatus("conflict");
				return false;
			} catch (cause) {
				setStatus("error");
				setError(
					cause instanceof Error
						? cause.message
						: "The notes could not be saved.",
				);
				return false;
			} finally {
				inFlightRef.current = null;
			}
		})();
		inFlightRef.current = attempt;
		return await attempt;
	}, [documentId, saveMutation]);

	const setText = useCallback(
		(next: string) => {
			textRef.current = next;
			dirtyRef.current = true;
			setTextState(next);
			setStatus((current) => (current === "conflict" ? current : "unsaved"));
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				if (!conflict) void flush();
			}, SAVE_DELAY_MS);
		},
		[flush, conflict],
	);

	/** Replace the notes and save now; true once the server has them. */
	const replaceAndSave = useCallback(
		async (next: string): Promise<boolean> => {
			if (conflict) return false;
			textRef.current = next;
			dirtyRef.current = true;
			setTextState(next);
			return await flush();
		},
		[flush, conflict],
	);

	const resolve = useCallback(
		async (keepMine: boolean) => {
			if (!conflict) return;
			revisionRef.current = conflict.revision;
			setConflict(null);
			if (keepMine) {
				dirtyRef.current = true;
				await flush();
			} else {
				textRef.current = conflict.markdown;
				dirtyRef.current = false;
				setTextState(conflict.markdown);
				setStatus("saved");
			}
		},
		[conflict, flush],
	);

	useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		},
		[],
	);

	return {
		text,
		status,
		error,
		conflict,
		setText,
		flush,
		replaceAndSave,
		resolve,
		/** The text as the latest edit left it, for actions outside React's render. */
		currentText: () => textRef.current,
	};
}

export type OverflowNotes = ReturnType<typeof useOverflowNotes>;
