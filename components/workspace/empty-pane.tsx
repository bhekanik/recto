"use client";

import type { PaneLeaf } from "@/lib/workspace/types";

type EmptyPaneProps = {
	leaf: PaneLeaf;
	onOpenSwitcher: () => void;
	onCreate: () => void;
};

/** Prompt when a pane has no bound document. Type-led, no icon clutter (§6.11). */
export function EmptyPane({
	paneId,
	onOpenSwitcher,
	onCreate,
}: Omit<EmptyPaneProps, "leaf"> & { paneId?: string }) {
	return (
		<div
			data-pane-id={paneId}
			className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-[var(--space-5)] px-[var(--space-5)] text-center"
		>
			<p className="font-[family-name:var(--font-reading)] text-[length:var(--text-h3)] leading-[var(--leading-h3)] text-[var(--color-ink-secondary)]">
				No document open here
			</p>
			<div className="flex items-center gap-[var(--space-2)]">
				<button
					type="button"
					onClick={onOpenSwitcher}
					className="rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-transparent px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] outline-none hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
				>
					Open document
				</button>
				<button
					type="button"
					onClick={onCreate}
					className="rounded-[var(--radius-sm)] border border-[var(--color-accent-muted)] bg-[var(--color-accent-wash)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-primary)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] outline-none hover:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
				>
					Create new
				</button>
			</div>
		</div>
	);
}

export function EmptyPaneBound({
	leaf,
	onOpenSwitcher,
	onCreate,
}: EmptyPaneProps) {
	return (
		<EmptyPane
			paneId={leaf.paneId}
			onOpenSwitcher={onOpenSwitcher}
			onCreate={onCreate}
		/>
	);
}
