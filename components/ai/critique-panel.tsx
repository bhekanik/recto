"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CritiqueNote } from "@/lib/ai/transform-request";

type Props = {
	open: boolean;
	/** Reads the current section/document markdown to critique. */
	getText: () => string;
	onClose: () => void;
};

type Status = "idle" | "loading" | "ready" | "error";

/**
 * Editorial critique side panel (plan 009, Phase B). Read-only: it fetches
 * qualitative feedback from the critique route and renders it. It exposes NO
 * control that edits the document or commits a node. Structurally modeled on
 * components/outline/outline-panel.tsx (fixed inset-y right aside, recto-panel,
 * scrim, Escape-to-close, focus restore).
 */
export function CritiquePanel({ open, getText, onClose }: Props) {
	const [status, setStatus] = useState<Status>("idle");
	const [notes, setNotes] = useState<CritiqueNote[]>([]);
	const [error, setError] = useState<string | null>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const run = useCallback(async () => {
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		const text = getText().trim();
		if (!text) {
			setStatus("error");
			setError("Nothing to critique — the document is empty.");
			return;
		}
		setStatus("loading");
		setError(null);
		try {
			const res = await fetch("/api/ai/critique", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
				signal: ac.signal,
			});
			if (!res.ok) {
				setStatus("error");
				setError(
					res.status === 401
						? "Sign in to use AI"
						: `Request failed (${res.status})`,
				);
				return;
			}
			const data = (await res.json()) as { notes: CritiqueNote[] };
			setNotes(data.notes ?? []);
			setStatus("ready");
		} catch (err) {
			if ((err as Error)?.name === "AbortError") return;
			setStatus("error");
			setError((err as Error).message || "Request failed");
		}
	}, [getText]);

	// Fetch when the panel opens; abort on close.
	useEffect(() => {
		if (open) {
			restoreFocusRef.current = document.activeElement as HTMLElement | null;
			void run();
		} else {
			abortRef.current?.abort();
			abortRef.current = null;
			setStatus("idle");
			setNotes([]);
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
				aria-label="Close critique"
				className="recto-scrim absolute inset-0 -left-[100vw]"
				onClick={onClose}
			/>
			<aside
				className="recto-panel relative z-10 flex h-full w-[min(22rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
				role="dialog"
				aria-modal="true"
				aria-labelledby="recto-critique-title"
			>
				<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
					<h2
						id="recto-critique-title"
						className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
					>
						Editorial critique
					</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close critique"
						className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
					>
						<X aria-hidden className="size-4" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-3)] py-[var(--space-3)]">
					{status === "loading" && (
						<p className="px-[var(--space-1)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							Reading your draft…
						</p>
					)}
					{status === "error" && (
						<p className="px-[var(--space-1)] py-[var(--space-4)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
							{error}
						</p>
					)}
					{status === "ready" && notes.length === 0 && (
						<p className="px-[var(--space-1)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
							No notes — looks solid.
						</p>
					)}
					{status === "ready" && notes.length > 0 && (
						<ul className="flex flex-col gap-[var(--space-3)]">
							{notes.map((n) => (
								<li
									key={`${n.category}::${n.note}`}
									className="rounded-[var(--radius-md)] border border-[var(--color-line)] px-[var(--space-3)] py-[var(--space-2)]"
								>
									<span className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-[var(--color-ink-tertiary)]">
										{n.category}
									</span>
									<p className="mt-1 text-[length:var(--text-ui-sm)] leading-[var(--leading-ui)] text-[var(--color-ink-secondary)]">
										{n.note}
									</p>
								</li>
							))}
						</ul>
					)}
				</div>
				<footer className="shrink-0 border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-2)] text-[0.6875rem] text-[var(--color-ink-tertiary)]">
					Read-only feedback — no edits are applied.
				</footer>
			</aside>
		</div>
	);
}
