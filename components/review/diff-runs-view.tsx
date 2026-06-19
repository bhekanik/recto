"use client";

import type { DiffRun } from "@/lib/history/diff";
import type {
	DiffGranularity,
	DiffLayout,
} from "@/lib/studio/use-studio-settings";
import { cn } from "@/lib/utils";

type DiffRunsToggleProps = {
	granularity: DiffGranularity;
	layout: DiffLayout;
	onToggleGranularity: () => void;
	onToggleLayout: () => void;
};

/**
 * Granularity/layout toggle bar for a diff. Relocated verbatim from
 * history-panel.tsx and review-surface.tsx (which were byte-identical here).
 * Rendered as a direct child of the diff container, a sibling of the scroll
 * wrapper that holds {@link DiffRunsBody}.
 */
export function DiffRunsToggle({
	granularity,
	layout,
	onToggleGranularity,
	onToggleLayout,
}: DiffRunsToggleProps) {
	return (
		<div className="flex shrink-0 items-center gap-[var(--space-2)] px-[var(--space-3)] py-1.5 text-[0.6875rem] text-[var(--color-ink-tertiary)]">
			<button
				type="button"
				onClick={onToggleGranularity}
				className="transition-colors hover:text-[var(--color-ink-primary)]"
			>
				{granularity === "word" ? "Word" : "Line"} diff
			</button>
			<span aria-hidden>·</span>
			<button
				type="button"
				onClick={onToggleLayout}
				className="transition-colors hover:text-[var(--color-ink-primary)]"
			>
				{layout === "inline" ? "Inline" : "Side by side"}
			</button>
		</div>
	);
}

type DiffRunsBodyProps = {
	runs: DiffRun[];
	layout: DiffLayout;
};

/**
 * The positional diff-run renderer (inline or side-by-side). Relocated verbatim
 * from history-panel.tsx and review-surface.tsx (byte-identical, down to the
 * OKLCH add/del wash literals). Rendered inside each caller's own scroll
 * wrapper, after {@link DiffRunsToggle}.
 */
export function DiffRunsBody({ runs, layout }: DiffRunsBodyProps) {
	return layout === "inline" ? (
		<p className="whitespace-pre-wrap">
			{runs.map((run, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: diff is positional
					key={i}
					className={cn(
						run.type === "add" &&
							"bg-[oklch(0.8_0.09_150/0.12)] text-[var(--color-success)]",
						run.type === "del" &&
							"bg-[oklch(0.7_0.14_25/0.12)] text-[var(--color-danger)] line-through",
						run.type === "same" && "text-[var(--color-ink-tertiary)]",
					)}
				>
					{run.text}
				</span>
			))}
		</p>
	) : (
		<div className="grid grid-cols-2 gap-[var(--space-3)]">
			<div className="whitespace-pre-wrap">
				{runs
					.filter((r) => r.type !== "add")
					.map((run, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: diff is positional
							key={i}
							className={cn(
								run.type === "del" &&
									"bg-[oklch(0.7_0.14_25/0.12)] text-[var(--color-danger)]",
								run.type === "same" && "text-[var(--color-ink-tertiary)]",
							)}
						>
							{run.text}
						</span>
					))}
			</div>
			<div className="whitespace-pre-wrap">
				{runs
					.filter((r) => r.type !== "del")
					.map((run, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: diff is positional
							key={i}
							className={cn(
								run.type === "add" &&
									"bg-[oklch(0.8_0.09_150/0.12)] text-[var(--color-success)]",
								run.type === "same" && "text-[var(--color-ink-tertiary)]",
							)}
						>
							{run.text}
						</span>
					))}
			</div>
		</div>
	);
}
