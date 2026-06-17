"use client";

import { useMutation, useQuery } from "convex/react";
import { GitBranch, History, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { diffLines, nodeLabel } from "@/lib/history/diff";
import {
	childrenByParent,
	type DocNode,
	indexNodes,
} from "@/lib/history/materialize";
import type { HistoryNode } from "@/lib/history/use-document-history";
import { cn } from "@/lib/utils";
import { useDocumentHistoryFor } from "@/lib/workspace/workspace-context";

export type HistoryView = "tree" | "versions";

type HistoryPanelProps = {
	documentId: Id<"documents">;
	open: boolean;
	view: HistoryView;
	onViewChange: (view: HistoryView) => void;
	onClose: () => void;
};

type Version = {
	_id: Id<"versions">;
	nodeId: string;
	label: string;
	kind: "auto" | "manual";
	createdAt: number;
};

/** Undo-tree style indent: the primary (oldest) child line stays put; branches indent. */
function flattenTree(
	nodes: HistoryNode[],
): { node: HistoryNode; depth: number }[] {
	const children = childrenByParent(nodes as DocNode[]);
	const byId = indexNodes(nodes as DocNode[]);
	const out: { node: HistoryNode; depth: number }[] = [];
	const visit = (id: string, depth: number) => {
		const node = byId.get(id) as HistoryNode | undefined;
		if (!node) return;
		out.push({ node, depth });
		const kids = children.get(id) ?? [];
		kids.forEach((kid, i) => {
			visit(kid, i === 0 ? depth : depth + 1);
		});
	};
	const roots = children.get(null) ?? [];
	roots.forEach((root, i) => {
		visit(root, i === 0 ? 0 : i);
	});
	return out;
}

function formatTime(ms: number): string {
	const d = new Date(ms);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	return sameDay
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function HistoryPanel({
	documentId,
	open,
	view,
	onViewChange,
	onClose,
}: HistoryPanelProps) {
	const history = useDocumentHistoryFor(documentId);
	const versions = useQuery(
		api.versions.list,
		open ? { documentId } : "skip",
	) as Version[] | undefined;
	const removeVersion = useMutation(api.versions.remove);
	const renameVersion = useMutation(api.versions.rename);

	const [preview, setPreview] = useState<string | null>(null);
	const [compare, setCompare] = useState<[string, string] | null>(null);

	useEffect(() => {
		if (!open) {
			setPreview(null);
			setCompare(null);
		}
	}, [open]);

	// Restore focus to the trigger when the panel closes (blueprint 12 §8).
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (open) {
			restoreFocusRef.current = document.activeElement as HTMLElement | null;
		} else if (restoreFocusRef.current) {
			restoreFocusRef.current.focus?.();
			restoreFocusRef.current = null;
		}
	}, [open]);

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

	const taggedByNode = useMemo(() => {
		const map = new Map<string, Version[]>();
		for (const v of versions ?? []) {
			const list = map.get(v.nodeId) ?? [];
			list.push(v);
			map.set(v.nodeId, list);
		}
		return map;
	}, [versions]);

	const rows = useMemo(
		() => (history ? flattenTree(history.nodes) : []),
		[history],
	);

	const compareDiff = useMemo(() => {
		if (!compare || !history) return null;
		const a = history.materializeAt(compare[0]);
		const b = history.materializeAt(compare[1]);
		if (a == null || b == null) return null;
		return diffLines(a, b);
	}, [compare, history]);

	const handleTagCurrent = useCallback(() => {
		if (!history) return;
		const label = window.prompt(
			"Name this version",
			`Version ${new Date().toLocaleString()}`,
		);
		if (label === null) return;
		void history.tagVersion(label || "Version", "manual");
	}, [history]);

	const [compareSel, setCompareSel] = useState<string[]>([]);
	const setCompareSelection = useCallback((nodeId: string) => {
		setCompareSel((prev) => {
			const next = prev.includes(nodeId)
				? prev.filter((id) => id !== nodeId)
				: [...prev, nodeId].slice(-2);
			if (next.length === 2) {
				setCompare([next[0] as string, next[1] as string]);
			} else {
				setCompare(null);
			}
			return next;
		});
	}, []);

	if (!open || !history) return null;

	return (
		<div className="fixed inset-y-0 right-0 z-[90] flex">
			<button
				type="button"
				aria-label="Close history"
				className="recto-scrim absolute inset-0 -left-[100vw]"
				onClick={onClose}
			/>
			<aside
				className="recto-panel relative z-10 flex h-full w-[min(24rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
				role="dialog"
				aria-modal="true"
				aria-labelledby="recto-history-title"
			>
				<h2 id="recto-history-title" className="sr-only">
					Document history
				</h2>
				<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
					<div className="flex items-center gap-[var(--space-1)] rounded-[var(--radius-md)] border border-[var(--color-line)] p-0.5">
						<button
							type="button"
							onClick={() => onViewChange("tree")}
							className={cn(
								"flex items-center gap-1.5 rounded-[var(--radius-sm)] px-[var(--space-2)] py-1 text-[length:var(--text-ui-sm)] transition-colors",
								view === "tree"
									? "bg-[var(--color-accent-wash)] text-[var(--color-ink-primary)]"
									: "text-[var(--color-ink-tertiary)] hover:text-[var(--color-ink-secondary)]",
							)}
						>
							<GitBranch aria-hidden className="size-3.5" /> Undo tree
						</button>
						<button
							type="button"
							onClick={() => onViewChange("versions")}
							className={cn(
								"flex items-center gap-1.5 rounded-[var(--radius-sm)] px-[var(--space-2)] py-1 text-[length:var(--text-ui-sm)] transition-colors",
								view === "versions"
									? "bg-[var(--color-accent-wash)] text-[var(--color-ink-primary)]"
									: "text-[var(--color-ink-tertiary)] hover:text-[var(--color-ink-secondary)]",
							)}
						>
							<History aria-hidden className="size-3.5" /> Versions
						</button>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close history"
						className="text-[var(--color-ink-tertiary)] transition-colors hover:text-[var(--color-ink-primary)]"
					>
						<X aria-hidden className="size-4" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
					{view === "tree" ? (
						<ul className="flex flex-col">
							{rows.map(({ node, depth }) => {
								const isCurrent = node.nodeId === history.currentNodeId;
								const tags = taggedByNode.get(node.nodeId) ?? [];
								return (
									<li key={node.nodeId}>
										<button
											type="button"
											style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
											onMouseEnter={() =>
												setPreview(history.materializeAt(node.nodeId))
											}
											onFocus={() =>
												setPreview(history.materializeAt(node.nodeId))
											}
											onClick={() => history.navigateTo(node.nodeId)}
											className="recto-item flex w-full items-center gap-[var(--space-2)] px-[var(--space-2)] py-1.5 text-left text-[length:var(--text-ui-sm)]"
										>
											<span
												aria-hidden
												className={cn(
													"size-2 shrink-0 rounded-full border",
													isCurrent
														? "border-[var(--color-accent)] bg-[var(--color-accent)]"
														: "border-[var(--color-line-strong)] bg-transparent",
												)}
											/>
											<span
												className={cn(
													"min-w-0 flex-1 truncate",
													isCurrent
														? "text-[var(--color-ink-primary)]"
														: "text-[var(--color-ink-secondary)]",
												)}
											>
												{nodeLabel(node.patch, node.parentNodeId, node.origin)}
											</span>
											{tags.map((t) => (
												<span
													key={t._id}
													className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-accent-wash)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--color-accent-2)]"
												>
													{t.label}
												</span>
											))}
											<span className="shrink-0 text-[var(--color-ink-tertiary)]">
												{formatTime(node.createdAt)}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					) : (
						<div className="flex flex-col gap-[var(--space-2)]">
							<button
								type="button"
								onClick={handleTagCurrent}
								className="mx-[var(--space-1)] rounded-[var(--radius-md)] border border-[var(--color-accent-muted)] bg-[var(--color-accent-wash)] px-[var(--space-3)] py-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-primary)] transition-colors hover:border-[var(--color-accent)]"
							>
								Tag current version
							</button>
							<p className="px-[var(--space-2)] text-[0.6875rem] text-[var(--color-ink-tertiary)]">
								Restore is additive — it never erases later edits.
							</p>
							<ul className="flex flex-col">
								{(versions ?? []).map((v) => {
									const selected = compareSel.includes(v.nodeId);
									return (
										<li
											key={v._id}
											className="recto-item group flex flex-col gap-1 px-[var(--space-2)] py-[var(--space-2)]"
											onMouseEnter={() =>
												setPreview(history.materializeAt(v.nodeId))
											}
											onFocus={() =>
												setPreview(history.materializeAt(v.nodeId))
											}
										>
											<div className="flex items-center gap-[var(--space-2)]">
												<span className="min-w-0 flex-1 truncate text-[length:var(--text-ui-sm)] text-[var(--color-ink-primary)]">
													{v.label}
												</span>
												<span
													className={cn(
														"shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide",
														v.kind === "manual"
															? "text-[var(--color-ink-secondary)]"
															: "text-[var(--color-ink-tertiary)]",
													)}
												>
													{v.kind}
												</span>
												<span className="shrink-0 text-[0.6875rem] text-[var(--color-ink-tertiary)]">
													{formatTime(v.createdAt)}
												</span>
											</div>
											<div className="flex items-center gap-[var(--space-3)] text-[0.6875rem] text-[var(--color-ink-tertiary)]">
												<button
													type="button"
													onClick={() => history.restoreVersion(v.nodeId)}
													className="transition-colors hover:text-[var(--color-accent-2)]"
												>
													Restore
												</button>
												<button
													type="button"
													onClick={() => setCompareSelection(v.nodeId)}
													className={cn(
														"transition-colors hover:text-[var(--color-ink-primary)]",
														selected && "text-[var(--color-accent)]",
													)}
												>
													{selected ? "Comparing" : "Compare"}
												</button>
												{v.kind === "manual" && (
													<button
														type="button"
														onClick={() => {
															const label = window.prompt(
																"Rename version",
																v.label,
															);
															if (label) {
																void renameVersion({
																	documentId,
																	versionId: v._id,
																	label,
																});
															}
														}}
														className="transition-colors hover:text-[var(--color-ink-primary)]"
													>
														Rename
													</button>
												)}
												<button
													type="button"
													onClick={() =>
														void removeVersion({
															documentId,
															versionId: v._id,
														})
													}
													className="transition-colors hover:text-[var(--color-danger)]"
												>
													Delete
												</button>
											</div>
										</li>
									);
								})}
								{versions !== undefined && versions.length === 0 && (
									<li className="px-[var(--space-2)] py-[var(--space-4)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
										No versions yet. Tag one to keep a durable point.
									</li>
								)}
							</ul>
						</div>
					)}
				</div>

				{compareDiff ? (
					<div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-[var(--color-line)] bg-[var(--color-bg-app)] px-[var(--space-3)] py-[var(--space-2)] font-[family-name:var(--font-mono)] text-[0.75rem] leading-relaxed">
						{compareDiff.map((line, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: diff is positional
								key={i}
								className={cn(
									"whitespace-pre-wrap",
									line.type === "add" &&
										"bg-[oklch(0.8_0.09_150/0.12)] text-[var(--color-success)]",
									line.type === "del" &&
										"bg-[oklch(0.7_0.14_25/0.12)] text-[var(--color-danger)]",
									line.type === "same" && "text-[var(--color-ink-tertiary)]",
								)}
							>
								{line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
								{line.text || " "}
							</div>
						))}
					</div>
				) : preview != null ? (
					<div className="max-h-[28%] shrink-0 overflow-y-auto border-t border-[var(--color-line)] bg-[var(--color-bg-app)] px-[var(--space-3)] py-[var(--space-2)] font-[family-name:var(--font-mono)] text-[0.75rem] text-[var(--color-ink-tertiary)]">
						<div className="whitespace-pre-wrap">
							{preview.slice(0, 500) || "(empty)"}
							{preview.length > 500 ? "…" : ""}
						</div>
					</div>
				) : null}
			</aside>
		</div>
	);
}
