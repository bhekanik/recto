"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { EditorHandle } from "@/lib/editor/handle";
import type { HistoryController } from "@/lib/history/use-document-history";
import type { Mode } from "@/lib/modes/types";
import { toast } from "@/lib/ui/toast";
import type { DocumentModelRegistry } from "@/lib/workspace/document-registry";
import { adding, choosing, removing } from "./edits";
import {
	emptyWritingState,
	validateWritingState,
	type WritingState,
	writingStateFor,
} from "./state";
import {
	type AlternativeTargets,
	alternativeTargets,
	articleFix,
	type Range,
	type Scope,
} from "./targets";

type Deps = {
	registry: DocumentModelRegistry;
	activeDocId: Id<"documents"> | null;
	activePaneId: string | null;
	activeMode: Mode;
	getController: () => HistoryController | null;
};

/** A wording shown in place but not yet kept; `base` is the text under it. */
type Preview = {
	groupId: string;
	startId: string;
	shownId: string;
	base: string;
	baseState: WritingState;
	article: { from: number; to: number; text: string } | null;
};

/**
 * Alternatives on the web, as on the Mac: wordings are added as one history
 * node each; Up and Down show a wording in place without touching history
 * (a programmatic seed records nothing); keeping commits one structural node
 * with the new writing state; returning to the text keeps what is on show.
 */
