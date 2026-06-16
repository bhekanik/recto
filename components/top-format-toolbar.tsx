"use client";

import { Redo2, Undo2 } from "lucide-react";

import {
	BLOCK_ACTIONS,
	type FormatAction,
	INLINE_ACTIONS,
} from "@/components/format-actions";
import { dispatchFormat } from "@/lib/editor/format";
import { cn } from "@/lib/utils";

type TopFormatToolbarProps = {
	/** Preview has nothing to format — the bar dims and goes inert. */
	disabled?: boolean;
	onUndo: () => void;
	onRedo: () => void;
};

const btn =
	"flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-secondary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-primary)]";

function Divider() {
	return <span aria-hidden className="mx-1 h-5 w-px bg-[var(--color-line)]" />;
}

function FormatButton({ action }: { action: FormatAction }) {
	const Icon = action.icon;
	return (
		<button
			type="button"
			title={action.label}
			aria-label={action.label}
			// Keep the editor's focus + selection when pressing a toolbar button.
			onPointerDown={(event) => event.preventDefault()}
			onClick={() => dispatchFormat(action.command)}
			className={btn}
		>
			<Icon aria-hidden className="size-[17px]" />
		</button>
	);
}

/**
 * Persistent formatting toolbar above the writing surface (Substack-like).
 * Toggleable via studio settings, and hidden entirely in zen mode. Commands are
 * dispatched to whichever pane is active.
 */
export function TopFormatToolbar({
	disabled,
	onUndo,
	onRedo,
}: TopFormatToolbarProps) {
	return (
		<div
			role="toolbar"
			aria-label="Formatting"
			aria-disabled={disabled}
			className={cn(
				"flex shrink-0 items-center justify-center gap-0.5 border-b border-[var(--color-line)] bg-[var(--color-bg-app)] px-[var(--space-3)] py-1",
				disabled && "pointer-events-none opacity-40",
			)}
		>
			<button
				type="button"
				title="Undo"
				aria-label="Undo"
				onPointerDown={(e) => e.preventDefault()}
				onClick={onUndo}
				className={btn}
			>
				<Undo2 aria-hidden className="size-[17px]" />
			</button>
			<button
				type="button"
				title="Redo"
				aria-label="Redo"
				onPointerDown={(e) => e.preventDefault()}
				onClick={onRedo}
				className={btn}
			>
				<Redo2 aria-hidden className="size-[17px]" />
			</button>

			<Divider />

			{INLINE_ACTIONS.map((action) => (
				<FormatButton key={action.command} action={action} />
			))}

			<Divider />

			{BLOCK_ACTIONS.map((action) => (
				<FormatButton key={action.command} action={action} />
			))}
		</div>
	);
}
