"use client";

import { Check, Flag as FlagIcon, Pin, PinOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ACTIONS, shortcutHint } from "@/lib/keyboard/actions";
import type { Flag } from "@/lib/markdown/flags";

const addFlagAction = ACTIONS.find((action) => action.id === "add-flag");
const ADD_FLAG_CHORD = addFlagAction ? shortcutHint(addFlagAction) : "";

type NotesPanelProps = {
	flags: Flag[];
	pinned: boolean;
	onTogglePin: () => void;
	onGoTo: (index: number) => void;
	onResolve: (index: number) => void;
	onClose: () => void;
};

/**
 * The writer's flags beside the text, in document order. Not a dialog: the
 * text stays editable while it's open, so it can sit alongside a revision
 * pass; Go to leaves it open, and the pin keeps it open across documents.
 */
export function NotesPanel({
	flags,
	pinned,
	onTogglePin,
	onGoTo,
	onResolve,
	onClose,
}: NotesPanelProps) {
	return (
		<aside
			className="recto-panel fixed inset-y-0 right-0 z-[80] flex w-[min(20rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
			aria-labelledby="recto-notes-title"
		>
			<header className="flex shrink-0 items-center justify-between gap-[var(--space-2)] border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
				<h2
					id="recto-notes-title"
					className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
				>
					Notes
					{flags.length > 0 && (
						<span className="ml-[var(--space-2)] text-[var(--color-ink-tertiary)]">
							{flags.length}
						</span>
					)}
				</h2>
				<div className="flex items-center gap-[var(--space-1)]">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onTogglePin}
						aria-pressed={pinned}
						aria-label={pinned ? "Unpin notes panel" : "Pin notes panel open"}
						title={pinned ? "Unpin" : "Keep open while revising"}
					>
						{pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onClose}
						aria-label="Close notes"
					>
						<X aria-hidden />
					</Button>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
				{flags.length === 0 ? (
					<p className="px-[var(--space-2)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
						No flags. Press {ADD_FLAG_CHORD} while writing to flag a spot and
						keep going.
					</p>
				) : (
					<ul className="flex flex-col gap-[var(--space-1)]">
						{flags.map((flag, index) => (
							<li
								key={flag.from}
								className="recto-item group flex items-start gap-[var(--space-1)]"
							>
								<button
									type="button"
									onClick={() => onGoTo(index)}
									title="Go to this flag"
									className="flex min-w-0 flex-1 items-start gap-[var(--space-2)] px-[var(--space-2)] py-1.5 text-left text-[length:var(--text-ui-sm)]"
								>
									<FlagIcon
										aria-hidden
										className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning)]"
									/>
									<span
										className={
											flag.note
												? "min-w-0 flex-1 text-[var(--color-ink-primary)]"
												: "min-w-0 flex-1 italic text-[var(--color-ink-tertiary)]"
										}
									>
										{flag.note || "No note"}
									</span>
								</button>
								<Button
									variant="ghost"
									size="icon-sm"
									onClick={() => onResolve(index)}
									aria-label={`Resolve flag${flag.note ? `: ${flag.note}` : ""}`}
									title="Resolve (remove the flag)"
								>
									<Check aria-hidden />
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>
		</aside>
	);
}
