"use client";

import { useMutation, useQuery } from "convex/react";
import { Check, GitBranch, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	DiffHunksBody,
	DiffRunsBody,
	DiffRunsToggle,
} from "@/components/review/diff-runs-view";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { timeFmt } from "@/lib/format";
import { diffRuns, groupHunks } from "@/lib/history/diff";
import { useStudioSettingsContext } from "@/lib/studio/settings-context";

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
	const acceptHunks = useMutation(api.review.acceptHunks);
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

	const handleAcceptHunks = useCallback(
		async (
			branchId: Id<"reviewBranches">,
			granularity: "word" | "line",
			acceptedHunks: number[],
		) => {
			setPending(true);
			try {
				await acceptHunks({
					documentId,
					branchId,
					granularity,
					acceptedHunks,
				});
			} finally {
				setPending(false);
			}
		},
		[acceptHunks, documentId],
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
											onAcceptHunks={(g, hunks) =>
												void handleAcceptHunks(branch._id, g, hunks)
											}
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
	onAcceptHunks: (
		granularity: "word" | "line",
		acceptedHunks: number[],
	) => void;
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
	onAcceptHunks,
}: BranchDiffProps) {
	const diff = useQuery(api.review.getBranchDiff, { documentId, branchId });

	// Diff the LIVE document (current) against the reviewer's branch head, so
	// additions = what the reviewer proposes adding (plan 010: branch-head vs.
	// live-current). Reuses the pure diffRuns from plan 001.
	const runs = useMemo(() => {
		if (!diff) return null;
		return diffRuns(diff.currentMarkdown, diff.branchMarkdown, granularity);
	}, [diff, granularity]);

	const hunks = useMemo(() => (runs ? groupHunks(runs) : []), [runs]);
	const hunkCount = hunks.length;

	// Per-hunk review mode. When on, each change is individually accept/reject-able
	// (DiffHunksBody) and the primary button calls acceptHunks with the selection.
	// When off, the original whole-branch Accept (acceptBranch) / Reject path is
	// used verbatim — back-compat. The selection seeds to "all accepted" so turning
	// the mode on then hitting Accept matches the whole-branch result.
	const [perHunk, setPerHunk] = useState(false);
	const [accepted, setAccepted] = useState<Set<number>>(new Set());

	// Re-seed the selection (all accepted) whenever the hunk set changes. `hunks` is
	// memoized on `runs` (→ `diff` + `granularity`), so its reference only changes
	// when the branch loads, the diff updates, or the granularity flips — exactly
	// when stale hunk indices must be dropped and the selection reset.
	useEffect(() => {
		setAccepted(new Set(hunks.map((h) => h.index)));
	}, [hunks]);

	const toggleHunk = useCallback((index: number) => {
		setAccepted((prev) => {
			const next = new Set(prev);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			return next;
		});
	}, []);

	const acceptedCount = accepted.size;
	const allAccepted = hunkCount > 0 && acceptedCount === hunkCount;

	const handlePrimaryAccept = useCallback(() => {
		if (!perHunk || allAccepted) {
			// Whole-branch path (back-compat) — verbatim acceptBranch.
			onAccept();
			return;
		}
		onAcceptHunks(
			granularity,
			[...accepted].sort((a, b) => a - b),
		);
	}, [perHunk, allAccepted, onAccept, onAcceptHunks, granularity, accepted]);

	return (
		<div className="border-t border-[var(--color-line)]">
			<div className="flex shrink-0 items-center gap-[var(--space-2)] px-[var(--space-3)] py-1.5 text-[0.6875rem] text-[var(--color-ink-tertiary)]">
				<DiffRunsToggleInline
					granularity={granularity}
					layout={layout}
					perHunk={perHunk}
					onToggleGranularity={onToggleGranularity}
					onToggleLayout={onToggleLayout}
				/>
				{hunkCount > 1 && (
					<>
						<span aria-hidden>·</span>
						<button
							type="button"
							onClick={() => setPerHunk((v) => !v)}
							aria-pressed={perHunk}
							className="transition-colors hover:text-[var(--color-ink-primary)]"
						>
							{perHunk ? "Reviewing each change" : "Review each change"}
						</button>
					</>
				)}
			</div>

			<div className="max-h-[40vh] overflow-y-auto px-[var(--space-3)] py-[var(--space-2)] font-[family-name:var(--font-mono)] text-[0.75rem] leading-relaxed">
				{runs === null ? (
					<p className="text-[var(--color-ink-tertiary)]">Loading diff…</p>
				) : runs.length === 0 ? (
					<p className="text-[var(--color-ink-tertiary)]">No changes.</p>
				) : perHunk ? (
					<DiffHunksBody
						runs={runs}
						accepted={accepted}
						onToggleHunk={toggleHunk}
					/>
				) : (
					<DiffRunsBody runs={runs} layout={layout} />
				)}
			</div>

			<div className="flex shrink-0 items-center justify-end gap-[var(--space-2)] border-t border-[var(--color-line)] px-[var(--space-3)] py-[var(--space-2)]">
				{perHunk && hunkCount > 1 && (
					<span className="mr-auto text-[0.6875rem] text-[var(--color-ink-tertiary)]">
						{acceptedCount} of {hunkCount} accepted
					</span>
				)}
				<Button variant="ghost" size="sm" disabled={pending} onClick={onReject}>
					<X aria-hidden className="size-3.5" /> Reject
				</Button>
				<Button
					size="sm"
					disabled={pending}
					onClick={handlePrimaryAccept}
					title={
						perHunk && !allAccepted
							? "Merge the accepted changes; discard the rest"
							: "Accept all changes"
					}
				>
					<Check aria-hidden className="size-3.5" />{" "}
					{perHunk && !allAccepted ? `Accept ${acceptedCount}` : "Accept all"}
				</Button>
			</div>
		</div>
	);
}

type DiffRunsToggleInlineProps = {
	granularity: "word" | "line";
	layout: "inline" | "side-by-side";
	perHunk: boolean;
	onToggleGranularity: () => void;
	onToggleLayout: () => void;
};

/**
 * The granularity/layout toggles, flattened so they can sit beside the
 * "Review each change" toggle in one row. Mirrors {@link DiffRunsToggle}'s
 * buttons; the layout toggle is hidden in per-hunk mode (the interactive renderer
 * is inline-only — side-by-side reorders runs into columns, which breaks per-hunk
 * controls).
 */
function DiffRunsToggleInline({
	granularity,
	layout,
	perHunk,
	onToggleGranularity,
	onToggleLayout,
}: DiffRunsToggleInlineProps) {
	return (
		<>
			<button
				type="button"
				onClick={onToggleGranularity}
				className="transition-colors hover:text-[var(--color-ink-primary)]"
			>
				{granularity === "word" ? "Word" : "Line"} diff
			</button>
			{!perHunk && (
				<>
					<span aria-hidden>·</span>
					<button
						type="button"
						onClick={onToggleLayout}
						className="transition-colors hover:text-[var(--color-ink-primary)]"
					>
						{layout === "inline" ? "Inline" : "Side by side"}
					</button>
				</>
			)}
		</>
	);
}
