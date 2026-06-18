"use client";

import { useMutation, useQuery } from "convex/react";
import { Check, GitBranch, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { diffRuns } from "@/lib/history/diff";
import { useStudioSettingsContext } from "@/lib/studio/settings-context";
import { cn } from "@/lib/utils";

type ReviewBranchRow = {
	_id: Id<"reviewBranches">;
	reviewerUserId: string;
	reviewerName: string;
	baseNodeId: string;
	headNodeId: string;
	nodeCount: number;
	createdAt: number;
	updatedAt: number;
};

type ReviewSurfaceProps = {
	documentId: Id<"documents">;
	open: boolean;
	onClose: () => void;
};

const timeFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

/**
 * Owner review surface (plan 010 Phase C). Modeled on history-panel.tsx chrome
 * (fixed right aside, recto-panel, scrim, Escape-to-close, focus restore). Lists
 * the OPEN review branches for a document the owner owns; for the expanded branch
 * it word-diffs the live document against the reviewer's branch head
 * (`review.getBranchDiff` → `diffRuns`, reusing the EXACT inline/side-by-side
 * render block from history-panel.tsx and the user's diff granularity/layout
 * toggles from plan 001), and offers Accept (additive merge forward via
 * `review.acceptBranch`) / Reject (`review.rejectBranch`). After accept/reject the
 * branch leaves `listOpenBranches` and the list updates reactively.
 */
export function ReviewSurface({
	documentId,
	open,
	onClose,
}: ReviewSurfaceProps) {
	const branches = useQuery(
		api.review.listOpenBranches,
		open ? { documentId } : "skip",
	) as ReviewBranchRow[] | undefined;
	const acceptBranch = useMutation(api.review.acceptBranch);
	const rejectBranch = useMutation(api.review.rejectBranch);

	const {
		diffGranularity,
		diffLayout,
		toggleDiffGranularity,
		toggleDiffLayout,
	} = useStudioSettingsContext();

	const [expanded, setExpanded] = useState<Id<"reviewBranches"> | null>(null);
	const [pending, setPending] = useState(false);

	// Auto-expand the first branch when the panel opens; collapse selection if the
	// expanded branch disappears (accepted/rejected away).
	useEffect(() => {
		if (!open) {
			setExpanded(null);
			return;
		}
		if (!branches) return;
		if (branches.length === 0) {
			setExpanded(null);
			return;
		}
		if (!expanded || !branches.some((b) => b._id === expanded)) {
			setExpanded(branches[0]?._id ?? null);
		}
	}, [open, branches, expanded]);

	const restoreFocusRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (open) {
			restoreFocusRef.current = document.activeElement as HTMLElement | null;
		} else if (restoreFocusRef.current) {
			restoreFocusRef.current.focus?.();
			restoreFocusRef.current = null;
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	const handleAccept = useCallback(
		async (branchId: Id<"reviewBranches">) => {
			setPending(true);
			try {
				await acceptBranch({ documentId, branchId });
			} finally {
				setPending(false);
			}
		},
		[acceptBranch, documentId],
	);

	const handleReject = useCallback(
		async (branchId: Id<"reviewBranches">) => {
			setPending(true);
			try {
				await rejectBranch({ documentId, branchId });
			} finally {
				setPending(false);
			}
		},
		[rejectBranch, documentId],
	);

	if (!open) return null;

	return (
		<div className="fixed inset-y-0 right-0 z-[90] flex">
			<button
				type="button"
				aria-label="Close review"
				className="recto-scrim absolute inset-0 -left-[100vw]"
				onClick={onClose}
			/>
			<aside
				className="recto-panel relative z-10 flex h-full w-[min(26rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
				role="dialog"
				aria-modal="true"
				aria-labelledby="recto-review-title"
			>
				<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
					<h2
						id="recto-review-title"
						className="flex items-center gap-1.5 text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
					>
						<GitBranch aria-hidden className="size-3.5" /> Review suggestions
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close review"
						className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
					>
						<X aria-hidden className="size-4" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
					{branches === undefined ? (
						<p className="px-[var(--space-2)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							Loading…
						</p>
					) : branches.length === 0 ? (
						<p className="px-[var(--space-2)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							No open suggestions. Share this draft to collect feedback.
						</p>
					) : (
						<ul className="flex flex-col gap-[var(--space-2)]">
							{branches.map((branch) => (
								<li
									key={branch._id}
									className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-app)]"
								>
									<button
										type="button"
										onClick={() =>
											setExpanded((cur) =>
												cur === branch._id ? null : branch._id,
											)
										}
										className="flex w-full items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)] text-left"
										aria-expanded={expanded === branch._id}
									>
										<span className="min-w-0 flex-1 truncate text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-primary)]">
											{branch.reviewerName}
										</span>
										<span className="shrink-0 text-[0.6875rem] text-[var(--color-ink-tertiary)]">
											{branch.nodeCount} edit
											{branch.nodeCount === 1 ? "" : "s"}
										</span>
										<span className="shrink-0 text-[0.625rem] text-[var(--color-ink-tertiary)]">
											{timeFmt.format(branch.updatedAt)}
										</span>
									</button>

									{expanded === branch._id && (
										<BranchDiff
											documentId={documentId}
											branchId={branch._id}
											granularity={diffGranularity}
											layout={diffLayout}
											onToggleGranularity={toggleDiffGranularity}
											onToggleLayout={toggleDiffLayout}
											pending={pending}
											onAccept={() => void handleAccept(branch._id)}
											onReject={() => void handleReject(branch._id)}
										/>
									)}
								</li>
							))}
						</ul>
					)}
				</div>
			</aside>
		</div>
	);
}

