"use client";

import { useMemo } from "react";

import { emailInboxModel } from "@/lib/export";

type EmailPreviewProps = {
	markdown: string;
	/** Used when the doc has no subject/title (e.g. "Untitled"). */
	fallbackTitle: string;
	className?: string;
};

/**
 * Inbox / email preview (plan 008). Dark OKLCH inbox chrome (app chrome → tokens)
 * frames a light, inline-styled "window" showing how the email body renders in a
 * client. This is preview-only: the sender is a static placeholder ("You"), with
 * NO recipient, address, or transport — Recto does not send (overview §8 / §5e).
 */
export function EmailPreview({
	markdown,
	fallbackTitle,
	className,
}: EmailPreviewProps) {
	const { subject, preview, bodyHtml } = useMemo(
		() => emailInboxModel(markdown, fallbackTitle),
		[markdown, fallbackTitle],
	);

	return (
		<article className={className}>
			<div className="mx-auto max-w-[42rem]">
				<div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-raised)]">
					{/* Inbox row chrome — placeholder sender, subject, preheader snippet. */}
					<div className="border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
						<div className="flex items-baseline justify-between gap-[var(--space-3)]">
							<span className="truncate font-[family-name:var(--font-ui)] text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]">
								You
							</span>
							<span className="shrink-0 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
								Preview
							</span>
						</div>
						<div className="mt-[var(--space-1)] truncate font-[family-name:var(--font-ui)] text-[length:var(--text-ui)] font-semibold text-[var(--color-ink-primary)]">
							{subject}
						</div>
						{preview && (
							<div className="mt-[var(--space-1)] line-clamp-2 text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
								{preview}
							</div>
						)}
					</div>
					{/* The email body as a light "window" — exactly how a client renders it. */}
					<div
						className="overflow-auto bg-white px-[var(--space-6)] py-[var(--space-5)] text-[15px] leading-[1.65] text-[#1a1a1a] [font-family:'Source_Serif_4',Georgia,'Times_New_Roman',serif]"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: built from the user's own single-user canonical document via the export pipeline (allowDangerousHtml:false, dialect-only) — same trust model as lib/export (blueprint 11 §6)
						dangerouslySetInnerHTML={{ __html: bodyHtml }}
					/>
				</div>
			</div>
		</article>
	);
}
