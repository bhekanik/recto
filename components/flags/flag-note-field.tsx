"use client";

import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import type { FlagNoteDraft } from "@/lib/studio/use-flags";

type FlagNoteFieldProps = {
	draft: FlagNoteDraft;
	onSave: (note: string) => void;
	onClose: () => void;
};

const WIDTH = 288;

/**
 * The one-line note under a flag that was just dropped (or clicked). Enter
 * saves, Escape leaves the note as it was, and either way the writer is back
 * in the sentence right after the flag. Clicking away saves too, so a half
 * written note is never lost.
 */
export function FlagNoteField({ draft, onSave, onClose }: FlagNoteFieldProps) {
	const [note, setNote] = useState(draft.note);
	const inputRef = useRef<HTMLInputElement>(null);
	const doneRef = useRef(false);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const left = Math.max(
		16,
		Math.min(draft.rect.left - 12, window.innerWidth - WIDTH - 16),
	);
	const top = draft.rect.bottom + 6;

	const finish = (save: boolean) => {
		if (doneRef.current) return;
		doneRef.current = true;
		if (save) onSave(note);
		else onClose();
	};

	return (
		<div
			className="recto-panel fixed z-[95] p-[var(--space-2)]"
			style={{ left, top, width: WIDTH }}
		>
			<Input
				ref={inputRef}
				value={note}
				aria-label="Flag note"
				placeholder="What's missing here?"
				onChange={(event) => setNote(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						finish(true);
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						finish(false);
					}
				}}
				onBlur={() => finish(true)}
			/>
		</div>
	);
}
