/** Overflow accepts up to 64 KiB of UTF-8, as the server and the Mac do. */
export const MAX_OVERFLOW_BYTES = 64 * 1024;

export function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Notes with `passage` added at the end after a blank line, the run the Mac
 * appends when it stashes (`OverflowMoves.appendRun`).
 */
export function appendToNotes(notes: string, passage: string): string {
	const separator =
		notes.length === 0 || notes.endsWith("\n\n")
			? ""
			: notes.endsWith("\n")
				? "\n"
				: "\n\n";
	return notes + separator + passage;
}

/** `notes` without `text` at `from`, or null when it is no longer there exactly. */
export function removeFromNotes(
	notes: string,
	from: number,
	text: string,
): string | null {
	if (from < 0 || notes.slice(from, from + text.length) !== text) return null;
	return notes.slice(0, from) + notes.slice(from + text.length);
}
