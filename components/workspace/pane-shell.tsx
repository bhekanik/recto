"use client";

import { X } from "lucide-react";

import { type Mode, modeToLabel, type VimSubMode } from "@/lib/modes/types";
import { cn } from "@/lib/utils";

type PaneShellProps = {
	paneId: string;
	title: string;
	mode: Mode;
	vimSubMode?: VimSubMode;
	isActive: boolean;
	onFocus: () => void;
	canClose: boolean;
	onClose: () => void;
	children: React.ReactNode;
};

function CloseButton({
	onClose,
	floating,
}: {
	onClose: () => void;
	floating?: boolean;
}) {
	return (
		<button
			type="button"
			title="Close pane (Ctrl+Shift+W)"
			aria-label="Close pane"
			// Don't let the press bubble to the pane's focus handler.
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				onClose();
			}}
			className={cn(
				"flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-primary)]",
				floating &&
					"absolute right-[var(--space-2)] top-[var(--space-2)] z-20 bg-[var(--color-bg-surface)]/80 opacity-0 backdrop-blur-sm group-hover:opacity-100 focus-visible:opacity-100",
			)}
		>
			<X aria-hidden className="size-[15px]" />
		</button>
	);
}

/**
 * Borderless, full-bleed writing surface (Bear-like). The active pane shows no
 * chrome at all — the canvas owns the screen. Inactive panes get a slim, dimmed
 * header (title + mode) so panes stay identifiable in a split. When more than one
 * pane is open, a close (×) affordance appears: in the header for inactive panes,
 * and as a hover-revealed corner button for the active (headerless) pane.
 */
export function PaneShell({
	paneId,
	title,
	mode,
	vimSubMode,
	isActive,
	onFocus,
	canClose,
	onClose,
	children,
}: PaneShellProps) {
	return (
		<div
			data-pane-id={paneId}
			data-active={isActive || undefined}
			className="group relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-bg-surface)]"
			onPointerDown={onFocus}
		>
			{!isActive && (
				<header className="flex shrink-0 items-center justify-between gap-[var(--space-2)] border-b border-[var(--color-line)] bg-[var(--color-bg-app)]/40 px-[var(--space-3)] py-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
					<span className="min-w-0 truncate">{title}</span>
					<div className="flex shrink-0 items-center gap-[var(--space-2)]">
						<span>{modeToLabel(mode, vimSubMode)}</span>
						{canClose && <CloseButton onClose={onClose} />}
					</div>
				</header>
			)}
			{isActive && canClose && <CloseButton onClose={onClose} floating />}
			<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
		</div>
	);
}