type BranchDiffProps = {
	documentId: Id<"documents">;
	branchId: Id<"reviewBranches">;
	granularity: "word" | "line";
	layout: "inline" | "side-by-side";
	onToggleGranularity: () => void;
	onToggleLayout: () => void;
	pending: boolean;
	onAccept: () => void;
	onReject: () => void;
};

function BranchDiff({
	documentId,
	branchId,
	granularity,
	layout,
	onToggleGranularity,
	onToggleLayout,
	pending,
	onAccept,
	onReject,
}: BranchDiffProps) {
	const diff = useQuery(api.review.getBranchDiff, { documentId, branchId });

	// Diff the LIVE document (current) against the reviewer's branch head, so
	// additions = what the reviewer proposes adding (plan 010: branch-head vs.
	// live-current). Reuses the pure diffRuns from plan 001.
	const runs = useMemo(() => {
		if (!diff) return null;
		return diffRuns(diff.currentMarkdown, diff.branchMarkdown, granularity);
	}, [diff, granularity]);

	return (
		<div className="border-t border-[var(--color-line)]">
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

			<div className="max-h-[40vh] overflow-y-auto px-[var(--space-3)] py-[var(--space-2)] font-[family-name:var(--font-mono)] text-[0.75rem] leading-relaxed">
				{runs === null ? (
					<p className="text-[var(--color-ink-tertiary)]">Loading diff…</p>
				) : runs.length === 0 ? (
					<p className="text-[var(--color-ink-tertiary)]">No changes.</p>
				) : layout === "inline" ? (
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
				)}
			</div>

			<div className="flex shrink-0 items-center justify-end gap-[var(--space-2)] border-t border-[var(--color-line)] px-[var(--space-3)] py-[var(--space-2)]">
				<Button variant="ghost" size="sm" disabled={pending} onClick={onReject}>
					<X aria-hidden className="size-3.5" /> Reject
				</Button>
				<Button size="sm" disabled={pending} onClick={onAccept}>
					<Check aria-hidden className="size-3.5" /> Accept
				</Button>
			</div>
		</div>
	);
}
