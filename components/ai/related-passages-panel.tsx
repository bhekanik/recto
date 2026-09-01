"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Id } from "@/convex/_generated/dataModel";
import type { RelatedPassage } from "@/convex/embeddings";
import { useRag } from "@/lib/ai/use-rag";

type Props = {
	open: boolean;
	/** The current document id (excluded from results). */
	activeDocumentId: Id<"documents"> | null;
	/** Reads the current section/document markdown to use as the query. */
	getQueryText: () => string;
	getSourceNodeId: () => string | null;
	/** Open a cited passage: switch to that doc and scroll to charStart. */
	onOpenPassage: (documentId: Id<"documents">, charStart: number) => void;
	onClose: () => void;
};

type Status = "idle" | "loading" | "ready" | "error";

/**
 * "Related passages from your past drafts" panel (plan 009, Phase C). Embeds the
 * current section, runs Convex vector search, and lists semantically-similar
 * passages WITH citations (source doc title + scroll-to). Structurally modeled on
 * the outline/critique panels. Read-only — surfacing, not editing.
 */
export function RelatedPassagesPanel({
	open,
	activeDocumentId,
	getQueryText,
	getSourceNodeId,
	onOpenPassage,
	onClose,
}: Props) {
	const { findRelated } = useRag();
	const [status, setStatus] = useState<Status>("idle");
	const [passages, setPassages] = useState<RelatedPassage[]>([]);
	const [error, setError] = useState<string | null>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const run = useCallback(async () => {
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		const sourceMarkdown = getQueryText();
		const text = sourceMarkdown.trim();
		if (!text) {
			setStatus("error");
			setError("Nothing to match — the document is empty.");
			return;
		}
		setStatus("loading");
		setError(null);
		try {
			const results = await findRelated({
				documentId: activeDocumentId,
				sourceNodeId: getSourceNodeId(),
				sourceMarkdown,
				queryText: text,
				signal: ac.signal,
			});
			if (ac.signal.aborted) return;
			setPassages(results);
			setStatus("ready");
		} catch (err) {
			if ((err as Error)?.name === "AbortError") return;
			setStatus("error");
			setError((err as Error).message || "Search failed");
		}
	}, [findRelated, getQueryText, getSourceNodeId, activeDocumentId]);

	useEffect(() => {
		if (open) {
			restoreFocusRef.current = document.activeElement as HTMLElement | null;
			void run();
		} else {
			abortRef.current?.abort();
			abortRef.current = null;
			setStatus("idle");
			setPassages([]);
			setError(null);
			restoreFocusRef.current?.focus?.();
			restoreFocusRef.current = null;
		}
	}, [open, run]);

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

	if (!open) return null;

	return (
		<div className="fixed inset-y-0 right-0 z-[90] flex">
			<button
				type="button"
				aria-label="Close related passages"
				className="recto-scrim absolute inset-0 -left-[100vw]"
				onClick={onClose}
			/>
			<aside
				className="recto-panel relative z-10 flex h-full w-[min(24rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
				role="dialog"
				aria-modal="true"
				aria-labelledby="recto-related-title"
			>
				<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
					<h2
						id="recto-related-title"
						className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
					>
						Related passages
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close related passages"
						className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
					>
						<X aria-hidden className="size-4" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-3)] py-[var(--space-3)]">
					{status === "loading" && (
						<p className="px-[var(--space-1)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							Searching your past drafts…
						</p>
					)}
					{status === "error" && (
						<p className="px-[var(--space-1)] py-[var(--space-4)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
							{error}
						</p>
					)}
					{status === "ready" && passages.length === 0 && (
						<p className="px-[var(--space-1)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							No related passages found. Try the “Re-index drafts” command
							first.
						</p>
					)}
					{status === "ready" && passages.length > 0 && (
						<ul className="flex flex-col gap-[var(--space-3)]">
							{passages.map((p) => (
								<li key={`${p.documentId}-${p.charStart}-${p.charEnd}`}>
									<button
										type="button"
										onClick={() => onOpenPassage(p.documentId, p.charStart)}
										className="recto-item block w-full rounded-[var(--radius-md)] border border-[var(--color-line)] px-[var(--space-3)] py-[var(--space-2)] text-left"
									>
										<span className="flex items-center justify-between gap-[var(--space-2)]">
											<span className="min-w-0 flex-1 truncate text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-primary)]">
												{p.title}
											</span>
											<span className="shrink-0 text-[0.625rem] text-[var(--color-ink-tertiary)]">
												{Math.round(p.score * 100)}%
											</span>
										</span>
										<span className="mt-1 line-clamp-3 block text-[length:var(--text-ui-sm)] leading-[var(--leading-ui)] text-[var(--color-ink-secondary)]">
											{p.text.trim()}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
				<footer className="shrink-0 border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-2)] text-[0.6875rem] text-[var(--color-ink-tertiary)]">
					Semantic matches from your own drafts · click to jump
				</footer>
			</aside>
		</div>
	);
}
