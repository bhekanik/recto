"use client";

import { useMemo } from "react";

import { renderPreviewHtml } from "@/lib/preview/render";

type PreviewPaneProps = {
	markdown: string;
	className?: string;
};

export function PreviewPane({ markdown, className }: PreviewPaneProps) {
	const html = useMemo(() => renderPreviewHtml(markdown), [markdown]);

	return (
		<article
			className={className}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via rehype-sanitize
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
