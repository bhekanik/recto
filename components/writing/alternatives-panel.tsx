"use client";

import { Circle, LoaderCircle, Minus, Sparkle, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AlternativeGroup } from "@/lib/writing/state";
import type { Range, Scope } from "@/lib/writing/targets";
import type { AlternativesController } from "@/lib/writing/use-alternatives";

const SCOPES: { scope: Scope; label: string }[] = [
	{ scope: "word", label: "Word" },
	{ scope: "sentence", label: "Sentence" },
	{ scope: "paragraph", label: "Paragraph" },
];

/**
 * Wordings for one passage beside the draft. Up and Down show each wording in
 * place, Return with an empty field keeps the one on show, Return with text
 * saves it as another wording, Escape puts the starting wording back.
 */
export function AlternativesPanel({
	alternatives,
	suggest,
	suggesting = false,
}: {
	alternatives: AlternativesController;
	/** Ask the AI for wordings of a passage; absent while AI is off. */
	suggest?: (range: Range, scope: Scope) => void;
	suggesting?: boolean;
}) {
	const targets = alternatives.targets;
	const [scope, setScope] = useState<Scope | null>(null);
	const [draft, setDraft] = useState("");
	if (!targets) return null;
	const current = scope ?? targets.initial;
	const range = targets.ranges[current];
	const writing = alternatives.writing();
	const group: AlternativeGroup | undefined = range
		? writing.alternatives.find(
				(g) =>
					!g.detached &&
					g.location === range.from &&
					(g.scope === current || g.length === range.to - range.from),
			)
		: undefined;
	const shownId = alternatives.previewShownId ?? group?.activeId ?? null;

	const step = (offset: number) => {
		if (!group || !shownId) return;
		const index = group.candidates.findIndex((c) => c.id === shownId);
		const next =
			group.candidates[
				(index + offset + group.candidates.length) % group.candidates.length
			];
		if (next) alternatives.show(next.id, group.id);
	};

	return (
		<aside
			className="recto-panel fixed inset-y-0 left-0 z-[80] flex w-[min(18rem,100vw)] flex-col rounded-none border-y-0 border-l-0 border-r"
			aria-labelledby="recto-alternatives-title"
		>
			<header className="flex shrink-0 items-center justify-between gap-[var(--space-2)] border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
				<h2
					id="recto-alternatives-title"
					className="text-[length:var(--text-ui-sm)] font-medium text-[var(--color-ink-secondary)]"
				>
					Alternatives
				</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() => {
						alternatives.restore();
						alternatives.close();
					}}
					aria-label="Close alternatives"
				>
					<X aria-hidden />
				</Button>
			</header>
			<fieldset
				className="m-0 flex gap-[var(--space-1)] border-0 px-[var(--space-4)] pt-[var(--space-3)]"
				aria-label="Scope"
			>
				{SCOPES.map((option) => (
					<Button
						key={option.scope}
						size="sm"
						variant={option.scope === current ? "secondary" : "ghost"}
						disabled={
							!targets.ranges[option.scope] ||
							alternatives.previewShownId !== null
						}
						aria-pressed={option.scope === current}
						onClick={() => setScope(option.scope)}
					>
						{option.label}
					</Button>
				))}
			</fieldset>
			<ul className="flex min-h-0 flex-1 flex-col gap-[var(--space-1)] overflow-auto px-[var(--space-4)] py-[var(--space-3)]">
				{group?.candidates.map((candidate, index) => {
					const shown = candidate.id === shownId;
					return (
						<li
							key={candidate.id}
							className={cn(
								"flex items-center gap-[var(--space-2)] rounded-[var(--radius-sm)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-ui-sm)]",
								shown
									? "bg-[var(--color-accent-wash)] text-[var(--color-ink-primary)]"
									: "text-[var(--color-ink-secondary)]",
							)}
						>
							{candidate.author === "ai" ? (
								<Sparkle
									aria-label="Suggested by AI"
									className="size-3 shrink-0"
								/>
							) : (
								<Circle
									aria-label="Your wording"
									className="size-2 shrink-0 fill-current"
								/>
							)}
							<button
								type="button"
								className="min-w-0 flex-1 text-left"
								onClick={() =>
									group && alternatives.show(candidate.id, group.id)
								}
							>
								{candidate.text}
							</button>
							{index === 0 && (
								<span className="text-[var(--color-ink-tertiary)]">
									original
								</span>
							)}
							{!shown && index > 0 && group && (
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Remove ${candidate.text}`}
									onClick={() => alternatives.remove(candidate.id, group.id)}
								>
									<Minus aria-hidden />
								</Button>
							)}
						</li>
					);
				})}
				{suggesting && (
					<li
						className="flex items-center gap-[var(--space-2)] px-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]"
						role="status"
					>
						<LoaderCircle
							aria-hidden
							className="size-3 animate-spin motion-reduce:animate-none"
						/>
						Asking the AI…
					</li>
				)}
				{!group && !suggesting && (
					<li className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
						{range
							? "Type another wording and press Return."
							: `There is no ${current} at the caret.`}
					</li>
				)}
			</ul>
			<div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
				<Input
					autoFocus
					aria-label="Add a wording"
					placeholder="Add a wording"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							step(event.key === "ArrowDown" ? 1 : -1);
						} else if (event.key === "Escape") {
							event.preventDefault();
							alternatives.restore();
							alternatives.close();
						} else if (event.key === "Enter") {
							event.preventDefault();
							const text = draft.trim();
							if (text.length === 0) {
								alternatives.close();
							} else if (range) {
								setDraft("");
								alternatives.add(
									text,
									current,
									group
										? {
												from: group.location,
												to: group.location + group.length,
											}
										: range,
								);
							}
						}
					}}
				/>
				{suggest && (
					<Button
						size="sm"
						variant="outline"
						className="self-start"
						disabled={
							suggesting || !range || alternatives.previewShownId !== null
						}
						onClick={() => {
							if (!range) return;
							suggest(
								group
									? { from: group.location, to: group.location + group.length }
									: range,
								current,
							);
						}}
					>
						<Sparkle aria-hidden />
						Suggest with AI
					</Button>
				)}
				<p className="text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
					↑↓ compare in place · return adds or keeps · esc restores
				</p>
			</div>
		</aside>
	);
}
