"use client";

import { useAction, useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	type LabBaseArgs,
	type LabSource,
	runLabRequest,
} from "@/lib/ai/lab-request";
import { AiRequestOwner } from "@/lib/ai/request-owner";
import type { EditorHandle } from "@/lib/editor/handle";
import { EDITOR_CHANGE_EVENT, LAB_MARKS_EVENT } from "@/lib/events";
import type { HistoryController } from "@/lib/history/use-document-history";
import type { Mode } from "@/lib/modes/types";
import { toast } from "@/lib/ui/toast";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import {
	cutRanges,
	cutting,
	decideWalkingCut,
	followReview,
	type LabMarksDetail,
	type LabProposal,
	type LabReview,
	labMarksFor,
	passageScope,
	proposalFor,
	type ReviewPass,
	type TrimTarget,
	toggleCut,
	walkThrough,
} from "./lab";
import {
	emptyWritingState,
	validateWritingState,
	writingStateFor,
} from "./state";
import type { Range, Scope } from "./targets";
import type { AlternativesController } from "./use-alternatives";

type Deps = {
	registry: DocumentModelRegistry;
	activeDocId: Id<"documents"> | null;
	activePaneId: string | null;
	activeMode: Mode;
	/** Effective AI on the writer's own document; off, the Lab does nothing. */
	enabled: boolean;
	/** The active history's node, so undo and redo move the Lab's ranges too. */
	headNodeId: string | null;
	getController: () => HistoryController | null;
	alternatives: AlternativesController;
};

export type LabBusy =
	| { kind: "trim"; target: TrimTarget }
	| { kind: "review"; pass: ReviewPass }
	| { kind: "suggest" };

const SWITCH_MODE = "Switch to Rich, Raw or Vim to use the Lab.";
const BUSY = "The Lab is already reading the draft.";
/** How long a pass waits for this device's edits to reach the server. */
const SYNC_WAIT_MS = 5_000;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The Lab on the web (plan 026, rung 11 onward), as `AIController` on the Mac:
 * trim proposals faded over the text they were made for, review findings
 * that follow the text, and AI wordings added as alternatives. Nothing here
 * changes the draft except `makeCuts` and the wordings, each one history node.
 */
