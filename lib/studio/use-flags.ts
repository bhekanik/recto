"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import type { Id } from "@/convex/_generated/dataModel";
import { FLAG_CLICK_EVENT, type FlagClickDetail } from "@/lib/editor/flags";
import type { EditorHandle } from "@/lib/editor/handle";
import { dispatchModeSwitch } from "@/lib/keyboard/app-shortcuts";
import { type Flag, findFlags } from "@/lib/markdown/flags";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import type { WorkspaceState } from "@/lib/workspace/types";

/**
 * The note field that is open: for a new flag, where it will go (it is
 * written with its note, one edit); for an existing one, which flag.
 */
export type FlagNoteDraft = {
	target: { kind: "new"; at: number } | { kind: "existing"; index: number };
	rect: DOMRect;
	note: string;
};

/** A stable React key for a draft's field. */
export function draftKey(draft: FlagNoteDraft): string {
	return draft.target.kind === "new"
		? `new-${draft.target.at}`
		: `flag-${draft.target.index}`;
}

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
	/** ⌘⇧X: open a note at the caret; the flag lands when it closes. */
	addFlag: () => void;
	/** Save the draft's note (empty keeps a bare flag) and return to the text. */
	saveNote: (note: string) => void;
	/**
	 * Escape: leave an existing note as it was, or drop a new flag bare.
	 * Either way, back to the text after the flag.
	 */
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
			if (rect) setDraft({ target: { kind: "existing", index }, rect, note });
		},
		[getHandle],
	);

	const addFlag = useCallback(() => {
		// One task later: the editors adopt a caret move from the DOM's
		// selectionchange, which can still be queued behind this keydown, and
		// the flag must land where the caret is now, not a keystroke ago.
		setTimeout(() => {
			const anchor = getHandle()?.flags?.caretAnchor();
			if (!anchor) return;
			setDraft({
				target: { kind: "new", at: anchor.at },
				rect: anchor.rect,
				note: "",
			});
		}, 0);
	}, [getHandle]);

	const draftRef = useRef(draft);
	draftRef.current = draft;

	const saveNote = useCallback(
		(note: string) => {
			const current = draftRef.current;
			setDraft(null);
			const handle = getHandle();
			if (!current || !handle) return;
			if (current.target.kind === "new") {
				// The flag and its note are one edit, so one undo takes both.
				handle.flags?.insertAt(current.target.at, note);
			} else {
				const { index } = current.target;
				if (note.trim() !== current.note) handle.flags?.setNote(index, note);
				handle.flags?.goTo(index);
			}
			refresh();
		},
		[getHandle, refresh],
	);

	const closeDraft = useCallback(() => {
		const current = draftRef.current;
		setDraft(null);
		if (!current) return;
		const flags = getHandle()?.flags;
		if (current.target.kind === "new") {
			flags?.insertAt(current.target.at, "");
			refresh();
		} else {
			flags?.goTo(current.target.index);
		}
	}, [getHandle, refresh]);

	const goToFlag = useCallback(
		(index: number) => {
			if (!notesPinned) setNotesOpenState(false);
			const flags = getHandle()?.flags;
			if (flags) {
				flags.goTo(index);
				return;
			}
			// Preview can't hold a caret: switch the pane to rich text, then go
			// once the editor has mounted and seeded (two frames, as find does).
			if (!activeDocId) return;
			dispatchModeSwitch("rich");
			requestAnimationFrame(() => {
				requestAnimationFrame(() => getHandle()?.flags?.goTo(index));
			});
		},
		[activeDocId, getHandle, notesPinned],
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
