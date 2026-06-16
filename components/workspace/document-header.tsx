"use client";

import { useEffect, useRef } from "react";

import type { DocumentMeta } from "@/lib/markdown";

type AutoFieldProps = {
	value: string;
	onChange: (value: string) => void;
	onEnter?: () => void;
	placeholder: string;
	ariaLabel: string;
	className: string;
};

/** Single-logical-line field that grows with wrapped content (no scrollbar). */
function AutoField({
	value,
	onChange,
	onEnter,
	placeholder,
	ariaLabel,
	className,
}: AutoFieldProps) {
	const ref = useRef<HTMLTextAreaElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the resize trigger — re-measure whenever the content changes (typed or set externally)
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [value]);

	return (
		<textarea
			ref={ref}
			rows={1}
			value={value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			onChange={(event) => onChange(event.target.value)}
			onKeyDown={(event) => {
				// Enter commits to the body rather than inserting a newline in the title.
				if (event.key === "Enter") {
					event.preventDefault();
					onEnter?.();
				}
			}}
			className={className}
		/>
	);
}

type DocumentHeaderProps = {
	meta: DocumentMeta;
	onChange: (meta: DocumentMeta) => void;
	/** Enter in title/subtitle moves the writer into the body. */
	onEnterBody?: () => void;
};

/**
 * Substack-style document header: title (h1) + subtitle + divider, sitting at the
 * top of the rich writing surface. Backed by YAML frontmatter via the pane.
 */
export function DocumentHeader({
	meta,
	onChange,
	onEnterBody,
}: DocumentHeaderProps) {
	return (
		<div className="recto-doc-header" data-doc-header>
			<AutoField
				value={meta.title}
				onChange={(title) => onChange({ ...meta, title })}
				onEnter={onEnterBody}
				placeholder="Title"
				ariaLabel="Document title"
				className="recto-doc-title"
			/>
			<AutoField
				value={meta.subtitle}
				onChange={(subtitle) => onChange({ ...meta, subtitle })}
				onEnter={onEnterBody}
				placeholder="Add a subtitle…"
				ariaLabel="Document subtitle"
				className="recto-doc-subtitle"
			/>
			<hr className="recto-doc-divider" />
		</div>
	);
}