export function useLab({
	registry,
	activeDocId,
	activePaneId,
	activeMode,
	enabled,
	headNodeId,
	getController,
	alternatives,
}: Deps) {
	const runTrim = useAction(api.ai.lab.run);
	const runReview = useAction(api.ai.lab.review);
	const runAlternatives = useAction(api.ai.lab.alternatives);
	const acknowledgeRun = useMutation(api.ai.runs.acknowledge);
	const convex = useConvex();
	const ownerRef = useRef(new AiRequestOwner());
	const documentRef = useRef(activeDocId);
	documentRef.current = activeDocId;
	const alternativesRef = useRef(alternatives);
	alternativesRef.current = alternatives;

	const [busy, setBusyState] = useState<LabBusy | null>(null);
	// Read synchronously so two quick commands cannot both start a pass.
	const busyRef = useRef<LabBusy | null>(null);
	const setBusy = useCallback((next: LabBusy | null) => {
		busyRef.current = next;
		setBusyState(next);
	}, []);
	const [proposal, setProposalState] = useState<LabProposal | null>(null);
	const proposalRef = useRef<LabProposal | null>(null);
	const setProposal = useCallback((next: LabProposal | null) => {
		proposalRef.current = next;
		setProposalState(next);
	}, []);
	const [review, setReviewState] = useState<LabReview | null>(null);
	const reviewRef = useRef<LabReview | null>(null);
	const setReview = useCallback((next: LabReview | null) => {
		reviewRef.current = next;
		setReviewState(next);
	}, []);

	const resolve = useCallback((): {
		handle: EditorHandle;
		controller: HistoryController;
	} | null => {
		if (!activeDocId || activeMode === "preview") return null;
		const handle = registry.getPrimaryHandle(activeDocId, activePaneId);
		const controller = getController();
		return handle && controller ? { handle, controller } : null;
	}, [registry, activeDocId, activePaneId, activeMode, getController]);

	// Another document, or AI turned off: whatever the Lab was doing goes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the document and the gate are the signals; the setters are stable
	useEffect(() => {
		ownerRef.current.supersede();
		setBusy(null);
		setProposal(null);
		setReview(null);
	}, [activeDocId, enabled]);

	useEffect(
		() => () => {
			ownerRef.current.supersede();
		},
		[],
	);

	/**
	 * Push this device's edits and name the synced head, as the Mac's
	 * `AIClient.source` does: the server reads the Lab's text at that node.
	 */
	const source = useCallback(
		async (signal: AbortSignal): Promise<LabSource | { error: string }> => {
			const target = resolve();
			if (!target) return { error: SWITCH_MODE };
			const before = target.controller.getHeadNodeId();
			target.controller.flush();
			// A node the flush committed counts as a pending write only once
			// React has rendered the history; give it that turn before asking.
			if (target.controller.getHeadNodeId() !== before) await sleep(50);
			const deadline = Date.now() + SYNC_WAIT_MS;
			while (
				getController()?.hasPendingWrites &&
				Date.now() < deadline &&
				!signal.aborted
			) {
				await sleep(100);
			}
			const controller = getController();
			const sourceNodeId = controller?.getHeadNodeId() ?? null;
			const markdown = resolve()?.handle.getCanonicalMarkdown();
			if (
				!sourceNodeId ||
				markdown === undefined ||
				controller?.hasPendingWrites
			)
				return {
					error: "The draft has not finished syncing. Try again in a moment.",
				};
			return { sourceNodeId, markdown };
		},
		[resolve, getController],
	);

	const request = useCallback(
		<T>(
			documentId: Id<"documents">,
			call: (args: LabBaseArgs, source: LabSource) => Promise<T>,
		) =>
			runLabRequest(
				{
					owner: ownerRef.current,
					documentId,
					currentDocumentId: () => documentRef.current,
					source,
					latestRun: async () =>
						await convex.query(api.ai.runs.latestRecoverable, {
							documentId,
							kind: "lab",
						}),
					acknowledge: async (requestId) =>
						(await acknowledgeRun({ requestId })).acknowledged,
				},
				call,
			),
		[convex, acknowledgeRun, source],
	);

	/** Whether a pass may start now; says why not when it may not. */
	const canStart = useCallback((): Id<"documents"> | null => {
		if (!enabled || !activeDocId) return null;
		if (!resolve()) {
			toast(SWITCH_MODE, "info");
			return null;
		}
		if (busyRef.current) {
			toast(BUSY, "info");
			return null;
		}
		return activeDocId;
	}, [enabled, activeDocId, resolve]);

	const live = useCallback(
		() => resolve()?.handle.getCanonicalMarkdown() ?? null,
		[resolve],
	);

	const trim = useCallback(
		async (target: TrimTarget) => {
			const documentId = canStart();
			if (!documentId) return;
			setBusy({ kind: "trim", target });
			await alternativesRef.current.keep();
			setProposal(null);
			const outcome = await request(documentId, (args) =>
				runTrim({ ...args, target }),
			);
			if (outcome.status === "stale") return;
			setBusy(null);
			if (outcome.status === "failed") {
				toast(outcome.message, "error");
				return;
			}
			if (live() !== outcome.source.markdown) {
				toast(
					"The draft changed while the Lab read it. Nothing is shown; run it again.",
					"info",
				);
				return;
			}
			const next = proposalFor(
				target,
				outcome.source.markdown,
				outcome.result.cuts,
				outcome.result.dropped,
			);
			if (!next) toast("The Lab found nothing it would cut.", "info");
			setProposal(next);
		},
		[canStart, setBusy, setProposal, request, runTrim, live],
	);

	const reviewPass = useCallback(
		async (pass: ReviewPass) => {
			const documentId = canStart();
			if (!documentId) return;
			setBusy({ kind: "review", pass });
			await alternativesRef.current.keep();
			const outcome = await request(documentId, (args) =>
				runReview({ ...args, pass }),
			);
			if (outcome.status === "stale") return;
			setBusy(null);
			if (outcome.status === "failed") {
				toast(outcome.message, "error");
				return;
			}
			const { result, source: read } = outcome;
			const fits = (range: Range) =>
				range.from >= 0 &&
				range.to > range.from &&
				range.to <= read.markdown.length;
			const made: LabReview = {
				pass,
				assessment: result.assessment,
				findings: result.findings
					.filter(fits)
					.map(({ from, to, reason, suggestion }) =>
						suggestion === undefined
							? { from, to, reason }
							: { from, to, reason, suggestion },
					),
				opening:
					result.opening && fits(result.opening)
						? { from: result.opening.from, to: result.opening.to }
						: null,
				openings: result.openings,
				dropped: result.dropped,
				text: read.markdown,
			};
			// The draft may have moved on while the pass ran; carry the ranges over.
			setReview(followReview(made, live() ?? read.markdown));
		},
		[canStart, setBusy, setReview, request, runReview, live],
	);

	/** Ask for other wordings of `range`; they join its alternatives as the AI's. */
	const suggest = useCallback(
		async (range: Range, scope: Scope) => {
			const documentId = canStart();
			if (!documentId) return;
			setBusy({ kind: "suggest" });
			await alternativesRef.current.keep();
			const outcome = await request(documentId, (args, read) =>
				runAlternatives({
					...args,
					passage: read.markdown.slice(range.from, range.to),
					passageFrom: range.from,
					scope,
				}),
			);
			if (outcome.status === "stale") return;
			setBusy(null);
			if (outcome.status === "failed") {
				toast(outcome.message, "error");
				return;
			}
			const wordings = outcome.result.alternatives;
			if (wordings.length === 0) {
				toast("The AI had no other wordings for this passage.", "info");
				return;
			}
			alternativesRef.current.addSuggested(
				wordings,
				scope,
				range,
				outcome.source.markdown,
			);
		},
		[canStart, setBusy, request, runAlternatives],
	);

	/** Control-Shift-G: open the alternatives where the caret is and ask the AI. */
	const suggestAtCaret = useCallback(() => {
		if (!enabled) return;
		const panel = alternativesRef.current;
		const targets = panel.targets ?? panel.open();
		const range = targets?.ranges[targets.initial];
		if (!targets || !range) return;
		void suggest(range, targets.initial);
	}, [enabled, suggest]);

	// MARK: - Trim proposal

	const jump = useCallback(
		(range: Range) => {
			const handle = resolve()?.handle;
			if (!handle) return;
			handle.importCaret({
				offset: range.to,
				anchor: range.from,
				head: range.to,
			});
			handle.focus();
		},
		[resolve],
	);

	const toggle = useCallback(
		(index: number) => {
			const current = proposalRef.current;
			if (current) setProposal(toggleCut(current, index));
		},
		[setProposal],
	);

	const walk = useCallback(() => {
		const current = proposalRef.current;
		if (!current) return;
		const next = walkThrough(current);
		setProposal(next);
		const cut = next.walking === null ? undefined : next.cuts[next.walking];
		if (cut) jump(cut);
	}, [setProposal, jump]);

	const decide = useCallback(
		(keep: boolean) => {
			const current = proposalRef.current;
			if (!current) return;
			const next = decideWalkingCut(current, keep);
			setProposal(next);
			const cut = next.walking === null ? undefined : next.cuts[next.walking];
			if (cut) jump(cut);
		},
		[setProposal, jump],
	);

	/**
	 * Delete what is still faded as one history node, only while the draft is
	 * exactly the text the Lab read; writing state follows each deletion.
	 */
	const makeCuts = useCallback(async () => {
		const current = proposalRef.current;
		if (!current) return;
		setProposal(null);
		const ranges = cutRanges(current);
		if (ranges.length === 0) return;
		await alternativesRef.current.keep();
		const target = resolve();
		if (!target) {
			toast(SWITCH_MODE, "info");
			return;
		}
		target.controller.flush();
		const markdown = target.handle.getCanonicalMarkdown();
		const result =
			markdown === current.base
				? cutting(
						writingStateFor(markdown, target.controller) ?? emptyWritingState(),
						current.base,
						ranges,
					)
				: null;
		if (!result) {
			toast("The draft changed since the Lab read it. Run it again.", "error");
			return;
		}
		target.controller.commitWriting(
			JSON.stringify(validateWritingState(result.state, result.markdown)),
			result.markdown,
		);
	}, [resolve, setProposal]);

	const dismissProposal = useCallback(() => setProposal(null), [setProposal]);

	// MARK: - Review

	const dismissReview = useCallback(() => setReview(null), [setReview]);

	const dismissFinding = useCallback(
		(index: number) => {
			const current = reviewRef.current;
			if (!current?.findings[index]) return;
			setReview({
				...current,
				findings: current.findings.filter((_, other) => other !== index),
			});
		},
		[setReview],
	);

	const showFinding = useCallback(
		(index: number) => {
			const finding = reviewRef.current?.findings[index];
			if (finding) jump(finding);
		},
		[jump],
	);

	/** The review on the live text, so its ranges are the draft's now. */
	const currentReview = useCallback((): LabReview | null => {
		const current = reviewRef.current;
		const text = live();
		if (!current || text === null) return null;
		const followed = followReview(current, text);
		if (followed !== current) setReview(followed);
		return followed;
	}, [live, setReview]);

	/**
	 * Add the finding's suggestion as an AI wording of its passage and open the
	 * alternatives there, so it is compared in place, not applied.
	 */
	const compareFinding = useCallback(
		async (index: number) => {
			await alternativesRef.current.keep();
			const current = currentReview();
			const finding = current?.findings[index];
			if (!current || !finding?.suggestion) return;
			const scope = passageScope(current.text.slice(finding.from, finding.to));
			if (
				alternativesRef.current.addSuggested(
					[finding.suggestion],
					scope,
					finding,
					current.text,
				)
			)
				alternativesRef.current.openAt(finding, scope);
		},
		[currentReview],
	);

	const compareOpenings = useCallback(async () => {
		await alternativesRef.current.keep();
		const current = currentReview();
		const opening = current?.opening;
		if (!current || !opening || current.openings.length === 0) return;
		if (
			alternativesRef.current.addSuggested(
				current.openings,
				"paragraph",
				opening,
				current.text,
			)
		)
			alternativesRef.current.openAt(opening, "paragraph");
	}, [currentReview]);

	// MARK: - Following the text

	/**
	 * The proposal belongs to the text it was made for; any other text drops
	 * it. A review's findings follow the text instead.
	 */
	const followText = useCallback(() => {
		const text = live();
		if (text === null) return;
		const current = proposalRef.current;
		if (current && current.base !== text) setProposal(null);
		const shown = reviewRef.current;
		if (shown) {
			const followed = followReview(shown, text);
			if (followed !== shown) setReview(followed);
		}
	}, [live, setProposal, setReview]);

	useEffect(() => {
		if (!activeDocId) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onChange = (event: Event) => {
			const { documentId } = (event as CustomEvent<{ documentId: string }>)
				.detail;
			if (documentId !== activeDocId) return;
			clearTimeout(timer);
			timer = setTimeout(followText, 100);
		};
		window.addEventListener(EDITOR_CHANGE_EVENT, onChange);
		return () => {
			clearTimeout(timer);
			window.removeEventListener(EDITOR_CHANGE_EVENT, onChange);
		};
	}, [activeDocId, followText]);

	// Undo, redo and the Lab's own commits change the text without an edit event.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the head is the signal; followText reads the live text
	useEffect(() => {
		followText();
	}, [headNodeId]);

	// A click in a faded cut keeps its words; a click in a kept one cuts them
	// again. Only the active pane draws cuts, so listening on the document
	// survives the editor remounting on a mode switch.
	const hasProposal = proposal !== null;
	useEffect(() => {
		if (!hasProposal) return;
		const onClick = (event: MouseEvent) => {
			const cut =
				event.target instanceof Element
					? event.target.closest("[data-lab-cut]")
					: null;
			const index = Number(cut?.getAttribute("data-lab-cut"));
			if (cut && Number.isInteger(index)) toggle(index);
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, [hasProposal, toggle]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a pane or mode change is a new editor that needs the marks again
	useEffect(() => {
		if (!activeDocId) return;
		window.dispatchEvent(
			new CustomEvent<LabMarksDetail>(LAB_MARKS_EVENT, {
				detail: {
					documentId: activeDocId,
					marks: labMarksFor(proposal, review),
				},
			}),
		);
	}, [activeDocId, activePaneId, activeMode, proposal, review]);

	return {
		busy,
		proposal,
		review,
		trim,
		startReview: reviewPass,
		suggest,
		suggestAtCaret,
		toggle,
		walk,
		decide,
		makeCuts,
		dismissProposal,
		dismissReview,
		dismissFinding,
		showFinding,
		compareFinding,
		compareOpenings,
	};
}

export type LabController = ReturnType<typeof useLab>;
