"use client";

import {
	Eye,
	FileCode,
	Keyboard,
	Minus,
	Palette,
	Plus,
	SpellCheck,
	SquareDashed,
	Type,
} from "lucide-react";

import {
	MODE_RING,
	type Mode,
	modeToLabel,
	type VimSubMode,
} from "@/lib/modes/types";
import {
	type ReadingFont,
	THEMES,
	type Theme,
} from "@/lib/studio/use-studio-settings";
import type { SyncStatus } from "@/lib/sync/use-document-sync";
import { cn } from "@/lib/utils";

const MODE_ICON: Record<Mode, typeof Type> = {
	rich: Type,
	raw: FileCode,
	vim: Keyboard,
	preview: Eye,
};

type StatusBarProps = {
	wordCount: number;
	syncStatus: SyncStatus;
	mode: Mode;
	vimSubMode?: VimSubMode;
	onModeChange: (mode: Mode) => void;
	theme: Theme;
	onCycleTheme: () => void;
	readingFont: ReadingFont;
	onToggleFont: () => void;
	readingScale: number;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onZoomReset: () => void;
	canZoomIn: boolean;
	canZoomOut: boolean;
	spellcheck: boolean;
	onToggleSpellcheck: () => void;
	zen: boolean;
	onToggleZen: () => void;
};

