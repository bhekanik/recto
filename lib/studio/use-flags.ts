"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import type { Id } from "@/convex/_generated/dataModel";
import { FLAG_CLICK_EVENT, type FlagClickDetail } from "@/lib/editor/flags";
import type { EditorHandle } from "@/lib/editor/handle";
import { type Flag, findFlags } from "@/lib/markdown/flags";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import type { WorkspaceState } from "@/lib/workspace/types";

/** The note field open under a flag: which flag, where, and its current note. */
export type FlagNoteDraft = { index: number; rect: DOMRect; note: string };

type UseFlagsArgs = {
	activeDocId: Id<"documents"> | null;
	workspace: WorkspaceState | null;
	registry: DocumentModelRegistry;
	/** Synced markdown — the change SIGNAL that re-arms the debounced refresh. */
	syncedMarkdown: string;
	notesPinned: boolean;
	unpinNotes: () => void;
};

export type UseFlagsResult = {
	flags: Flag[];
	notesOpen: boolean;
	/** Open or close the panel; closing a pinned panel unpins it. */
	setNotesOpen: (open: boolean) => void;
	toggleNotes: () => void;
	draft: FlagNoteDraft | null;
	/** ⌘⇧X: drop a flag at the caret and open its note field. */
	addFlag: () => void;
	/** Save the draft's note (empty keeps a bare flag) and return to the text. */
	saveNote: (note: string) => void;
	/** Close the note field without changing the note; back to the text. */
	closeDraft: () => void;
	goToFlag: (index: number) => void;
	resolveFlag: (index: number) => void;
};

/**
 * Writing flags for the active document. The list is read from the live editor
 * on a debounce (like the outline) so typing stays off the parse path; edits go
 * through the active pane's editor so they land in its history and sync like
 * any other keystroke.
 */
export function useFlags({
	activeDocId,
	workspace,
	registry,
	syncedMarkdown,
	notesPinned,
	unpinNotes,
}: UseFlagsArgs): UseFlagsResult {
	const [markdown, setMarkdown] = useState("");
	const [notesOpenState, setNotesOpenState] = useState(false);
	const notesOpen = notesOpenState || notesPinned;
	const [draft, setDraft] = useState<FlagNoteDraft | null>(null);

	const getHandle = useCallback((): EditorHandle | null => {
		if (!activeDocId || !workspace) return null;
		return (
			registry.getPrimaryHandle(activeDocId, workspace.activePaneId) ?? null
		);
	}, [activeDocId, workspace, registry]);

	const refresh = useCallback(() => {
		const handle = getHandle();
		setMarkdown(handle?.getCanonicalMarkdown() ?? syncedMarkdown);
	}, [getHandle, syncedMarkdown]);

	// The arg is the change signal only; the refresh re-reads the live handle.
	const debouncedRefresh = useDebouncedCallback((_signal: string) => {
		refresh();
	}, 250);
	useEffect(() => {
		debouncedRefresh(syncedMarkdown);
	}, [syncedMarkdown, debouncedRefresh]);
	useEffect(() => {
		if (notesOpen) refresh();
	}, [notesOpen, refresh]);

	// A pinned panel is open whatever else happens; unpinned, a document switch
	// closes it along with any note being written.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the document changes
	useEffect(() => {
		setDraft(null);
		if (!notesPinned) setNotesOpenState(false);
	}, [activeDocId]);

	const flags = useMemo(() => findFlags(markdown), [markdown]);

	const openDraft = useCallback(
		(index: number, note: string) => {
			const rect = getHandle()?.flags?.rect(index);
			if (rect) setDraft({ index, rect, note });
		},
		[getHandle],
	);

	const addFlag = useCallback(() => {
		// One task later: the editors adopt a caret move from the DOM's
		// selectionchange, which can still be queued behind this keydown, and
		// the flag must land where the caret is now, not a keystroke ago.
		setTimeout(() => {
			const index = getHandle()?.flags?.insertAtCaret();
			if (index === null || index === undefined || index < 0) return;
			refresh();
			// The glyph is in the DOM once the editor has painted.
			requestAnimationFrame(() => openDraft(index, ""));
		}, 0);
	}, [getHandle, openDraft, refresh]);

	const draftRef = useRef(draft);
	draftRef.current = draft;

	const saveNote = useCallback(
		(note: string) => {
			const current = draftRef.current;
			setDraft(null);
			const handle = getHandle();
			if (!current || !handle) return;
			if (note.trim() !== current.note)
				handle.flags?.setNote(current.index, note);
			handle.flags?.goTo(current.index);
			refresh();
		},
		[getHandle, refresh],
	);

	const closeDraft = useCallback(() => {
		const current = draftRef.current;
		setDraft(null);
		if (current) getHandle()?.flags?.goTo(current.index);
	}, [getHandle]);

	const goToFlag = useCallback(
		(index: number) => {
			getHandle()?.flags?.goTo(index);
			if (!notesPinned) setNotesOpenState(false);
		},
		[getHandle, notesPinned],
	);

	const resolveFlag = useCallback(
		(index: number) => {
			getHandle()?.flags?.remove(index);
			refresh();
		},
		[getHandle, refresh],
	);

	// Clicking a flag in the text opens its note.
	useEffect(() => {
		const onClick = (event: Event) => {
			const { index } = (event as CustomEvent<FlagClickDetail>).detail;
			const note = findFlags(getHandle()?.getCanonicalMarkdown() ?? "")[index]
				?.note;
			if (note !== undefined) openDraft(index, note);
		};
		window.addEventListener(FLAG_CLICK_EVENT, onClick);
		return () => window.removeEventListener(FLAG_CLICK_EVENT, onClick);
	}, [getHandle, openDraft]);

	const setNotesOpen = useCallback(
		(open: boolean) => {
			if (!open && notesPinned) unpinNotes();
			setNotesOpenState(open);
		},
		[notesPinned, unpinNotes],
	);
	const toggleNotes = useCallback(
		() => setNotesOpen(!notesOpen),
		[notesOpen, setNotesOpen],
	);

	return {
		flags,
		notesOpen,
		setNotesOpen,
		toggleNotes,
		draft,
		addFlag,
		saveNote,
		closeDraft,
		goToFlag,
		resolveFlag,
	};
}
