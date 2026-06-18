"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

type OutlineHeadingItem = { text: string; depth: number; index: number };

type OutlinePanelProps = {
	open: boolean;
	headings: OutlineHeadingItem[];
	onJumpToHeading: (index: number) => void;
	onClose: () => void;
};

export function OutlinePanel({
	open,
	headings,
	onJumpToHeading,
	onClose,
}: OutlinePanelProps) {
	// Restore focus to the trigger when the panel closes (blueprint 12 §8).
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (open) {
			restoreFocusRef.current = document.activeElement as HTMLElement | null;
		} else if (restoreFocusRef.current) {
			restoreFocusRef.current.focus?.();
			restoreFocusRef.current = null;
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div className="fixed inset-y-0 right-0 z-[90] flex">
			<button
				type="button"
				aria-label="Close outline"
				className="recto-scrim absolute inset-0 -left-[100vw]"
				onClick={onClose}
			/>
			<aside
				className="recto-panel relative z-10 flex h-full w-[min(20rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
				role="dialog"
				aria-modal="true"
				aria-labelledby="recto-outline-title"
			>
				<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
					<h2
						id="recto-outline-title"
						className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
					>
						Outline
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close outline"
						className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
					>
						<X aria-hidden className="size-4" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
					{headings.length === 0 ? (
						<p className="px-[var(--space-2)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							No headings yet.
						</p>
					) : (
						<ul className="flex flex-col">
							{headings.map((h) => (
								<li key={h.index} className="recto-item flex items-center">
									<button
										type="button"
										style={{ paddingInlineStart: `${h.depth * 16 - 8}px` }}
										onClick={() => onJumpToHeading(h.index)}
										className="flex min-w-0 flex-1 items-center gap-[var(--space-2)] px-[var(--space-2)] py-1.5 text-left text-[length:var(--text-ui-sm)]"
									>
										<span className="min-w-0 flex-1 truncate text-[var(--color-ink-secondary)]">
											{h.text || "(untitled heading)"}
										</span>
										<span className="shrink-0 text-[0.6875rem] text-[var(--color-ink-tertiary)]">
											H{h.depth}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</aside>
		</div>
	);
}
