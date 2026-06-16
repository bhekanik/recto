"use client";

import { useMemo } from "react";

import { splitFrontmatter } from "@/lib/markdown";
import { renderPreviewHtml } from "@/lib/preview/render";

type PreviewPaneProps = {
	markdown: string;
	className?: string;
};

export function PreviewPane({ markdown, className }: PreviewPaneProps) {
	const { meta, body } = useMemo(() => splitFrontmatter(markdown), [markdown]);
	const html = useMemo(() => renderPreviewHtml(body), [body]);
	const hasHeader = Boolean(meta.title.trim() || meta.subtitle.trim());

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
