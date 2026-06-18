"use client";

import type { ReactNode } from "react";

import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import type { GoalKind } from "@/lib/stats/streak";
import type { GoalScope, GoalStyle } from "@/lib/studio/use-studio-settings";
import { cn } from "@/lib/utils";

const KIND_OPTIONS: { value: GoalKind; label: string }[] = [
	{ value: "at-least", label: "At least" },
	{ value: "about", label: "About" },
	{ value: "at-most", label: "At most" },
];

const SCOPE_OPTIONS: { value: GoalScope; label: string }[] = [
	{ value: "document", label: "Document" },
	{ value: "daily", label: "Daily" },
];

const STYLE_OPTIONS: { value: GoalStyle; label: string }[] = [
	{ value: "ring", label: "Ring" },
	{ value: "bar", label: "Bar" },
];

type SegmentedProps<T extends string> = {
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
};

/** A compact segmented control matching the status-bar toggle density. */
function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: SegmentedProps<T>) {
	return (
		<fieldset className="flex flex-col gap-1 border-0 p-0">
			<legend className="mb-1 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
				{label}
			</legend>
			<div className="flex items-center gap-0.5 rounded-[var(--radius-sm)] bg-[var(--color-bg-app)] p-0.5">
				{options.map((opt) => {
					const active = opt.value === value;
					return (
						<button
							key={opt.value}
							type="button"
							aria-pressed={active}
							onClick={() => onChange(opt.value)}
							className={cn(
								"flex-1 rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--text-ui-sm)] transition-colors duration-[var(--motion-instant)]",
								active
									? "bg-[var(--color-accent-wash)] text-[var(--color-ink-primary)]"
									: "text-[var(--color-ink-tertiary)] hover:text-[var(--color-ink-secondary)]",
							)}
						>
							{opt.label}
						</button>
					);
				})}
			</div>
		</fieldset>
	);
}

export type GoalPopoverProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The trigger contents (the status-bar goal widget / set-goal affordance). */
	children: ReactNode;
	/** Accessible name + tooltip for the trigger button. */
	triggerLabel: string;
	/** Class string for the trigger button. */
	triggerClassName?: string;
	wordGoalTarget: number;
	onWordGoalTargetChange: (target: number) => void;
	dailyGoalTarget: number;
	onDailyGoalTargetChange: (target: number) => void;
	wordGoalKind: GoalKind;
	onWordGoalKindChange: (kind: GoalKind) => void;
	goalScope: GoalScope;
	onGoalScopeChange: (scope: GoalScope) => void;
	goalStyle: GoalStyle;
	onGoalStyleChange: (style: GoalStyle) => void;
};

const numberInput =
	"h-7 w-full rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-app)] px-2 text-[length:var(--text-ui-sm)] tabular-nums text-[var(--color-ink-primary)] outline-none transition-colors duration-[var(--motion-instant)] focus-visible:border-[var(--color-accent)]";

/**
 * Quiet popover for configuring word goals — per-device targets plus the two A/B
 * toggles (ring vs bar, document vs daily scope). Display-only; never blocks
 * typing. Styled with existing OKLCH tokens only. (plan 002)
 */
export function GoalPopover({
	open,
	onOpenChange,
	children,
	triggerLabel,
	triggerClassName,
	wordGoalTarget,
	onWordGoalTargetChange,
	dailyGoalTarget,
	onDailyGoalTargetChange,
	wordGoalKind,
	onWordGoalKindChange,
	goalScope,
	onGoalScopeChange,
	goalStyle,
	onGoalStyleChange,
}: GoalPopoverProps) {
	return (
		<Popover open={open} onOpenChange={(next) => onOpenChange(next)}>
			<PopoverTrigger
				className={cn("flex items-center", triggerClassName)}
				title={triggerLabel}
				aria-label={triggerLabel}
			>
				{children}
			</PopoverTrigger>
			<PopoverContent
				align="end"
				side="top"
				className="flex w-64 flex-col gap-3 border border-[var(--color-line)] bg-[var(--color-bg-raised)] p-3"
			>
				<div className="flex flex-col gap-1">
					<label
						htmlFor="recto-word-goal"
						className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]"
					>
						Document word goal
					</label>
					<input
						id="recto-word-goal"
						type="number"
						min={0}
						step={50}
						inputMode="numeric"
						value={wordGoalTarget || ""}
						placeholder="No goal"
						onChange={(e) =>
							onWordGoalTargetChange(Number(e.target.value) || 0)
						}
						className={numberInput}
					/>
				</div>

				<Segmented
					label="Goal direction"
					value={wordGoalKind}
					options={KIND_OPTIONS}
					onChange={onWordGoalKindChange}
				/>

				<div className="flex flex-col gap-1">
					<label
						htmlFor="recto-daily-goal"
						className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]"
					>
						Daily word goal
					</label>
					<input
						id="recto-daily-goal"
						type="number"
						min={0}
						step={50}
						inputMode="numeric"
						value={dailyGoalTarget || ""}
						placeholder="No daily goal"
						onChange={(e) =>
							onDailyGoalTargetChange(Number(e.target.value) || 0)
						}
						className={numberInput}
					/>
				</div>

				<Segmented
					label="Track"
					value={goalScope}
					options={SCOPE_OPTIONS}
					onChange={onGoalScopeChange}
				/>

				<Segmented
					label="Display"
					value={goalStyle}
					options={STYLE_OPTIONS}
					onChange={onGoalStyleChange}
				/>
			</PopoverContent>
		</Popover>
	);
}
