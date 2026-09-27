import { CodeXml } from "lucide-react";

import { SOURCE_REPOSITORY_URL } from "@/lib/project-links";

/** One quiet line under the sign-in form: Recto is open source, and where. */
export function SourceLinkNote() {
	return (
		<p className="flex items-center gap-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
			<CodeXml aria-hidden className="size-4 shrink-0" />
			<span>
				Open source.{" "}
				<a
					href={SOURCE_REPOSITORY_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="text-[var(--color-ink-secondary)] underline decoration-[var(--color-line-strong)] underline-offset-4 transition-colors hover:text-[var(--color-ink-primary)] hover:decoration-current"
				>
					View on GitHub
				</a>
			</span>
		</p>
	);
}
