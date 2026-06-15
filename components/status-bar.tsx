import type { SyncStatus } from "@/lib/sync/use-document-sync";

type StatusBarProps = {
	wordCount: number;
	modeLabel?: string;
	syncStatus: SyncStatus;
};

function formatWordCount(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "word" : "words"}`;
}

function SyncIndicator({ status }: { status: SyncStatus }) {
	switch (status) {
		case "saving":
			return (
				<span className="text-[var(--color-ink-tertiary)] animate-pulse">
					Saving…
				</span>
			);
		case "saved":
			return <span className="text-[var(--color-success)]">Saved ✓</span>;
		case "unsynced":
			return <span className="text-[var(--color-warning)]">Unsynced</span>;
		default:
			return null;
	}
}

export function StatusBar({
	wordCount,
	modeLabel = "Rich text",
	syncStatus,
}: StatusBarProps) {
	return (
		<footer
			className="flex h-7 shrink-0 items-center justify-between border-t border-[var(--color-line)] bg-[var(--color-bg-raised)] px-[var(--space-4)] text-[length:var(--text-ui-sm)] leading-[var(--leading-ui-sm)]"
			role="status"
			aria-live="polite"
		>
			<span className="text-[var(--color-ink-secondary)]">{modeLabel}</span>
			<div className="flex items-center gap-[var(--space-4)]">
				<span className="text-[var(--color-ink-tertiary)]">
					{formatWordCount(wordCount)}
				</span>
				<SyncIndicator status={syncStatus} />
			</div>
		</footer>
	);
}
