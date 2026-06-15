import { Button } from "@/components/ui/button";

type EmptyStateProps = {
	onCreate: () => void;
	pending?: boolean;
};

export function EmptyState({ onCreate, pending }: EmptyStateProps) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-[var(--space-6)] py-[var(--space-8)] text-center">
			<h2 className="text-[length:var(--text-h2)] leading-[var(--leading-h2)] font-semibold text-[var(--color-ink-secondary)]">
				Start writing
			</h2>
			<p className="mt-[var(--space-3)] max-w-md text-[length:var(--text-ui)] text-muted-foreground">
				Create your first document. Everything syncs to the cloud when you pause
				typing.
			</p>
			<Button
				onClick={onCreate}
				disabled={pending}
				className="mt-[var(--space-6)]"
			>
				{pending ? "Creating…" : "Create document"}
			</Button>
		</div>
	);
}
