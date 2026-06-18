/** Average adult reading speed for prose (words per minute). Industry default. */
export const WORDS_PER_MINUTE = 200;

/**
 * Reading time in whole minutes for a given word count, rounded up, min 1 when
 * there is any text (so a 30-word note reads "1 min", not "0 min"). 0 words → 0.
 */
export function readingTimeMinutes(
	wordCount: number,
	wpm = WORDS_PER_MINUTE,
): number {
	if (wordCount <= 0 || wpm <= 0) return 0;
	return Math.max(1, Math.ceil(wordCount / wpm));
}

/** Compact label, e.g. "0 min" | "1 min" | "12 min". */
export function formatReadingTime(minutes: number): string {
	return `${minutes} min`;
}
