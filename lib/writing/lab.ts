import { computePatch } from "@/lib/history/patch";
import { countWords } from "@/lib/markdown";
import type { WritingMark } from "./marks";
import { mapWritingState, type WritingState } from "./state";
import type { Range, Scope } from "./targets";

/**
 * The Lab on the web, as `AIController`'s Lab sections on the Mac: a trim
 * proposal shown over the exact text it was made for, and a review whose
 * findings follow the text. Offsets are UTF-16 into the canonical Markdown,
 * as the server returns them.
 */

export type LabCut = { from: number; to: number; reason: string };

export const TRIM_PRESETS = [
	{ target: 10, label: "Slight trim" },
	{ target: 20, label: "Tighten more" },
	{ target: 30, label: "Even sharper" },
	{ target: 50, label: "Cut in half" },
] as const;

export type TrimTarget = (typeof TRIM_PRESETS)[number]["target"];

export function trimLabel(target: number): string {
	return (
		TRIM_PRESETS.find((preset) => preset.target === target)?.label ?? "Trim"
	);
}

export type LabProposal = {
	target: TrimTarget;
	/** The text the cuts are offsets into; any other text drops the proposal. */
	base: string;
	cuts: LabCut[];
	dropped: number;
	/** Indexes of cuts the writer chose to keep the words of, ascending. */
	kept: number[];
	/** The cut the walkthrough is on, when walking through. */
	walking: number | null;
};

/** Cuts that fit `length`, in order, none overlapping the one before. */
export function fittingCuts(cuts: readonly LabCut[], length: number): LabCut[] {
	const sorted = cuts
		.filter((cut) => cut.from >= 0 && cut.to > cut.from && cut.to <= length)
		.sort((a, b) => a.from - b.from);
	return sorted.filter((cut, index) => {
		const before = sorted[index - 1];
		return !before || before.to <= cut.from;
	});
}

export function proposalFor(
	target: TrimTarget,
	base: string,
	cuts: readonly LabCut[],
	dropped: number,
): LabProposal | null {
	const fitting = fittingCuts(cuts, base.length);
	if (fitting.length === 0) return null;
	return { target, base, cuts: fitting, dropped, kept: [], walking: null };
}

/** The ranges that would go: every cut the writer has not kept. */
export function cutRanges(proposal: LabProposal): Range[] {
	return proposal.cuts
		.filter((_, index) => !proposal.kept.includes(index))
		.map(({ from, to }) => ({ from, to }));
}

/** `markdown` without `ranges`, which must be ordered and disjoint. */
export function withoutRanges(
	markdown: string,
	ranges: readonly Range[],
): string {
	let text = markdown;
	for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
		text = text.slice(0, range.from) + text.slice(range.to);
	}
	return text;
}

export function proposalWords(proposal: LabProposal): {
	before: number;
	after: number;
	percent: number;
} {
	const before = countWords(proposal.base);
	const after = countWords(withoutRanges(proposal.base, cutRanges(proposal)));
	const percent =
		before === 0 ? 0 : Math.round(((before - after) / before) * 100);
	return { before, after, percent };
}

/** A click in a cut keeps its words; a click in a kept one cuts them again. */
export function toggleCutAt(
	proposal: LabProposal,
	offset: number,
): LabProposal {
	const index = proposal.cuts.findIndex(
		(cut) => cut.from <= offset && offset < cut.to,
	);
	return index === -1 ? proposal : toggleCut(proposal, index);
}

export function toggleCut(proposal: LabProposal, index: number): LabProposal {
	if (!proposal.cuts[index]) return proposal;
	const kept = proposal.kept.includes(index)
		? proposal.kept.filter((other) => other !== index)
		: [...proposal.kept, index].sort((a, b) => a - b);
	return { ...proposal, kept };
}

/** Start at the first cut still faded, or the first cut when all are kept. */
export function walkThrough(proposal: LabProposal): LabProposal {
	const first = proposal.cuts.findIndex(
		(_, index) => !proposal.kept.includes(index),
	);
	return { ...proposal, walking: first === -1 ? 0 : first };
}

/** Keep or cut the walkthrough's cut, then move to the next one. */
export function decideWalkingCut(
	proposal: LabProposal,
	keep: boolean,
): LabProposal {
	const index = proposal.walking;
	if (index === null) return proposal;
	const kept = proposal.kept.filter((other) => other !== index);
	if (keep) kept.push(index);
	kept.sort((a, b) => a - b);
	return {
		...proposal,
		kept,
		walking: index + 1 < proposal.cuts.length ? index + 1 : null,
	};
}

