"use client";

import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { type DiffRun, groupHunks } from "@/lib/history/diff";
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

type DiffHunksBodyProps = {
	runs: DiffRun[];
	/** Hunk indices currently marked to accept (see lib/history/diff.groupHunks). */
	accepted: Set<number>;
	/** Toggle one hunk's accept/reject state. */
	onToggleHunk: (index: number) => void;
};

/**
 * Interactive per-hunk diff renderer for the owner review surface. Groups the
 * inline runs into hunks (same `groupHunks` the server uses) and renders each hunk
 * as its own block with an accept/reject toggle — `same` context flows as plain
 * text between hunks. An ACCEPTED hunk shows the branch's proposed text (add green /
 * del struck); a REJECTED hunk dims to show the change will be discarded (the
 * owner's current text is kept). Inline-only: per-hunk controls need the runs in
 * document order, so the side-by-side split (which reorders adds/dels into columns)
 * is not offered here — the layout toggle is hidden while reviewing hunks.
 *
 * Reuses the EXACT OKLCH add/del washes from {@link DiffRunsBody} so an accepted
 * hunk is visually identical to the read-only diff.
 */
export function DiffHunksBody({
	runs,
	accepted,
	onToggleHunk,
}: DiffHunksBodyProps) {
	const hunks = groupHunks(runs);
	if (hunks.length === 0) {
		return <p className="text-[var(--color-ink-tertiary)]">No changes.</p>;
	}

	// Position of each hunk's first run, so we can interleave the `same` context
	// runs that sit between hunks in their natural document order.
	const hunkByFirstRun = new Map<number, (typeof hunks)[number]>();
	for (const hunk of hunks) {
		const first = hunk.runIndices[0];
		if (first !== undefined) hunkByFirstRun.set(first, hunk);
	}
	const hunkRunSet = new Set<number>();
	for (const hunk of hunks)
		for (const ri of hunk.runIndices) hunkRunSet.add(ri);

	const blocks: ReactNode[] = [];
	for (let i = 0; i < runs.length; i++) {
		const run = runs[i];
		if (!run) continue;
		// `same` context between hunks — render inline, muted, non-interactive.
		if (!hunkRunSet.has(i)) {
			blocks.push(
				<span
					key={`ctx-${i}`}
					className="whitespace-pre-wrap text-[var(--color-ink-tertiary)]"
				>
					{run.text}
				</span>,
			);
			continue;
		}
		// Start-of-hunk → emit the whole hunk block once.
		const hunk = hunkByFirstRun.get(i);
		if (!hunk) continue; // mid-hunk run, already emitted by its hunk block
		const isAccepted = accepted.has(hunk.index);
		blocks.push(
			<span
				key={`hunk-${hunk.index}`}
				className={cn(
					"relative my-0.5 inline-flex flex-wrap items-baseline gap-1 rounded-[var(--radius-sm)] px-1 align-baseline",
					isAccepted
						? "ring-1 ring-[var(--color-line)]"
						: "opacity-40 saturate-50",
				)}
			>
				<span className="whitespace-pre-wrap">
					{hunk.runIndices.map((ri) => {
						const r = runs[ri];
						if (!r) return null;
						return (
							<span
								key={ri}
								className={cn(
									r.type === "add" &&
										"bg-[oklch(0.8_0.09_150/0.12)] text-[var(--color-success)]",
									r.type === "del" &&
										"bg-[oklch(0.7_0.14_25/0.12)] text-[var(--color-danger)] line-through",
								)}
							>
								{r.text}
							</span>
						);
					})}
				</span>
				<button
					type="button"
					onClick={() => onToggleHunk(hunk.index)}
					aria-pressed={isAccepted}
					aria-label={
						isAccepted
							? `Reject change ${hunk.index + 1}`
							: `Accept change ${hunk.index + 1}`
					}
					title={isAccepted ? "Reject this change" : "Accept this change"}
					className={cn(
						"inline-flex size-4 shrink-0 items-center justify-center rounded-full border align-baseline transition-colors",
						isAccepted
							? "border-[var(--color-success)] text-[var(--color-success)] hover:bg-[oklch(0.8_0.09_150/0.16)]"
							: "border-[var(--color-line)] text-[var(--color-ink-tertiary)] hover:text-[var(--color-ink-primary)]",
					)}
				>
					{isAccepted ? (
						<Check aria-hidden className="size-2.5" />
					) : (
						<X aria-hidden className="size-2.5" />
					)}
				</button>
			</span>,
		);
	}

	return <p className="whitespace-pre-wrap leading-relaxed">{blocks}</p>;
}
