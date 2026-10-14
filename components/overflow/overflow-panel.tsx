"use client";

import { X } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { OverflowNotes } from "@/lib/overflow/use-overflow-notes";

type OverflowPanelProps = {
	notes: OverflowNotes;
	/** Move the selected notes into the draft at its caret. */
	onMoveIntoDraft: (from: number, text: string) => void;
	onClose: () => void;
};

const STATUS_LABEL = {
	loading: "Loading…",
	saved: "Saved",
	unsaved: "Saving soon",
	saving: "Saving…",
	error: "Not saved",
	conflict: "Changed elsewhere",
} as const;

/**
 * The document's Overflow notes beside the draft: spare passages, links and
 * outlines that are not part of the text. Not a dialog: the draft stays
 * editable while it is open.
 */
export function OverflowPanel({
	notes,
	onMoveIntoDraft,
	onClose,
}: OverflowPanelProps) {
	const [showOther, setShowOther] = useState(false);
	return (
		<aside
			className="recto-panel fixed inset-y-0 right-0 z-[80] flex w-[min(22rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
			aria-labelledby="recto-overflow-title"
		>
			<header className="flex shrink-0 items-center justify-between gap-[var(--space-2)] border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
				<h2
					id="recto-overflow-title"
					className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
				>
					Overflow
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onClose}
					aria-label="Close Overflow"
				>
					<X aria-hidden />
				</Button>
			</header>
			<p className="px-[var(--space-4)] pt-[var(--space-3)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
				Notes stay outside your draft and exports. Select a passage and press
				Ctrl+Return to move it to the draft&apos;s caret.
			</p>
			<div className="flex min-h-0 flex-1 flex-col px-[var(--space-4)] py-[var(--space-3)]">
				<Textarea
					aria-label="Overflow notes"
					className="min-h-0 flex-1 resize-none font-mono text-[length:var(--text-ui-sm)]"
					value={notes.text}
					disabled={notes.status === "loading"}
					onChange={(event) => notes.setText(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key !== "Enter" ||
							!event.ctrlKey ||
							event.metaKey ||
							event.altKey
						)
							return;
						const area = event.currentTarget;
						if (area.selectionStart === area.selectionEnd) return;
						event.preventDefault();
						onMoveIntoDraft(
							area.selectionStart,
							area.value.slice(area.selectionStart, area.selectionEnd),
						);
					}}
				/>
			</div>
			{notes.conflict && (
				<div className="px-[var(--space-4)] pb-[var(--space-3)]">
					<Alert>
						<AlertDescription className="flex flex-col gap-[var(--space-2)]">
							<span>
								Overflow changed on another device. Both copies are kept until
								you choose.
							</span>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setShowOther((value) => !value)}
							>
								{showOther ? "Hide other copy" : "View other copy"}
							</Button>
							{showOther && (
								<pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[length:var(--text-ui-sm)]">
									{notes.conflict.markdown}
								</pre>
							)}
							<div className="flex gap-[var(--space-2)]">
								<Button size="sm" onClick={() => void notes.resolve(true)}>
									Keep this copy
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => void notes.resolve(false)}
								>
									Use other copy
								</Button>
							</div>
						</AlertDescription>
					</Alert>
				</div>
			)}
			<footer className="flex items-center justify-between gap-[var(--space-2)] border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
				<span role="status">{notes.error ?? STATUS_LABEL[notes.status]}</span>
				{notes.status === "error" && (
					<Button variant="ghost" size="sm" onClick={() => void notes.flush()}>
						Retry saving
					</Button>
				)}
			</footer>
		</aside>
	);
}
