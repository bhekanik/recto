"use client";

import { useMutation, useQuery } from "convex/react";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type GranteeRole = "commenter" | "suggester";

const ROLE_OPTIONS: { value: GranteeRole; label: string; hint: string }[] = [
	{ value: "commenter", label: "Comment", hint: "Leave comments only" },
	{ value: "suggester", label: "Suggest", hint: "Comment + tracked changes" },
];

type ShareDialogProps = {
	documentId: Id<"documents"> | null;
	title: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/**
 * Manage-sharing modal (plan 010, Phase A): invite by email + role, list current
 * shares, revoke. Modeled on the rename modal in document-switcher.tsx; all
 * writes go through the owner-only Convex mutations. While a document is shared
 * its AI features are disabled (the cross-cutting no-AI-on-shared rule) — surfaced
 * here so the owner understands the trade-off.
 */
export function ShareDialog({
	documentId,
	title,
	open,
	onOpenChange,
}: ShareDialogProps) {
	const shares = useQuery(
		api.review.listShares,
		open && documentId ? { documentId } : "skip",
	);
	const addShare = useMutation(api.review.addShare);
	const revokeShare = useMutation(api.review.revokeShare);

	const [email, setEmail] = useState("");
	const [role, setRole] = useState<GranteeRole>("suggester");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const close = useCallback(() => onOpenChange(false), [onOpenChange]);

	// Reset transient state whenever the dialog is (re)opened for a document.
	useEffect(() => {
		if (open) {
			setEmail("");
			setRole("suggester");
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [open, close]);

	const handleInvite = useCallback(async () => {
		if (!documentId) return;
		const trimmed = email.trim();
		if (!trimmed) {
			setError("Enter an email address to invite.");
			return;
		}
		setPending(true);
		setError(null);
		try {
			await addShare({ documentId, email: trimmed, role });
			setEmail("");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setPending(false);
		}
	}, [addShare, documentId, email, role]);

	const handleRevoke = useCallback(
		async (shareId: Id<"documentShares">) => {
			setPending(true);
			try {
				await revokeShare({ shareId });
			} finally {
				setPending(false);
			}
		},
		[revokeShare],
	);

	if (!open || !documentId) return null;

	return (
		<div
			className="recto-scrim fixed inset-0 z-[110] flex items-center justify-center p-[var(--space-4)]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="recto-share-title"
		>
			<button
				type="button"
				className="absolute inset-0"
				aria-label="Close sharing dialog"
				onClick={close}
			/>
			<div className="recto-panel relative z-10 w-full max-w-md p-[var(--space-5)]">
				<h2
					id="recto-share-title"
					className="text-[length:var(--text-ui)] font-[var(--font-reading)] text-[var(--color-ink-primary)]"
				>
					Share “{title}”
				</h2>
				<p className="mt-[var(--space-1)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
					Invite someone by email. They get access once they sign in with that
					address. AI features are turned off for a shared document.
				</p>

				<div className="mt-[var(--space-4)] flex flex-col gap-[var(--space-3)]">
					<Input
						type="email"
						placeholder="name@example.com"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void handleInvite();
							}
						}}
						autoFocus
					/>

					<fieldset className="flex gap-[var(--space-2)] border-0 p-0">
						<legend className="sr-only">Access level</legend>
						{ROLE_OPTIONS.map((option) => {
							const selected = role === option.value;
							return (
								<label
									key={option.value}
									className={`flex-1 cursor-pointer rounded-[var(--radius-md)] border px-[var(--space-3)] py-[var(--space-2)] text-left transition-colors duration-[var(--motion-fast)] ${
										selected
											? "border-[var(--color-accent)] bg-[var(--color-accent-wash)]"
											: "border-[var(--color-line)] hover:bg-[var(--color-bg-hover)]"
									}`}
								>
									<input
										type="radio"
										name="share-role"
										value={option.value}
										checked={selected}
										onChange={() => setRole(option.value)}
										className="sr-only"
									/>
									<span className="block text-[length:var(--text-ui-sm)] text-[var(--color-ink-primary)]">
										{option.label}
									</span>
									<span className="block text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
										{option.hint}
									</span>
								</label>
							);
						})}
					</fieldset>

					<div className="flex justify-end">
						<Button disabled={pending} onClick={() => void handleInvite()}>
							Invite
						</Button>
					</div>

					{error && (
						<p className="text-[length:var(--text-ui-sm)] text-[var(--color-danger)]">
							{error}
						</p>
					)}
				</div>

				<div className="mt-[var(--space-5)]">
					<h3 className="text-[length:var(--text-ui-sm)] font-medium uppercase tracking-[0.08em] text-[var(--color-ink-tertiary)]">
						People with access
					</h3>
					<ul className="mt-[var(--space-2)] flex flex-col gap-[var(--space-1)]">
						{shares === undefined && (
							<li className="px-[var(--space-1)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
								Loading…
							</li>
						)}
						{shares && shares.length === 0 && (
							<li className="px-[var(--space-1)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
								Not shared with anyone yet.
							</li>
						)}
						{shares?.map((share) => (
							<li
								key={share._id}
								className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-sm)] px-[var(--space-2)] py-[var(--space-1)] hover:bg-[var(--color-bg-hover)]"
							>
								<div className="min-w-0 flex-1">
									<span className="block truncate text-[length:var(--text-ui-sm)] text-[var(--color-ink-primary)]">
										{share.granteeEmail}
									</span>
									<span className="block text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
										{share.role === "suggester" ? "Suggest" : "Comment"}
										{share.granteeUserId ? " · active" : " · invited"}
									</span>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={pending}
									className="size-7 px-0 text-[var(--color-ink-tertiary)] hover:text-[var(--color-danger)]"
									onClick={() => void handleRevoke(share._id)}
									aria-label={`Revoke access for ${share.granteeEmail}`}
								>
									<Trash2 aria-hidden className="size-3.5" />
								</Button>
							</li>
						))}
					</ul>
				</div>

				<div className="mt-[var(--space-5)] flex justify-end">
					<Button variant="ghost" onClick={close}>
						Done
					</Button>
				</div>
			</div>
		</div>
	);
}
