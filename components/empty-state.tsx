import { Button } from "@/components/ui/button";

type EmptyStateProps = {
	onCreate: () => void;
	pending?: boolean;
};

export function EmptyState({ onCreate, pending }: EmptyStateProps) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-[var(--space-6)] py-[var(--space-8)] text-center">
			<h2
				className="text-[length:var(--text-display)] leading-[var(--leading-display)] text-[var(--color-ink-secondary)] text-balance"
				style={{ fontFamily: "var(--font-reading)" }}
			>
				Start writing.
			</h2>
			<p className="mt-[var(--space-4)] max-w-sm text-[length:var(--text-ui)] leading-[var(--leading-body)] text-[var(--color-ink-tertiary)] text-balance">
				Create your first document. Everything syncs when you pause typing.
			</p>
			<Button
				onClick={onCreate}
				disabled={pending}
				size="lg"
				className="mt-[var(--space-8)]"
			>
				{pending ? "Creating…" : "Create document"}
			</Button>
			<div
				className="mt-[var(--space-8)] flex flex-wrap items-center justify-center gap-x-[var(--space-5)] gap-y-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]"
				aria-hidden="true"
			>
				<span className="inline-flex items-center gap-[var(--space-2)]">
					<kbd className="recto-kbd">Enter</kbd>
					Create a new document
				</span>
				<span className="inline-flex items-center gap-[var(--space-2)]">
					<kbd className="recto-kbd">⌘ K</kbd>
					Open the command palette
				</span>
			</div>
		</div>
	);
}
