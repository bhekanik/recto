"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
	filterSlashEntries,
	type SlashEntry,
} from "@/lib/editor/milkdown/slash-entries";

type SlashMenuProps = {
	open: boolean;
	query: string;
	onSelect: (entry: SlashEntry) => void;
	onClose: () => void;
};

export function SlashMenu({ open, query, onSelect, onClose }: SlashMenuProps) {
	const [index, setIndex] = useState(0);
	const items = filterSlashEntries(query.replace(/^\//, ""));

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset highlight when filter changes
	useEffect(() => {
		setIndex(0);
	}, [query]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (!open) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setIndex((i) => (i + 1) % Math.max(items.length, 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setIndex(
					(i) =>
						(i - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1),
				);
			} else if (e.key === "Enter" && items[index]) {
				e.preventDefault();
				onSelect(items[index]);
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		},
		[open, items, index, onSelect, onClose],
	);

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [handleKeyDown]);

	if (!open || items.length === 0) return null;

	return (
		<div
			role="listbox"
			className="min-w-[12rem] rounded-[var(--radius-md)] border border-border bg-[var(--color-bg-raised)] py-1 shadow-lg"
			data-show="true"
		>
			{items.map((item, i) => (
				<button
					key={item.id}
					type="button"
					role="option"
					aria-selected={i === index}
					className={`block w-full px-3 py-1.5 text-left text-[length:var(--text-ui-sm)] ${
						i === index
							? "bg-[var(--color-bg-hover)] text-[var(--color-ink-primary)]"
							: "text-[var(--color-ink-secondary)]"
					}`}
					onMouseDown={(e) => {
						e.preventDefault();
						onSelect(item);
					}}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}

/** Hook for slash query state synced with SlashProvider content. */
export function useSlashQuery(contentRef: React.RefObject<HTMLElement | null>) {
	const [query, setQuery] = useState("");
	const observerRef = useRef<MutationObserver | null>(null);

	useEffect(() => {
		const el = contentRef.current;
		if (!el) return;
		const read = () => setQuery(el.dataset.query ?? "");
		read();
		observerRef.current = new MutationObserver(read);
		observerRef.current.observe(el, {
			attributes: true,
			attributeFilter: ["data-query"],
		});
		return () => observerRef.current?.disconnect();
	}, [contentRef]);

	return query;
}
