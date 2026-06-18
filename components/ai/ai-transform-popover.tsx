"use client";

import { Command } from "cmdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TransformRange } from "@/lib/ai/apply-transform";
import { instructionLabel, TRANSFORM_PRESETS } from "@/lib/ai/instructions";
import type { AiTransformState } from "@/lib/ai/use-ai-transform";

const HEADING =
	"[&_[cmdk-group-heading]]:px-[var(--space-2)] [&_[cmdk-group-heading]]:pt-[var(--space-3)] [&_[cmdk-group-heading]]:pb-[var(--space-1)] [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-[var(--color-ink-tertiary)]";

const ITEM =
	"recto-item flex cursor-pointer items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]";

export type AiTransformRequest = {
	instruction: string;
	instructionLabel: string;
	range: TransformRange;
	selection: string;
};

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The selected span + its offsets, captured when the popover opened. */
	selection: { text: string; range: TransformRange } | null;
	state: AiTransformState;
	onRun: (req: AiTransformRequest) => void;
	onAccept: () => void;
	onReject: () => void;
	onCancel: () => void;
};

/**
 * ⌘K-style instruction picker for the reversible AI transform (plan 009, Phase A).
 * Lists presets + a free-text instruction; streams the result inline; in
 * "pending" mode shows an accept/reject control. Composed from cmdk + the shared
 * panel tokens (mirrors components/command-palette.tsx). Mounted only when AI is
 * enabled.
 */
export function AiTransformPopover({
	open,
	onOpenChange,
	selection,
	state,
	onRun,
	onAccept,
	onReject,
	onCancel,
}: Props) {
	const [query, setQuery] = useState("");
	const restoreFocusRef = useRef<HTMLElement | null>(null);

	const close = useCallback(() => onOpenChange(false), [onOpenChange]);

	// Reset the input each time it opens.
	useEffect(() => {
		if (open) setQuery("");
	}, [open]);

	// Escape: cancel a stream / dismiss; restore focus on close.
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
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				if (state.status === "streaming") onCancel();
				else if (state.awaitingDecision) onReject();
				else close();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, close, onCancel, onReject, state.status, state.awaitingDecision]);

	if (!open || !selection) return null;

	const run = (instruction: string, label: string) => {
		if (!instruction.trim()) return;
		onRun({
			instruction,
			instructionLabel: label,
			range: selection.range,
			selection: selection.text,
		});
	};

	const streaming = state.status === "streaming";
	const showPicker = state.status === "idle";

	return (
		<div
			className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[min(18vh,7rem)]"
			role="dialog"
			aria-modal="true"
			aria-label="AI transform"
		>
			<button
				type="button"
				className="recto-scrim absolute inset-0"
				aria-label="Close AI transform"
				onClick={() => {
					if (streaming) onCancel();
					else if (state.awaitingDecision) onReject();
					else close();
				}}
			/>
			<div className="recto-panel relative z-10 w-full max-w-lg overflow-hidden">
				{showPicker ? (
					<Command className="w-full" loop>
						<div className="border-b border-[var(--color-line)] px-[var(--space-4)]">
							<Command.Input
								value={query}
								onValueChange={setQuery}
								placeholder="Transform selection… (or pick a preset)"
								autoFocus
								onKeyDown={(e) => {
									// Enter on free text with no matching item runs it verbatim.
									if (e.key === "Enter" && query.trim()) {
										const hasPreset = TRANSFORM_PRESETS.some((p) =>
											p.label
												.toLowerCase()
												.includes(query.trim().toLowerCase()),
										);
										if (!hasPreset) {
											e.preventDefault();
											run(query.trim(), instructionLabel({ freeText: query }));
										}
									}
								}}
								className="h-14 w-full bg-transparent text-[length:var(--text-ui)] leading-[var(--leading-ui)] text-[var(--color-ink-primary)] outline-none placeholder:text-[var(--color-ink-tertiary)]"
							/>
						</div>
						<Command.List className="max-h-[22rem] overflow-y-auto p-[var(--space-1)]">
							<Command.Group heading="Presets" className={HEADING}>
								{TRANSFORM_PRESETS.map((preset) => (
									<Command.Item
										key={preset.id}
										value={`${preset.label} ${preset.id}`}
										onSelect={() => run(preset.prompt, preset.label)}
										className={ITEM}
									>
										<span className="flex-1 text-[var(--color-ink-primary)]">
											{preset.label}
										</span>
									</Command.Item>
								))}
							</Command.Group>
							{query.trim() && (
								<Command.Group heading="Custom" className={HEADING}>
									<Command.Item
										value={`custom-instruction ${query}`}
										onSelect={() =>
											run(query.trim(), instructionLabel({ freeText: query }))
										}
										className={ITEM}
									>
										<span className="flex-1 truncate text-[var(--color-ink-primary)]">
											Run: “{query.trim()}”
										</span>
									</Command.Item>
								</Command.Group>
							)}
						</Command.List>
						<div className="border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-2)] text-[0.6875rem] text-[var(--color-ink-tertiary)]">
							{selection.text.length} chars selected · reversible — undo to
							reject
						</div>
					</Command>
				) : (
					<div className="flex flex-col">
						<div className="border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
							<span className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]">
								{streaming
									? "Transforming…"
									: state.status === "error"
										? "AI error"
										: "AI suggestion"}
							</span>
						</div>
						<div className="max-h-[22rem] overflow-y-auto px-[var(--space-4)] py-[var(--space-3)]">
							{state.status === "error" ? (
								<p className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
									{state.error}
								</p>
							) : (
								<p className="whitespace-pre-wrap text-[length:var(--text-ui-sm)] leading-[var(--leading-ui)] text-[var(--color-ink-primary)]">
									{state.partial || "…"}
								</p>
							)}
						</div>
						<div className="flex items-center justify-end gap-[var(--space-2)] border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-2)]">
							{streaming && (
								<button
									type="button"
									onClick={onCancel}
									className="recto-item rounded-[var(--radius-sm)] px-[var(--space-3)] py-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
								>
									Cancel
								</button>
							)}
							{state.awaitingDecision && (
								<>
									<button
										type="button"
										onClick={() => {
											onReject();
											close();
										}}
										className="recto-item rounded-[var(--radius-sm)] px-[var(--space-3)] py-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
									>
										Reject (undo)
									</button>
									<button
										type="button"
										onClick={() => {
											onAccept();
											close();
										}}
										className="recto-item rounded-[var(--radius-sm)] bg-[var(--color-bg-hover)] px-[var(--space-3)] py-1.5 text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-primary)]"
									>
										Keep
									</button>
								</>
							)}
							{state.status === "error" && (
								<button
									type="button"
									onClick={close}
									className="recto-item rounded-[var(--radius-sm)] px-[var(--space-3)] py-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
								>
									Close
								</button>
							)}
							{state.status === "committed" && !state.awaitingDecision && (
								<button
									type="button"
									onClick={close}
									className="recto-item rounded-[var(--radius-sm)] px-[var(--space-3)] py-1.5 text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]"
								>
									Done
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
