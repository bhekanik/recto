import type { Flag } from "@/lib/markdown/flags";
import type { OutlineHeading } from "@/lib/outline/extract";

/**
 * Indexes of the headings whose section holds an open flag. A section runs
 * from its heading to the next heading of any depth, so a flag marks the
 * nearest heading above it; flags before the first heading mark none.
 */
export function headingsWithFlags(
	outline: OutlineHeading[],
	flags: Flag[],
): Set<number> {
	const flagged = new Set<number>();
	for (const flag of flags) {
		let owner: OutlineHeading | undefined;
		for (const heading of outline) {
			if (heading.offset > flag.from) break;
			owner = heading;
		}
		if (owner) flagged.add(owner.index);
	}
	return flagged;
}