function formatWordCount(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "word" : "words"}`;
}

const SYNC_META: Record<
	SyncStatus,
	{ label: string; dot: string; text: string } | null
> = {
	idle: null,
	saving: {
		label: "Saving",
		dot: "animate-pulse bg-[var(--color-ink-tertiary)]",
		text: "text-[var(--color-ink-tertiary)]",
	},
	saved: {
		label: "Saved",
		dot: "bg-[var(--color-success)]",
		text: "text-[var(--color-ink-tertiary)]",
	},
	unsynced: {
		label: "Unsynced",
		dot: "bg-[var(--color-warning)]",
		text: "text-[var(--color-warning)]",
	},
};

// Fixed-width slot with an always-present (transparent when idle) dot, so the
// label flipping between Saving/Saved/Unsynced never reflows its neighbours.
function SyncIndicator({ status }: { status: SyncStatus }) {
	const meta = SYNC_META[status];
	return (
		<span
			className={cn(
				"flex items-center gap-[var(--space-2)]",
				meta?.text ?? "text-[var(--color-ink-tertiary)]",
			)}
		>
			<span
				className={cn(
					"h-[6px] w-[6px] rounded-full",
					meta?.dot ?? "bg-transparent",
				)}
				aria-hidden="true"
			/>
			<span className="inline-block min-w-[3.75rem]">{meta?.label ?? ""}</span>
		</span>
	);
}

const iconBtn =
	"flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-secondary)] disabled:pointer-events-none disabled:opacity-40";

function ModeSwitcher({
	mode,
	onModeChange,
}: {
	mode: Mode;
	onModeChange: (mode: Mode) => void;
}) {
	return (
		<div role="toolbar" aria-label="Editor mode" className="flex items-center">
			{MODE_RING.map((m) => {
				const Icon = MODE_ICON[m];
				const active = mode === m;
				return (
					<button
						key={m}
						type="button"
						aria-pressed={active}
						title={modeToLabel(m)}
						onClick={() => onModeChange(m)}
						className={cn(
							"flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[length:var(--text-ui-sm)] transition-colors duration-[var(--motion-instant)]",
							active
								? "bg-[var(--color-accent-wash)] text-[var(--color-ink-primary)]"
								: "text-[var(--color-ink-tertiary)] hover:text-[var(--color-ink-secondary)]",
						)}
					>
						<Icon aria-hidden className="size-[14px]" />
						<span className="hidden sm:inline">{modeToLabel(m)}</span>
					</button>
				);
			})}
		</div>
	);
}

export function StatusBar({
	wordCount,
	syncStatus,
	mode,
	onModeChange,
	theme,
	onCycleTheme,
	readingFont,
	onToggleFont,
	readingScale,
	onZoomIn,
	onZoomOut,
	onZoomReset,
	canZoomIn,
	canZoomOut,
	spellcheck,
	onToggleSpellcheck,
	zen,
	onToggleZen,
}: StatusBarProps) {
	const zoomPct = Math.round(readingScale * 100);
	const themeLabel = THEMES.find((t) => t.id === theme)?.label ?? theme;

	return (
		<footer
			className="flex h-8 shrink-0 items-center justify-between gap-[var(--space-3)] border-t border-[var(--color-line)] bg-[var(--color-bg-raised)] px-[var(--space-3)] text-[length:var(--text-ui-sm)] leading-[var(--leading-ui-sm)]"
			role="status"
			aria-live="off"
		>
			<ModeSwitcher mode={mode} onModeChange={onModeChange} />

			<div className="flex items-center gap-[var(--space-2)]">
				{/* Colour theme — click to cycle through the calm palettes */}
				<button
					type="button"
					onClick={onCycleTheme}
					title={`Theme: ${themeLabel} — click to cycle`}
					aria-label={`Theme: ${themeLabel}. Click to change theme`}
					className="flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-secondary)]"
				>
					<Palette
						aria-hidden
						className="size-[14px] text-[var(--color-accent)]"
					/>
					<span className="hidden sm:inline">{themeLabel}</span>
				</button>

				<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />

				{/* Body font: sans / serif */}
				<button
					type="button"
					onClick={onToggleFont}
					title={`Body font: ${readingFont === "serif" ? "Serif" : "Sans"} — click to switch`}
					aria-label="Toggle body font"
					className="flex h-6 items-center rounded-[var(--radius-sm)] px-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-secondary)]"
				>
					<span
						className={cn(
							readingFont === "serif"
								? "font-[family-name:var(--font-app-serif)]"
								: "font-[family-name:var(--font-app-sans)]",
						)}
					>
						{readingFont === "serif" ? "Serif" : "Sans"}
					</span>
				</button>

				<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />

				{/* Text zoom */}
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						className={iconBtn}
						onClick={onZoomOut}
						disabled={!canZoomOut}
						title="Smaller text"
						aria-label="Decrease text size"
					>
						<Minus aria-hidden className="size-[14px]" />
					</button>
					<button
						type="button"
						onClick={onZoomReset}
						title="Reset text size"
						aria-label="Reset text size"
						className="min-w-[3ch] rounded-[var(--radius-sm)] px-1 text-center tabular-nums text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:text-[var(--color-ink-secondary)]"
					>
						{zoomPct}%
					</button>
					<button
						type="button"
						className={iconBtn}
						onClick={onZoomIn}
						disabled={!canZoomIn}
						title="Bigger text"
						aria-label="Increase text size"
					>
						<Plus aria-hidden className="size-[14px]" />
					</button>
				</div>

				<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />

				<button
					type="button"
					className={cn(iconBtn, spellcheck && "text-[var(--color-accent)]")}
					onClick={onToggleSpellcheck}
					aria-pressed={spellcheck}
					title={`Spellcheck: ${spellcheck ? "On" : "Off"}`}
					aria-label="Toggle spellcheck"
				>
					<SpellCheck aria-hidden className="size-[15px]" />
				</button>

				<button
					type="button"
					className={iconBtn}
					onClick={onToggleZen}
					aria-pressed={zen}
					title="Zen mode (hide everything but the page)"
					aria-label="Toggle zen mode"
				>
					<SquareDashed aria-hidden className="size-[15px]" />
				</button>

				<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />

				<span className="inline-block min-w-[4.5rem] cursor-default text-right tabular-nums text-[var(--color-ink-tertiary)]">
					{formatWordCount(wordCount)}
				</span>
				<span aria-hidden className="text-[var(--color-line-strong)]">
					·
				</span>
				<SyncIndicator status={syncStatus} />
			</div>
		</footer>
	);
}