/**
 * The text and writing state after deleting `ranges` from `base`, with the
 * state mapped through each deletion so alternatives and ghosts survive
 * (`CloudDocumentModel.applyCuts`). Null for ranges that do not fit or overlap.
 */
export function cutting(
	state: WritingState,
	base: string,
	ranges: readonly Range[],
): { markdown: string; state: WritingState } | null {
	const ordered = ranges
		.filter((range) => range.to > range.from)
		.sort((a, b) => a.from - b.from);
	const first = ordered[0];
	const last = ordered[ordered.length - 1];
	if (
		!first ||
		!last ||
		first.from < 0 ||
		last.to > base.length ||
		ordered.some((range, index) => {
			const next = ordered[index + 1];
			return next !== undefined && range.to > next.from;
		})
	)
		return null;
	let markdown = base;
	let next = state;
	for (const range of [...ordered].reverse()) {
		markdown = markdown.slice(0, range.from) + markdown.slice(range.to);
		next = mapWritingState(
			next,
			{ from: range.from, to: range.to, insert: "" },
			markdown,
		);
	}
	return { markdown, state: next };
}

// MARK: - Review passes

export const REVIEW_PASSES = [
	{ pass: "opening", label: "Improve the opening" },
	{ pass: "clarity", label: "Find confusing passages" },
	{ pass: "voice", label: "Check voice and phrasing" },
] as const;

export type ReviewPass = (typeof REVIEW_PASSES)[number]["pass"];

export function reviewLabel(pass: ReviewPass): string {
	return REVIEW_PASSES.find((entry) => entry.pass === pass)?.label ?? "Review";
}

export type LabFinding = Range & { reason: string; suggestion?: string };

export type LabReview = {
	pass: ReviewPass;
	assessment: string;
	findings: LabFinding[];
	opening: Range | null;
	openings: string[];
	dropped: number;
	/** The text the ranges are offsets into. */
	text: string;
};

/**
 * Shift the review's ranges through the edit from its text to `markdown`. A
 * finding the edit cut across is dropped; an edit inside it keeps it.
 */
export function followReview(review: LabReview, markdown: string): LabReview {
	if (review.text === markdown) return review;
	const patch = computePatch(review.text, markdown);
	const delta = patch.insert.length - (patch.to - patch.from);
	const shift = (range: Range): Range | null => {
		if (patch.to <= range.from)
			return { from: range.from + delta, to: range.to + delta };
		if (patch.from >= range.to) return range;
		if (
			patch.from >= range.from &&
			patch.to <= range.to &&
			range.to - range.from + delta > 0
		)
			return { from: range.from, to: range.to + delta };
		return null;
	};
	const findings: LabFinding[] = [];
	for (const finding of review.findings) {
		const moved = shift(finding);
		if (moved) findings.push({ ...finding, ...moved });
	}
	return {
		...review,
		findings,
		opening: review.opening ? shift(review.opening) : null,
		text: markdown,
	};
}

/** The scope a finding's passage is compared at (`AIController.scope(of:)`). */
export function passageScope(passage: string): Scope {
	if (passage.includes("\n")) return "paragraph";
	return /\s/.test(passage) ? "sentence" : "word";
}

/**
 * What the editors draw for the Lab: cuts faded (kept ones only clickable, to
 * cut them again) and findings underlined. `index` is the cut's, so a click
 * can name it.
 */
export function labMarksFor(
	proposal: LabProposal | null,
	review: LabReview | null,
): WritingMark[] {
	const marks: WritingMark[] = [];
	proposal?.cuts.forEach((cut, index) => {
		marks.push({
			from: cut.from,
			to: cut.to,
			kind: proposal.kept.includes(index) ? "lab-kept" : "lab-cut",
			text: proposal.base.slice(cut.from, cut.to),
			index,
		});
	});
	for (const finding of review?.findings ?? []) {
		if (!review || finding.to > review.text.length) continue;
		marks.push({
			from: finding.from,
			to: finding.to,
			kind: "lab-finding",
			text: review.text.slice(finding.from, finding.to),
		});
	}
	return marks.sort((a, b) => a.from - b.from);
}

/** The `LAB_MARKS_EVENT` payload: marks for one document's active pane. */
export type LabMarksDetail = { documentId: string; marks: WritingMark[] };
