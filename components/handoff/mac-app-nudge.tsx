"use client";

import { AppWindowMac, Download, X } from "lucide-react";
import { useEffect } from "react";

import { buttonVariants } from "@/components/ui/button";
import {
	MAC_APP_DOWNLOAD_URL,
	MAC_APP_REQUIREMENTS,
} from "@/lib/handoff/mac-app";
import { cn } from "@/lib/utils";

type MacAppNudgeProps = {
	onClose: () => void;
};

/** How long the offer stays before it gets out of the way on its own. */
const DISMISS_AFTER_MS = 15_000;

/**
 * Shown when "Open in Recto app" went nowhere: the likeliest reason is that
 * the app isn't installed, so this offers it, once, where the writer asked
 * for it, and leaves without a trace if ignored.
 */
export function MacAppNudge({ onClose }: MacAppNudgeProps) {
	useEffect(() => {
		const timer = window.setTimeout(onClose, DISMISS_AFTER_MS);
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	return (
		<aside
			role="status"
			aria-live="polite"
			className="recto-panel fixed right-[var(--space-4)] bottom-[calc(var(--space-8)+var(--space-4))] z-[90] flex w-[min(20rem,calc(100vw-2rem))] items-start gap-[var(--space-3)] p-[var(--space-4)]"
		>
			<AppWindowMac
				aria-hidden
				className="mt-0.5 size-5 shrink-0 text-[var(--color-ink-tertiary)]"
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-[var(--space-2)]">
				<div>
					<p className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-primary)]">
						Recto for Mac didn’t open
					</p>
					<p className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
						If it isn’t on this Mac yet, it’s a free download.
					</p>
				</div>
				<a
					href={MAC_APP_DOWNLOAD_URL}
					onClick={onClose}
					className={cn(buttonVariants({ size: "sm" }), "self-start")}
				>
					<Download aria-hidden />
					Download for Mac
				</a>
				<p className="text-[0.6875rem] text-[var(--color-ink-tertiary)]">
					{MAC_APP_REQUIREMENTS}
				</p>
			</div>
			<button
				type="button"
				onClick={onClose}
				aria-label="Dismiss"
				className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
			>
				<X aria-hidden className="size-4" />
			</button>
		</aside>
	);
}
