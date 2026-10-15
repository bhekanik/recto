"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { type LabReview, reviewLabel } from "@/lib/writing/lab";
import type { LabController } from "@/lib/writing/use-lab";

type FindingsPanelProps = {
	review: LabReview;
	lab: Pick<
		LabController,
		| "dismissReview"
		| "dismissFinding"
		| "showFinding"
		| "compareFinding"
		| "compareOpenings"
	>;
};

/**
 * A Lab review beside the draft: the editor's assessment, then each finding
 * with its reason. A suggestion is never applied from here; `Compare wording`
 * adds it as an alternative so the writer reads it in place first.
 */
export function FindingsPanel({ review, lab }: FindingsPanelProps) {
	const openings = review.openings.length;
	return (
		<aside
			className="recto-panel fixed inset-y-0 right-0 z-[80] flex w-[min(20rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
			aria-labelledby="recto-findings-title"
		>
			<header className="flex shrink-0 items-center justify-between gap-[var(--space-2)] border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
				<h2
					id="recto-findings-title"
					className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
				>
					{reviewLabel(review.pass)}
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={lab.dismissReview}
					aria-label="Close the review"
				>
					<X aria-hidden />
				</Button>
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-[var(--space-4)] overflow-auto px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-ui-sm)]">
				{review.assessment && (
					<p className="select-text text-[var(--color-ink-primary)]">
						{review.assessment}
					</p>
				)}
				{review.opening && openings > 0 && (
					<Button
						size="sm"
						variant="outline"
						className="self-start"
						onClick={() => void lab.compareOpenings()}
					>
						Compare {openings} opening{openings === 1 ? "" : "s"}
					</Button>
				)}
				{review.findings.length > 0 ? (
					<ul className="flex flex-col gap-[var(--space-4)]">
						{review.findings.map((finding, index) => (
							<li
								key={`${finding.from}:${finding.to}:${finding.reason}`}
								className="flex flex-col gap-[var(--space-1)]"
							>
								<q className="line-clamp-3 italic text-[var(--color-ink-secondary)]">
									{review.text.slice(finding.from, finding.to)}
								</q>
								<p className="select-text text-[var(--color-ink-primary)]">
									{finding.reason}
								</p>
								<div className="flex flex-wrap gap-[var(--space-1)]">
									<Button
										size="xs"
										variant="ghost"
										onClick={() => lab.showFinding(index)}
									>
										Show
									</Button>
									{finding.suggestion !== undefined && (
										<Button
											size="xs"
											variant="ghost"
											onClick={() => void lab.compareFinding(index)}
										>
											Compare wording
										</Button>
									)}
									<Button
										size="xs"
										variant="ghost"
										onClick={() => lab.dismissFinding(index)}
									>
										Dismiss
									</Button>
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="text-[var(--color-ink-tertiary)]">
						No passages to point at.
					</p>
				)}
				{review.dropped > 0 && (
					<p className="text-[var(--color-ink-tertiary)]">
						{review.dropped} point{review.dropped === 1 ? "" : "s"} could not be
						matched to exact words in the draft and were left out.
					</p>
				)}
			</div>
		</aside>
	);
}
