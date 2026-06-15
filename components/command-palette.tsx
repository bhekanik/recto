"use client";

import { Command } from "cmdk";
import { ChevronRight, Eye, FileCode, Keyboard, Type } from "lucide-react";
import { useCallback, useEffect } from "react";
import {
	MODE_RING,
	type Mode,
	modeToLabel,
	nextMode,
	prevMode,
	type VimSubMode,
} from "@/lib/modes/types";
import { cn } from "@/lib/utils";

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: Mode;
	vimSubMode?: VimSubMode;
	onSwitchMode: (mode: Mode) => void;
};

const MODE_ICONS: Record<Mode, typeof Type> = {
	rich: Type,
	raw: FileCode,
	vim: Keyboard,
	preview: Eye,
};

export function CommandPalette({
	open,
	onOpenChange,
	mode,
	vimSubMode,
	onSwitchMode,
}: CommandPaletteProps) {
	const close = useCallback(() => onOpenChange(false), [onOpenChange]);

	const run = useCallback(
		(action: () => void) => {
			action();
			close();
		},
		[close],
	);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [open, close]);

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[min(20vh,8rem)]"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
		>
			<button
				type="button"
				className="absolute inset-0 bg-black/40"
				aria-label="Close command palette"
				onClick={close}
			/>
			<Command
				className="relative z-10 w-full max-w-md overflow-hidden rounded-[var(--radius-lg)] border border-border bg-[var(--color-bg-raised)] shadow-xl"
				onMouseDown={(event) => event.stopPropagation()}
				loop
			>
				<div className="border-b border-border px-3">
					<Command.Input
						placeholder="Type a command…"
						autoFocus
						className="h-11 w-full bg-transparent text-[length:var(--text-ui)] text-[var(--color-ink-primary)] outline-none placeholder:text-[var(--color-ink-tertiary)]"
					/>
				</div>
				<Command.List className="max-h-72 overflow-y-auto p-1">
					<Command.Empty className="px-3 py-6 text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
						No matching commands.
					</Command.Empty>

					<Command.Group
						heading="Mode"
						className="px-2 py-1 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
					>
						{MODE_RING.map((m) => {
							const Icon = MODE_ICONS[m];
							const active = mode === m;
							return (
								<Command.Item
									key={m}
									value={`mode ${modeToLabel(m)} ${m}`}
									onSelect={() => run(() => onSwitchMode(m))}
									className={cn(
										"flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)] aria-selected:bg-[var(--color-bg-hover)] aria-selected:text-[var(--color-ink-primary)]",
										active && "font-medium text-[var(--color-ink-primary)]",
									)}
								>
									<Icon className="size-4 shrink-0 opacity-70" aria-hidden />
									<span className="flex-1">
										Switch to{" "}
										{modeToLabel(m, m === "vim" ? vimSubMode : undefined)}
									</span>
									{active ? (
										<span className="text-[var(--color-ink-tertiary)]">
											Current
										</span>
									) : (
										<ChevronRight className="size-4 opacity-40" aria-hidden />
									)}
								</Command.Item>
							);
						})}
						<Command.Item
							value="mode next cycle"
							onSelect={() => run(() => onSwitchMode(nextMode(mode)))}
							className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)] aria-selected:bg-[var(--color-bg-hover)] aria-selected:text-[var(--color-ink-primary)]"
						>
							<ChevronRight
								className="size-4 shrink-0 opacity-70"
								aria-hidden
							/>
							<span className="flex-1">Next mode</span>
						</Command.Item>
						<Command.Item
							value="mode previous cycle"
							onSelect={() => run(() => onSwitchMode(prevMode(mode)))}
							className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)] aria-selected:bg-[var(--color-bg-hover)] aria-selected:text-[var(--color-ink-primary)]"
						>
							<ChevronRight
								className="size-4 shrink-0 rotate-180 opacity-70"
								aria-hidden
							/>
							<span className="flex-1">Previous mode</span>
						</Command.Item>
					</Command.Group>
				</Command.List>
			</Command>
		</div>
	);
}
