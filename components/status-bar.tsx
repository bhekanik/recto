"use client";

import {
	AlignVerticalJustifyCenter,
	Eye,
	FileCode,
	Flame,
	Highlighter,
	Keyboard,
	Minus,
	Monitor,
	Moon,
	Palette,
	Plus,
	ScanText,
	SpellCheck,
	SquareDashed,
	Sun,
	Type,
} from "lucide-react";

import { GoalPopover } from "@/components/goal-popover";
import { formatReadingTime } from "@/lib/markdown";
import { MODE_RING, type Mode, modeToLabel } from "@/lib/modes/types";
import type { GoalKind, GoalProgress } from "@/lib/stats/streak";
import {
	APPEARANCES,
	type Appearance,
	type FocusScope,
	type GoalScope,
	type GoalStyle,
	type ReadingFont,
	THEMES,
	type Theme,
} from "@/lib/studio/use-studio-settings";
import type { SyncStatus } from "@/lib/sync/use-document-sync";
import { cn } from "@/lib/utils";

const APPEARANCE_ICON: Record<Appearance, typeof Type> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const MODE_ICON: Record<Mode, typeof Type> = {
	rich: Type,
	raw: FileCode,
	vim: Keyboard,
	preview: Eye,
};

type StatusBarProps = {
	wordCount: number;
	readingMinutes: number;
	syncStatus: SyncStatus;
	/**
	 * Present only when the server has REFUSED a write. Re-sending it cannot
	 * help, so the indicator becomes the writer's way out: discard the refused
	 * write and keep the text, which their next edit saves as a new change.
	 */
	onResolveBlocked?: () => void;
	mode: Mode;
	onModeChange: (mode: Mode) => void;
	theme: Theme;
	onCycleTheme: () => void;
	appearance: Appearance;
	onCycleAppearance: () => void;
	/** Resolved light/dark — the dark palettes are inert while this is light. */
	resolvedAppearance: "light" | "dark";
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
	// Prose linter (plan 004) — opt-in, highlight-only. Count is optional.
	lint: boolean;
	onToggleLint: () => void;
	lintCount: number;
	// Focus mode (plan 003) — typewriter scroll + sentence/paragraph dimming.
	typewriter: boolean;
	onToggleTypewriter: () => void;
	focusDim: boolean;
	onToggleFocusDim: () => void;
	focusDimScope: FocusScope;
	onCycleDimScope: () => void;
	zen: boolean;
	onToggleZen: () => void;
	// Word goals / session / streak (plan 002) — display-only, never nags.
	goalStyle: GoalStyle;
	goalProgress: GoalProgress;
	goalTarget: number; // 0 = hide the widget
	goalLabel: string;
	sessionWords: number;
	streakDays: number;
	goalConfigOpen: boolean;
	onGoalConfigOpenChange: (open: boolean) => void;
	wordGoalTarget: number;
	onWordGoalTargetChange: (target: number) => void;
	dailyGoalTarget: number;
	onDailyGoalTargetChange: (target: number) => void;
	wordGoalKind: GoalKind;
	onWordGoalKindChange: (kind: GoalKind) => void;
	goalScope: GoalScope;
	onGoalScopeChange: (scope: GoalScope) => void;
	onGoalStyleChange: (style: GoalStyle) => void;
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
	unresolved: {
		label: "Not synced",
		dot: "bg-[var(--color-danger)]",
		text: "text-[var(--color-danger)]",
	},
};

