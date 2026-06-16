"use client";

import { useEffect, useState } from "react";

import type { ToastDetail } from "@/lib/ui/toast";
import { cn } from "@/lib/utils";

/** Transient toasts, announced via a polite live region (blueprint 12 §8). */
export function Toaster() {
	const [toasts, setToasts] = useState<ToastDetail[]>([]);

	useEffect(() => {
		const onToast = (event: Event) => {
			const detail = (event as CustomEvent<ToastDetail>).detail;
			setToasts((prev) => [...prev, detail]);
			window.setTimeout(() => {
				setToasts((prev) => prev.filter((t) => t.id !== detail.id));
			}, 3000);
		};
		window.addEventListener("recto:toast", onToast);
		return () => window.removeEventListener("recto:toast", onToast);
	}, []);

	const renderToast = (t: ToastDetail) => (
		<div
			key={t.id}
			className={cn(
				"recto-panel pointer-events-auto flex items-center gap-[var(--space-2)] rounded-[var(--radius-md)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-ui-sm)]",
				t.kind === "error"
					? "text-[var(--color-danger)]"
					: t.kind === "success"
						? "text-[var(--color-ink-primary)]"
						: "text-[var(--color-ink-secondary)]",
			)}
		>
			{t.kind === "success" && (
				<span
					aria-hidden
					className="size-1.5 rounded-full bg-[var(--color-success)]"
				/>
			)}
			{t.message}
		</div>
	);

	const errors = toasts.filter((t) => t.kind === "error");
	const others = toasts.filter((t) => t.kind !== "error");

	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-10 z-[120] flex flex-col items-center gap-[var(--space-2)]">
			{/* Errors are announced assertively; everything else politely (§8). */}
			<div role="alert" aria-live="assertive" className="contents">
				{errors.map(renderToast)}
			</div>
			<div role="status" aria-live="polite" className="contents">
				{others.map(renderToast)}
			</div>
		</div>
	);
}
