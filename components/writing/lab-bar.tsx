"use client";

import { LoaderCircle } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import {
	type LabProposal,
	proposalWords,
	reviewLabel,
	trimLabel,
} from "@/lib/writing/lab";
import type { LabController } from "@/lib/writing/use-lab";

type LabBarProps = {
	lab: Pick<
		LabController,
		"busy" | "proposal" | "makeCuts" | "walk" | "decide" | "dismissProposal"
	>;
};

/**
 * Under the draft while the Lab reads it or shows a proposal: how much the
 * cuts would take, and the choices (make the cuts, walk through them, or set
 * the proposal aside). The Mac's `LabBar`, with its wording.
 */
export function LabBar({ lab }: LabBarProps) {
	const { busy, proposal } = lab;
	const reading =
		busy?.kind === "trim"
			? trimLabel(busy.target)
			: busy?.kind === "review"
				? reviewLabel(busy.pass)
				: null;
	if (!reading && !proposal) return null;
	return (
		<section
			aria-label="Lab"
			className="flex shrink-0 flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)] border-t border-[var(--color-line)] bg-[var(--color-bg-raised)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
		>
			{reading ? (
				<p className="flex items-center gap-[var(--space-2)]" role="status">
					<LoaderCircle
						aria-hidden
						className="size-3.5 animate-spin motion-reduce:animate-none"
					/>
					{reading} · Reading the draft…
				</p>
			) : proposal && proposal.walking !== null ? (
				<Walkthrough lab={lab} proposal={proposal} index={proposal.walking} />
			) : proposal ? (
				<Summary lab={lab} proposal={proposal} />
			) : null}
		</section>
	);
}

function Summary({
	lab,
	proposal,
}: {
	lab: LabBarProps["lab"];
	proposal: LabProposal;
}) {
	const { before, after, percent } = useMemo(
		() => proposalWords(proposal),
		[proposal],
	);
	const allKept = proposal.kept.length === proposal.cuts.length;
	return (
		<>
			<div className="flex min-w-0 flex-1 flex-col gap-[2px]">
				<p className="text-[var(--color-ink-primary)]">
					{trimLabel(proposal.target)} · {before} → {after} words · −{percent}%
				</p>
				<p className="text-[var(--color-ink-tertiary)]">
					Faded words would go. Click one to keep it.
					{proposal.dropped > 0 &&
						` ${proposal.dropped} suggestion${proposal.dropped === 1 ? "" : "s"} could not be placed exactly and were left out.`}
				</p>
			</div>
			<div className="flex gap-[var(--space-2)]">
				<Button
					size="sm"
					disabled={allKept}
					onClick={() => void lab.makeCuts()}
				>
					Make the cuts
				</Button>
				<Button size="sm" variant="outline" onClick={lab.walk}>
					Walk through
				</Button>
				<Button size="sm" variant="ghost" onClick={lab.dismissProposal}>
					Done
				</Button>
			</div>
		</>
	);
}

function Walkthrough({
	lab,
	proposal,
	index,
}: {
	lab: LabBarProps["lab"];
	proposal: LabProposal;
	index: number;
}) {
	const cut = proposal.cuts[index];
	const kept = proposal.kept.includes(index);
	return (
		<>
			<div className="flex min-w-0 flex-1 flex-col gap-[2px]">
				<p className="text-[var(--color-ink-primary)]">
					Cut {index + 1} of {proposal.cuts.length}
					{kept && " · kept"}
				</p>
				<p className="text-[var(--color-ink-tertiary)]">
					{cut?.reason ? cut.reason : "No reason given."}
				</p>
			</div>
			<div className="flex gap-[var(--space-2)]">
				<Button size="sm" variant="outline" onClick={() => lab.decide(true)}>
					Keep the words
				</Button>
				<Button size="sm" variant="outline" onClick={() => lab.decide(false)}>
					Cut them
				</Button>
				<Button size="sm" variant="ghost" onClick={lab.dismissProposal}>
					Done
				</Button>
			</div>
		</>
	);
}
