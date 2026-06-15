"use client";

import { Eye, FileCode, Keyboard, Type } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	MODE_RING,
	type Mode,
	modeToLabel,
	type VimSubMode,
} from "@/lib/modes/types";
import { cn } from "@/lib/utils";

const MODE_META: Record<
	Mode,
	{ label: string; short: string; icon: typeof Type }
> = {
	rich: { label: "Rich text", short: "Rich", icon: Type },
	raw: { label: "Raw Markdown", short: "Raw", icon: FileCode },
	vim: { label: "Vim", short: "Vim", icon: Keyboard },
	preview: { label: "Preview", short: "Preview", icon: Eye },
};

type ModeToolbarProps = {
	mode: Mode;
	vimSubMode?: VimSubMode;
	onModeChange: (mode: Mode) => void;
	onOpenCommandPalette: () => void;
};

export function ModeToolbar({
	mode,
	vimSubMode,
	onModeChange,
	onOpenCommandPalette,
}: ModeToolbarProps) {
	const modeLabel = modeToLabel(mode, vimSubMode);

	return (
		<div className="flex items-center gap-[var(--space-2)]">
			<span
				className="hidden rounded-[var(--radius-md)] border border-border bg-[var(--color-bg-raised)] px-2 py-0.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)] sm:inline"
				aria-live="polite"
			>
				{modeLabel}
			</span>

			<div
				className="flex items-center rounded-[var(--radius-md)] border border-border bg-[var(--color-bg-raised)] p-0.5"
				role="toolbar"
				aria-label="Editor mode"
			>
				{MODE_RING.map((m) => {
					const meta = MODE_META[m];
					const Icon = meta.icon;
					const active = mode === m;
					return (
						<Button
							key={m}
							type="button"
							variant={active ? "secondary" : "ghost"}
							size="xs"
							className={cn("gap-1 px-2", active && "shadow-sm")}
							aria-pressed={active}
							title={meta.label}
							onClick={() => onModeChange(m)}
						>
							<Icon aria-hidden />
							<span className="hidden md:inline">{meta.short}</span>
						</Button>
					);
				})}
			</div>

			<Button
				type="button"
				variant="outline"
				size="xs"
				className="hidden text-[var(--color-ink-tertiary)] sm:inline-flex"
				onClick={onOpenCommandPalette}
				title="Command palette (⌘K)"
			>
				<span className="text-[length:var(--text-ui-sm)]">⌘K</span>
			</Button>
		</div>
	);
}
