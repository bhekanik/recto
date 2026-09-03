"use client";

import { Command } from "cmdk";
import { useCallback, useEffect, useRef } from "react";

import type { Id } from "@/convex/_generated/dataModel";
import {
	ACTIONS,
	type ActionId,
	SECTION_ORDER,
	shortcutHint,
} from "@/lib/keyboard/actions";

type DocMeta = {
	_id: Id<"documents">;
	title: string;
	wordCount: number;
	updatedAt: number;
};

type OutlineHeadingItem = { text: string; depth: number; index: number };

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	scope?: "all" | "documents" | "headings";
	documents: DocMeta[] | undefined;
	headings: OutlineHeadingItem[];
	/** Gate AI commands (plan 009) — hidden unless AI features are enabled. */
	aiEnabled: boolean;
	/** Gate "Manage sharing…" (plan 010) — only the owner can manage sharing. */
	canManageSharing: boolean;
	/** Gate "Review suggestions…" (plan 010 Phase C) — owner with open branches. */
	canReview: boolean;
	/** Gate the comment actions (plan 010 Phase B) — owner or any grantee. */
	canComment: boolean;
	/**
	 * Hide the dark-only palettes while the appearance resolves to light: Paper is
	 * the one light palette, so picking Aurora there would do nothing (ADR-20).
	 */
	darkPalettesAvailable: boolean;
	onRunAction: (id: ActionId) => void;
	onOpenDocument: (id: Id<"documents">) => void;
	onJumpToHeading: (index: number) => void;
	/** macOS + an active document. Hidden otherwise so Windows/Linux never see it. */
	canOpenInMacApp?: boolean;
};

const HEADING =
	"[&_[cmdk-group-heading]]:px-[var(--space-2)] [&_[cmdk-group-heading]]:pt-[var(--space-3)] [&_[cmdk-group-heading]]:pb-[var(--space-1)] [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-[var(--color-ink-tertiary)]";

const ITEM =
	"recto-item flex cursor-pointer items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]";

