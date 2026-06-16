"use client";

import { SELECTION_ACTIONS } from "@/components/format-actions";
import { dispatchFormat } from "@/lib/editor/format";

/**
 * The floating action bar shown above a non-empty selection in rich mode.
 * Buttons preventDefault on pointer-down so the editor keeps focus + selection
 * (the tooltip provider then keeps the bar visible while the command applies).
 */
export function SelectionToolbar() {
	return (
		<div
			role="toolbar"
			aria-label="Formatting"
			className="flex items-center gap-px"
		>
			{SELECTION_ACTIONS.map((action) => {
				const Icon = action.icon;
				return (
					<button
						key={action.command}
						type="button"
						title={action.label}
						aria-label={action.label}
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => dispatchFormat(action.command)}
						className="flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-secondary)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-ink-primary)]"
					>
						<Icon aria-hidden className="size-[15px]" />
					</button>
				);
			})}
		</div>
	);
}