export function useAlternatives({
	registry,
	activeDocId,
	activePaneId,
	activeMode,
	getController,
}: Deps) {
	const [targets, setTargets] = useState<AlternativeTargets | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const previewRef = useRef<Preview | null>(null);
	previewRef.current = preview;
	// Bumped after this hook commits, so the panel re-renders and re-derives.
	const [, setRevision] = useState(0);

	const resolve = useCallback((): {
		handle: EditorHandle;
		controller: HistoryController;
	} | null => {
		if (!activeDocId || activeMode === "preview") return null;
		const handle = registry.getPrimaryHandle(activeDocId, activePaneId);
		const controller = getController();
		return handle && controller ? { handle, controller } : null;
	}, [registry, activeDocId, activePaneId, activeMode, getController]);

	/** The state on the text on screen, the preview's while one shows. */
	const writing = useCallback((): WritingState => {
		const shown = previewRef.current;
		if (shown) {
			const choice = choosing(
				shown.baseState,
				shown.shownId,
				shown.groupId,
				shown.base,
				shown.article ?? undefined,
			);
			if (choice) return choice.state;
		}
		const target = resolve();
		if (!target) return emptyWritingState();
		return (
			writingStateFor(
				target.handle.getCanonicalMarkdown(),
				target.controller,
			) ?? emptyWritingState()
		);
	}, [resolve]);

	const open = useCallback(() => {
		const target = resolve();
		if (!target) {
			toast("Switch to Rich, Raw or Vim to compare wordings.", "info");
			return;
		}
		const { handle } = target;
		const markdown = handle.getCanonicalMarkdown();
		let selection: Range | null = null;
		if (activeMode === "rich") {
			const selected = handle.getSelectedMarkdown?.() ?? null;
			if (selected) {
				const at = markdown.indexOf(selected);
				if (at !== -1 && markdown.indexOf(selected, at + 1) === -1) {
					selection = { from: at, to: at + selected.length };
				}
			}
			if (!selection) {
				const caret = handle.getMarkdownCaret?.() ?? null;
				if (caret !== null) selection = { from: caret, to: caret };
			}
		} else {
			const caret = handle.exportCaret();
			selection = {
				from: Math.min(caret.anchor, caret.head),
				to: Math.max(caret.anchor, caret.head),
			};
		}
		const next = selection ? alternativeTargets(markdown, selection) : null;
		if (!next) {
			toast(
				"Put the caret in a word, or select the passage to compare.",
				"info",
			);
			return;
		}
		setTargets(next);
	}, [resolve, activeMode]);

	const commit = useCallback(
		(state: WritingState, markdown?: string) => {
			const target = resolve();
			if (!target) return;
			const text = markdown ?? target.handle.getCanonicalMarkdown();
			target.controller.commitWriting(
				JSON.stringify(validateWritingState(state, text)),
				markdown,
			);
			setRevision((value) => value + 1);
		},
		[resolve],
	);

	const keep = useCallback(async () => {
		const shown = previewRef.current;
		if (!shown) return;
		setPreview(null);
		if (shown.shownId === shown.startId) {
			resolve()?.handle.seed(shown.base, { programmatic: true });
			return;
		}
		const group = shown.baseState.alternatives.find(
			(g) => g.id === shown.groupId,
		);
		const wording = group?.candidates.find((c) => c.id === shown.shownId)?.text;
		const article =
			shown.article ??
			(group && wording
				? await articleFix(shown.base, group.location, wording)
				: null);
		const choice = choosing(
			shown.baseState,
			shown.shownId,
			shown.groupId,
			shown.base,
			article ?? undefined,
		);
		if (!choice) return;
		const result =
			shown.base.slice(0, choice.from) +
			choice.text +
			shown.base.slice(choice.to);
		commit(choice.state, result);
	}, [resolve, commit]);

	const show = useCallback(
		(candidateId: string, groupId: string) => {
			const target = resolve();
			if (!target) return;
			let shown = previewRef.current;
			if (!shown) {
				target.controller.flush();
				const base = target.handle.getCanonicalMarkdown();
				const baseState =
					writingStateFor(base, target.controller) ?? emptyWritingState();
				const group = baseState.alternatives.find((g) => g.id === groupId);
				if (!group) return;
				shown = {
					groupId,
					startId: group.activeId,
					shownId: group.activeId,
					base,
					baseState,
					article: null,
				};
			}
			const next: Preview = {
				...shown,
				groupId,
				shownId: candidateId,
				article: null,
			};
			const choice = choosing(next.baseState, candidateId, groupId, next.base);
			if (!choice) return;
			setPreview(next);
			previewRef.current = next;
			target.handle.seed(
				next.base.slice(0, choice.from) +
					choice.text +
					next.base.slice(choice.to),
				{ programmatic: true },
			);
			const group = next.baseState.alternatives.find((g) => g.id === groupId);
			const wording = group?.candidates.find((c) => c.id === candidateId)?.text;
			if (!group || !wording) return;
			void articleFix(next.base, group.location, wording).then((article) => {
				const current = previewRef.current;
				if (
					!article ||
					!current ||
					current.shownId !== candidateId ||
					current.base !== next.base
				)
					return;
				const withArticle = { ...current, article };
				const fixed = choosing(
					withArticle.baseState,
					candidateId,
					groupId,
					withArticle.base,
					article,
				);
				if (!fixed) return;
				setPreview(withArticle);
				previewRef.current = withArticle;
				resolve()?.handle.seed(
					withArticle.base.slice(0, fixed.from) +
						fixed.text +
						withArticle.base.slice(fixed.to),
					{ programmatic: true },
				);
			});
		},
		[resolve],
	);

	const restore = useCallback(() => {
		const shown = previewRef.current;
		if (!shown) return;
		setPreview(null);
		previewRef.current = null;
		resolve()?.handle.seed(shown.base, { programmatic: true });
	}, [resolve]);

	const add = useCallback(
		(text: string, scope: Scope, range: Range) => {
			const target = resolve();
			if (!target) return;
			target.controller.flush();
			const markdown = target.handle.getCanonicalMarkdown();
			const state =
				writingStateFor(markdown, target.controller) ?? emptyWritingState();
			const next = adding(
				state,
				text,
				"human",
				scope,
				range.from,
				range.to,
				markdown,
				() => crypto.randomUUID(),
			);
			if (!next) {
				toast(
					"Alternatives cannot overlap another passage with alternatives.",
					"info",
				);
				return;
			}
			if (next !== state) commit(next);
		},
		[resolve, commit],
	);

	const remove = useCallback(
		(candidateId: string, groupId: string) => {
			const target = resolve();
			if (!target) return;
			const markdown = target.handle.getCanonicalMarkdown();
			const state =
				writingStateFor(markdown, target.controller) ?? emptyWritingState();
			const next = removing(state, candidateId, groupId);
			if (next) commit(next);
		},
		[resolve, commit],
	);

	const close = useCallback(() => {
		void keep();
		setTargets(null);
	}, [keep]);

	// Back in the text: the wording on show is the one the writer chose.
	useEffect(() => {
		if (!preview) return;
		const root = resolve()?.handle.getRootElement();
		if (!root) return;
		const onFocus = () => void keep();
		root.addEventListener("focusin", onFocus);
		return () => root.removeEventListener("focusin", onFocus);
	}, [preview, resolve, keep]);

	return {
		targets,
		previewShownId: preview?.shownId ?? null,
		writing,
		open,
		close,
		add,
		show,
		keep,
		restore,
		remove,
	};
}

export type AlternativesController = ReturnType<typeof useAlternatives>;
