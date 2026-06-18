"use client";

import { useMemo } from "react";

import { EmailPreview } from "@/components/workspace/email-preview";
import { splitFrontmatter } from "@/lib/markdown";
import { renderPreviewHtml } from "@/lib/preview/render";
import { useStudioSettingsContext } from "@/lib/studio/settings-context";

type PreviewPaneProps = {
	markdown: string;
	/** Falls back to this when the doc has no subject/title (email preview). */
	fallbackTitle?: string;
	className?: string;
};

export function PreviewPane({
	markdown,
	fallbackTitle = "Untitled",
	className,
}: PreviewPaneProps) {
	const { previewVariant } = useStudioSettingsContext();
	const { meta, body } = useMemo(() => splitFrontmatter(markdown), [markdown]);
	const html = useMemo(() => renderPreviewHtml(body), [body]);
	const hasHeader = Boolean(meta.title.trim() || meta.subtitle.trim());

	if (previewVariant === "email") {
		return (
			<EmailPreview
				markdown={markdown}
				fallbackTitle={fallbackTitle}
				className={className}
			/>
		);
	}

	return (
		<article className={className}>
			{hasHeader && (
				<div className="recto-doc-header">
					{meta.title.trim() && (
						<h1 className="recto-doc-title">{meta.title}</h1>
					)}
					{meta.subtitle.trim() && (
						<p className="recto-doc-subtitle">{meta.subtitle}</p>
					)}
					<hr className="recto-doc-divider" />
				</div>
			)}
			<div
				className="recto-prose"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via rehype-sanitize
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</article>
	);
}
