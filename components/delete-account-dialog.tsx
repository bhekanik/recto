"use client";

import { useAction } from "convex/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";

/** What the writer has to type. Not "yes" — it must be hard to type by reflex. */
const CONFIRMATION_PHRASE = "delete my account";

/**
 * Convex wraps a thrown server error in transport noise —
 * `[CONVEX A(account:deleteEverything)] [Request ID: …] Server Error Uncaught
 * Error: <the message> at handler (…)`. The action's messages are written to
 * be read by the person deleting their account, so dig the real one out.
 */
function readableError(caught: unknown): string {
	const fallback = "Deleting the account failed. Try again.";
	if (!(caught instanceof Error)) return fallback;
	const afterPrefix = caught.message.split("Uncaught Error: ").pop();
	const message = (afterPrefix ?? caught.message).split("\n")[0]?.trim();
	return message || fallback;
}

type DeleteAccountDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called once the account is gone, to send the browser somewhere. */
	onDeleted: () => void;
};

/**
 * Permanent account deletion (App Store guideline 5.1.1(v), which the native
 * apps must satisfy and which reuses this same `account.deleteEverything`
 * action).
 *
 * Deliberately unlike every other dialog in the studio: a typed confirmation
 * rather than a button, an explicit list of what goes, and no "are you sure?"
 * second step — one accurate warning the writer has to read in order to type
 * the phrase beats two dismissible ones.
 *
 * Modeled on the share dialog (plan 010) so the chrome, escape handling and
 * focus behaviour match.
 */
export function DeleteAccountDialog({
	open,
	onOpenChange,
	onDeleted,
}: DeleteAccountDialogProps) {
	const deleteEverything = useAction(api.account.deleteEverything);

	const [phrase, setPhrase] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const close = useCallback(() => onOpenChange(false), [onOpenChange]);

	useEffect(() => {
		if (open) {
			setPhrase("");
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				// Escape must not cancel a delete already in flight; the account is
				// half gone and closing the dialog would just hide that.
				if (!pending) close();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [open, close, pending]);

	const confirmed = phrase.trim().toLowerCase() === CONFIRMATION_PHRASE;

	const handleDelete = useCallback(async () => {
		if (!confirmed || pending) return;
		setPending(true);
		setError(null);
		try {
			await deleteEverything({});
			onDeleted();
		} catch (caught) {
			// The action is idempotent, so its messages say what to do next rather
			// than leaving the writer wondering how much was deleted.
			setError(readableError(caught));
			setPending(false);
		}
	}, [confirmed, pending, deleteEverything, onDeleted]);

	if (!open) return null;

	return (
		<div
			className="recto-scrim fixed inset-0 z-[110] flex items-center justify-center p-[var(--space-4)]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="recto-delete-account-title"
		>
			<button
				type="button"
				className="absolute inset-0"
				aria-label="Close delete account dialog"
				disabled={pending}
				onClick={close}
			/>
			<div className="recto-panel relative z-10 w-full max-w-md p-[var(--space-5)]">
				<h2
					id="recto-delete-account-title"
					className="text-[length:var(--text-ui)] font-[var(--font-reading)] text-[var(--color-ink-primary)]"
				>
					Delete account
				</h2>

				<p className="mt-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]">
					This deletes every document and its full edit history, your versions,
					comments and suggestions, uploaded images, writing stats, settings and
					saved layouts — then deletes your sign-in itself. It cannot be undone
					and there is no export step afterwards.
				</p>

				<label
					htmlFor="delete-account-phrase"
					className="mt-[var(--space-5)] block text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]"
				>
					Type <strong className="font-semibold">{CONFIRMATION_PHRASE}</strong>{" "}
					to confirm.
				</label>
				<Input
					id="delete-account-phrase"
					value={phrase}
					disabled={pending}
					autoComplete="off"
					autoFocus
					onChange={(event) => setPhrase(event.target.value)}
					className="mt-[var(--space-2)]"
				/>

				{error && (
					<p
						role="alert"
						className="mt-[var(--space-3)] text-[length:var(--text-ui-sm)] text-[var(--color-danger)]"
					>
						{error}
					</p>
				)}

				<div className="mt-[var(--space-5)] flex justify-end gap-[var(--space-2)]">
					<Button variant="ghost" disabled={pending} onClick={close}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						disabled={!confirmed || pending}
						onClick={() => void handleDelete()}
					>
						{pending ? "Deleting…" : "Delete everything"}
					</Button>
				</div>
			</div>
		</div>
	);
}