// Fixed-width slot with an always-present (transparent when idle) dot, so the
// label flipping between Saving/Saved/Unsynced never reflows its neighbours.
function SyncIndicator({
	status,
	onResolveBlocked,
}: {
	status: SyncStatus;
	onResolveBlocked?: () => void;
}) {
	const meta = SYNC_META[status];
	const body = (
		<>
			<span
				className={cn(
					"h-[6px] w-[6px] rounded-full",
					meta?.dot ?? "bg-transparent",
				)}
				aria-hidden="true"
			/>
			<span className="hidden min-w-[3.75rem] sm:inline-block">
				{meta?.label ?? ""}
			</span>
		</>
	);
	const className = cn(
		"flex items-center gap-[var(--space-2)]",
		meta?.text ?? "text-[var(--color-ink-tertiary)]",
	);
	// "Not synced" is the one status a writer can do something about, so when
	// there is something to do it is a control rather than a label.
	if (onResolveBlocked) {
		return (
			<button
				type="button"
				className={cn(className, "underline decoration-dotted")}
				onClick={onResolveBlocked}
				title="This change was refused by the server. Discard it and keep your text — your next edit saves it as a new change."
			>
				{body}
			</button>
		);
	}
	return <span className={className}>{body}</span>;
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

// Inline progress indicator — a ~14px ring or a thin bar — driven by the goal
// ratio. Custom SVG is lighter than a charting lib for one ring (plan-justified).
// Coloured with existing OKLCH tokens only; success tint when the goal is met.
function GoalIndicator({
	style,
	progress,
}: {
	style: GoalStyle;
	progress: GoalProgress;
}) {
	const fill = progress.met ? "var(--color-success)" : "var(--color-accent)";

	if (style === "bar") {
		return (
			<span
				aria-hidden
				className="block h-[5px] w-10 overflow-hidden rounded-full bg-[var(--color-line)]"
			>
				<span
					className="block h-full rounded-full transition-[width] duration-[var(--motion-base)]"
					style={{
						width: `${Math.round(progress.ratio * 100)}%`,
						backgroundColor: fill,
					}}
				/>
			</span>
		);
	}

	// Ring: a 14px circle, r=5, circumference ≈ 31.42; dashoffset shows progress.
	const r = 5;
	const circumference = 2 * Math.PI * r;
	const offset = circumference * (1 - progress.ratio);
	return (
		<svg aria-hidden role="img" width="14" height="14" viewBox="0 0 14 14">
			<title>Goal progress</title>
			<circle
				cx="7"
				cy="7"
				r={r}
				fill="none"
				stroke="var(--color-line)"
				strokeWidth="2"
			/>
			<circle
				cx="7"
				cy="7"
				r={r}
				fill="none"
				stroke={fill}
				strokeWidth="2"
				strokeLinecap="round"
				strokeDasharray={circumference}
				strokeDashoffset={offset}
				transform="rotate(-90 7 7)"
				style={{ transition: "stroke-dashoffset var(--motion-base)" }}
			/>
		</svg>
	);
}

export function StatusBar({
	wordCount,
	readingMinutes,
	syncStatus,
	onResolveBlocked,
	mode,
	onModeChange,
	theme,
	onCycleTheme,
	appearance,
	onCycleAppearance,
	resolvedAppearance,
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
	lint,
	onToggleLint,
	lintCount,
	typewriter,
	onToggleTypewriter,
	focusDim,
	onToggleFocusDim,
	focusDimScope,
	onCycleDimScope,
	zen,
	onToggleZen,
	goalStyle,
	goalProgress,
	goalTarget,
	goalLabel,
	sessionWords,
	streakDays,
	goalConfigOpen,
	onGoalConfigOpenChange,
	wordGoalTarget,
	onWordGoalTargetChange,
	dailyGoalTarget,
	onDailyGoalTargetChange,
	wordGoalKind,
	onWordGoalKindChange,
	goalScope,
	onGoalScopeChange,
	onGoalStyleChange,
}: StatusBarProps) {
	const zoomPct = Math.round(readingScale * 100);
	const darkPalettes = resolvedAppearance === "dark";
	// Paper is the one light palette, so that is what the picker reports while the
	// appearance resolves to light — the stored dark palette is simply dormant.
	const themeLabel = darkPalettes
		? (THEMES.find((t) => t.id === theme)?.label ?? theme)
		: "Paper";
	const appearanceMeta = APPEARANCES.find((a) => a.id === appearance);
	const appearanceLabel = appearanceMeta?.label ?? appearance;
	const AppearanceIcon = APPEARANCE_ICON[appearance];

	return (
		<footer
			className="flex h-8 shrink-0 items-center justify-between gap-[var(--space-3)] border-t border-[var(--color-line)] bg-[var(--color-bg-raised)] px-[var(--space-3)] text-[length:var(--text-ui-sm)] leading-[var(--leading-ui-sm)]"
			role="status"
			aria-live="off"
		>
			<ModeSwitcher mode={mode} onModeChange={onModeChange} />

			<div className="flex items-center gap-[var(--space-2)]">
				{/* Appearance — system / light / dark (ADR-20) */}
				<button
					type="button"
					onClick={onCycleAppearance}
					title={`Appearance: ${appearanceLabel} — click to cycle`}
					aria-label={`Appearance: ${appearanceLabel}. Click to change appearance`}
					className="flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-secondary)]"
				>
					<AppearanceIcon
						aria-hidden
						className="size-[14px] text-[var(--color-accent)]"
					/>
					<span className="hidden sm:inline">{appearanceLabel}</span>
				</button>

				{/* Colour theme — click to cycle through the calm palettes. Disabled in
				    light: Paper is the only light palette (ADR-20). */}
				<button
					type="button"
					onClick={onCycleTheme}
					disabled={!darkPalettes}
					title={
						darkPalettes
							? `Palette: ${themeLabel} — click to cycle`
							: "Palette: Paper — the other palettes need a dark appearance"
					}
					aria-label={`Palette: ${themeLabel}. Click to change palette`}
					className="flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-secondary)] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-[var(--color-ink-tertiary)]"
				>
					<Palette
						aria-hidden
						className="size-[14px] text-[var(--color-accent)]"
					/>
					<span className="hidden sm:inline">{themeLabel}</span>
				</button>

				{/* Secondary controls — folded away on phones; all remain reachable
				    from the command palette. */}
				<div className="hidden items-center gap-[var(--space-2)] sm:flex">
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

					{/* Prose linter — opt-in mechanics highlights (passive/adverb/long/weasel). */}
					<button
						type="button"
						className={cn(iconBtn, lint && "text-[var(--color-accent)]")}
						onClick={onToggleLint}
						aria-pressed={lint}
						title={`Prose linter: ${lint ? "On" : "Off"}`}
						aria-label="Toggle prose linter"
					>
						<ScanText aria-hidden className="size-[15px]" />
					</button>
					{lint && lintCount > 0 && (
						<span
							className="tabular-nums text-[var(--color-ink-tertiary)]"
							title={`${lintCount} prose ${lintCount === 1 ? "suggestion" : "suggestions"}`}
						>
							{lintCount.toLocaleString()}
						</span>
					)}

					<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />

					{/* Focus mode — typewriter scroll + sentence/paragraph dimming. */}
					<button
						type="button"
						className={cn(iconBtn, typewriter && "text-[var(--color-accent)]")}
						onClick={onToggleTypewriter}
						aria-pressed={typewriter}
						title={`Typewriter scrolling: ${typewriter ? "On" : "Off"}`}
						aria-label="Toggle typewriter scrolling"
					>
						<AlignVerticalJustifyCenter aria-hidden className="size-[15px]" />
					</button>
					<button
						type="button"
						className={cn(iconBtn, focusDim && "text-[var(--color-accent)]")}
						onClick={onToggleFocusDim}
						aria-pressed={focusDim}
						title={`Focus dimming: ${focusDim ? "On" : "Off"}`}
						aria-label="Toggle focus dimming"
					>
						<Highlighter aria-hidden className="size-[15px]" />
					</button>
					{focusDim && (
						<button
							type="button"
							onClick={onCycleDimScope}
							title={`Focus scope: ${focusDimScope === "sentence" ? "Sentence" : "Paragraph"} — click to switch`}
							aria-label="Cycle focus dim scope"
							className="flex h-6 items-center rounded-[var(--radius-sm)] px-2 text-[length:var(--text-ui-sm)] capitalize text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-secondary)]"
						>
							{focusDimScope}
						</button>
					)}

					{/* Session words + writing streak — quiet, no animation, no nag. */}
					{(sessionWords > 0 || streakDays > 0) && (
						<>
							<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />
							<span className="flex items-center gap-[var(--space-2)] tabular-nums text-[var(--color-ink-tertiary)]">
								{sessionWords > 0 && (
									<span
										title={`${sessionWords.toLocaleString()} words written this session`}
									>
										+{sessionWords.toLocaleString()}
									</span>
								)}
								{streakDays > 0 && (
									<span
										className="flex items-center gap-1"
										title={`${streakDays}-day writing streak`}
									>
										<Flame
											aria-hidden
											className="size-[14px] text-[var(--color-accent)]"
										/>
										{streakDays}
									</span>
								)}
							</span>
						</>
					)}
				</div>

				{/* Goal widget — the ring/bar shows only when a goal is set. When no
				    goal exists, no permanent control is shown (§6); the popover is
				    still reachable from the command palette, and a transient "Set
				    goal" trigger is mounted only while that popover is open so it can
				    anchor. */}
				{(goalTarget > 0 || goalConfigOpen) && (
					<>
						<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />
						<GoalPopover
							open={goalConfigOpen}
							onOpenChange={onGoalConfigOpenChange}
							triggerLabel={goalLabel}
							triggerClassName="flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-secondary)]"
							wordGoalTarget={wordGoalTarget}
							onWordGoalTargetChange={onWordGoalTargetChange}
							dailyGoalTarget={dailyGoalTarget}
							onDailyGoalTargetChange={onDailyGoalTargetChange}
							wordGoalKind={wordGoalKind}
							onWordGoalKindChange={onWordGoalKindChange}
							goalScope={goalScope}
							onGoalScopeChange={onGoalScopeChange}
							goalStyle={goalStyle}
							onGoalStyleChange={onGoalStyleChange}
						>
							{goalTarget > 0 ? (
								<GoalIndicator style={goalStyle} progress={goalProgress} />
							) : (
								"Set goal"
							)}
						</GoalPopover>
					</>
				)}

				<span aria-hidden className="h-3.5 w-px bg-[var(--color-line)]" />

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

				<span className="hidden cursor-default text-right tabular-nums text-[var(--color-ink-tertiary)] min-[360px]:inline-block sm:min-w-[4.5rem]">
					{formatWordCount(wordCount)}
				</span>
				{/* Estimated reading time — folds away with the word count on phones. */}
				<span
					aria-hidden
					className="hidden text-[var(--color-line-strong)] sm:inline"
				>
					·
				</span>
				<span
					className="hidden cursor-default tabular-nums text-[var(--color-ink-tertiary)] sm:inline-block"
					title="Estimated reading time"
				>
					{formatReadingTime(readingMinutes)}
				</span>
				<span
					aria-hidden
					className="hidden text-[var(--color-line-strong)] min-[360px]:inline"
				>
					·
				</span>
				<SyncIndicator
					status={syncStatus}
					onResolveBlocked={onResolveBlocked}
				/>
			</div>
		</footer>
	);
}