export function CommandPalette({
	open,
	onOpenChange,
	scope = "all",
	documents,
	headings,
	aiEnabled,
	canManageSharing,
	canReview,
	canComment,
	darkPalettesAvailable,
	onRunAction,
	onOpenDocument,
	onJumpToHeading,
	canOpenInMacApp = false,
}: CommandPaletteProps) {
	const close = useCallback(() => onOpenChange(false), [onOpenChange]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, close]);

	// Restore focus to the previously-active element when the palette closes (§8).
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (open) {
			restoreFocusRef.current = document.activeElement as HTMLElement | null;
		} else if (restoreFocusRef.current) {
			restoreFocusRef.current.focus?.();
			restoreFocusRef.current = null;
		}
	}, [open]);

	if (!open) return null;

	const run = (fn: () => void) => {
		// Run synchronously in the gesture (Copy/Export need transient activation).
		fn();
		close();
	};

	const sections =
		scope === "documents" ? (["Documents"] as const) : SECTION_ORDER;
	const newDoc = ACTIONS.find((a) => a.id === "new-document");
	const openInMac = ACTIONS.find((a) => a.id === "open-in-mac-app");

	return (
		<div
			className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[min(18vh,7rem)]"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
		>
			<button
				type="button"
				className="recto-scrim absolute inset-0"
				aria-label="Close command palette"
				onClick={close}
			/>
			<Command
				className="recto-panel relative z-10 w-full max-w-lg overflow-hidden"
				onMouseDown={(event) => event.stopPropagation()}
				loop
			>
				<div className="border-b border-[var(--color-line)] px-[var(--space-4)]">
					<Command.Input
						placeholder={
							scope === "documents"
								? "Search documents…"
								: scope === "headings"
									? "Go to heading…"
									: "Search commands and documents…"
						}
						autoFocus
						className="h-14 w-full bg-transparent text-[length:var(--text-ui)] leading-[var(--leading-ui)] text-[var(--color-ink-primary)] outline-none placeholder:text-[var(--color-ink-tertiary)]"
					/>
				</div>
				<Command.List className="max-h-[22rem] overflow-y-auto p-[var(--space-1)]">
					<Command.Empty className="px-[var(--space-3)] py-[var(--space-5)] text-center text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
						No matches.
					</Command.Empty>

					{scope === "headings" ? (
						<Command.Group heading="Headings" className={HEADING}>
							{headings.map((h) => (
								<Command.Item
									key={h.index}
									value={`heading ${h.text} ${h.index}`}
									onSelect={() => run(() => onJumpToHeading(h.index))}
									className={ITEM}
								>
									<span
										className="min-w-0 flex-1 truncate text-[var(--color-ink-primary)]"
										style={{ paddingInlineStart: `${(h.depth - 1) * 12}px` }}
									>
										{h.text || "(untitled heading)"}
									</span>
									<span className="shrink-0 text-[var(--color-ink-tertiary)]">
										H{h.depth}
									</span>
								</Command.Item>
							))}
						</Command.Group>
					) : (
						sections.map((section) => {
							if (section === "Documents") {
								return (
									<Command.Group
										key="Documents"
										heading="Documents"
										className={HEADING}
									>
										{newDoc && (
											<Command.Item
												value="new document create add"
												onSelect={() => run(() => onRunAction("new-document"))}
												className={ITEM}
											>
												<span className="flex-1 text-[var(--color-ink-primary)]">
													{newDoc.label}
												</span>
												<kbd className="recto-kbd">{shortcutHint(newDoc)}</kbd>
											</Command.Item>
										)}
										{canOpenInMacApp && openInMac && (
											<Command.Item
												value={`${openInMac.label} ${openInMac.aliases?.join(" ") ?? ""} Documents`}
												onSelect={() =>
													run(() => onRunAction("open-in-mac-app"))
												}
												className={ITEM}
											>
												<span className="flex-1 text-[var(--color-ink-primary)]">
													{openInMac.label}
												</span>
											</Command.Item>
										)}
										{(documents ?? []).map((doc) => (
											<Command.Item
												key={doc._id}
												value={`document ${doc.title}`}
												onSelect={() => run(() => onOpenDocument(doc._id))}
												className={ITEM}
											>
												<span className="min-w-0 flex-1 truncate text-[var(--color-ink-primary)]">
													{doc.title}
												</span>
												<span className="shrink-0 text-[var(--color-ink-tertiary)]">
													{doc.wordCount.toLocaleString()} w
												</span>
											</Command.Item>
										))}
									</Command.Group>
								);
							}

							let defs = ACTIONS.filter(
								(a) =>
									a.section === section &&
									a.id !== "new-document" &&
									a.id !== "open-in-mac-app",
							);
							// AI is opt-in: when disabled, only the toggle is reachable so the
							// user can turn it on; otherwise no AI UI appears (plan 009).
							if (section === "AI" && !aiEnabled) {
								defs = defs.filter((a) => a.id === "toggle-ai");
							}
							// Review section (plan 010): "Manage sharing…" is owner-only;
							// "Review suggestions…" needs the owner to have open branches;
							// the comment actions show for the owner or any grantee.
							if (section === "Review") {
								defs = defs.filter((a) => {
									if (a.id === "manage-sharing") return canManageSharing;
									if (a.id === "review-surface") return canReview;
									if (a.id === "toggle-comments" || a.id === "add-comment") {
										return canComment;
									}
									return canManageSharing;
								});
							}
							// Paper is the only light palette; the dark ones are inert
							// until the appearance resolves to dark (ADR-20).
							if (section === "Theme" && !darkPalettesAvailable) {
								defs = defs.filter((a) => a.id.startsWith("appearance-"));
							}
							if (defs.length === 0) return null;
							return (
								<Command.Group
									key={section}
									heading={section}
									className={HEADING}
								>
									{defs.map((def) => (
										<Command.Item
											key={def.id}
											value={`${def.label} ${def.aliases?.join(" ") ?? ""} ${section}`}
											onSelect={() => run(() => onRunAction(def.id))}
											className={ITEM}
										>
											<span className="flex-1">{def.label}</span>
											{shortcutHint(def) && (
												<kbd className="recto-kbd">{shortcutHint(def)}</kbd>
											)}
										</Command.Item>
									))}
								</Command.Group>
							);
						})
					)}
				</Command.List>
			</Command>
		</div>
	);
}
