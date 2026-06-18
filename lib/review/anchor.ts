/**
 * Pure comment-anchoring (plan 010, Phase B). A comment stores a quoted substring
 * of the canonical Markdown plus a little surrounding context, NOT a bare offset —
 * so it survives the owner editing the text around (or inside) the quote, and so
 * the SAME locator works whether the quote came from a human selection or an
 * AI-supplied exact quote (cross-cutting rule c, plan 011).
 *
 * No fuzzy-match dependency: a small scoring loop matches the codebase's "pure
 * small helpers" style (cf. lib/editor/milkdown/lint-plugin.ts findSpan/cleanFragments).
 *
 * The load-bearing contract: NEVER mis-anchor. When the quote can't be relocated
 * with confidence, return `null` (the comment becomes "orphaned" — it still renders
 * in the panel marked "anchor lost", but draws no highlight; it is never deleted).
 */

/** Stored anchor: the quote, a context window, and a (non-authoritative) hint. */
export type CommentAnchor = {
	/** Exact quoted substring of the canonical Markdown at anchor time. */
	quote: string;
	/** Up to {@link CONTEXT_LEN} chars immediately before the quote. */
	prefix: string;
	/** Up to {@link CONTEXT_LEN} chars immediately after the quote. */
	suffix: string;
	/** Original `from` offset — a tie-breaker only, never authoritative. */
	offsetHint: number;
};

/** A located range in the current canonical Markdown. */
export type AnchorRange = { from: number; to: number };

/** Context window captured on each side of the quote (disambiguator). */
export const CONTEXT_LEN = 32;

/** Cap stored quote length so a huge selection doesn't bloat the row. */
export const MAX_QUOTE_LEN = 200;

/**
 * Minimum normalized score (0–1) the fuzzy fallback must clear to relocate an
 * edited quote. Below this we orphan rather than risk mis-anchoring.
 */
const FUZZY_MIN_SCORE = 0.5;

/** Word characters used to grow an empty selection out to the enclosing word. */
const WORD_RE = /[\p{L}\p{N}_]/u;

/**
 * Capture a {@link CommentAnchor} for the range `[from, to)` of `markdown`. When
 * the selection is empty (`from === to`), the anchor grows to the enclosing word
 * (or, if not on a word, falls back to the bare caret with an empty quote — the
 * caller should generally require a non-empty selection, but this stays total).
 */
export function createAnchor(
	markdown: string,
	from: number,
	to: number,
): CommentAnchor {
	let start = Math.max(0, Math.min(from, markdown.length));
	let end = Math.max(0, Math.min(to, markdown.length));
	if (start > end) [start, end] = [end, start];

	// Empty selection → grow to the enclosing word so the anchor has a quote.
	if (start === end) {
		let wordStart = start;
		let wordEnd = end;
		while (wordStart > 0 && WORD_RE.test(markdown[wordStart - 1] ?? "")) {
			wordStart--;
		}
		while (wordEnd < markdown.length && WORD_RE.test(markdown[wordEnd] ?? "")) {
			wordEnd++;
		}
		start = wordStart;
		end = wordEnd;
	}

	let quote = markdown.slice(start, end);
	// Cap the quote; keep the leading slice (where prefix/suffix still bracket it).
	if (quote.length > MAX_QUOTE_LEN) {
		quote = quote.slice(0, MAX_QUOTE_LEN);
		end = start + MAX_QUOTE_LEN;
	}

	return {
		quote,
		prefix: markdown.slice(Math.max(0, start - CONTEXT_LEN), start),
		suffix: markdown.slice(end, Math.min(markdown.length, end + CONTEXT_LEN)),
		offsetHint: start,
	};
}

/** Every index where `needle` occurs in `haystack` (overlapping not needed here). */
function allOccurrences(haystack: string, needle: string): number[] {
	if (!needle) return [];
	const hits: number[] = [];
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		hits.push(i);
		i = haystack.indexOf(needle, i + 1);
	}
	return hits;
}

/** Length of the common suffix of `a` and `b` (for prefix-context matching). */
function commonSuffixLen(a: string, b: string): number {
	let n = 0;
	while (
		n < a.length &&
		n < b.length &&
		a[a.length - 1 - n] === b[b.length - 1 - n]
	) {
		n++;
	}
	return n;
}

/** Length of the common prefix of `a` and `b` (for suffix-context matching). */
function commonPrefixLen(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/**
 * Score how well the context around a candidate occurrence (at `start`, of length
 * `len`) matches the stored prefix/suffix. Returns a count of matching context
 * chars (the more surrounding text lines up, the higher) — used to disambiguate
 * repeated quotes.
 */
function contextScore(
	markdown: string,
	start: number,
	len: number,
	anchor: CommentAnchor,
): number {
	const before = markdown.slice(Math.max(0, start - CONTEXT_LEN), start);
	const after = markdown.slice(start + len, start + len + CONTEXT_LEN);
	return (
		commonSuffixLen(before, anchor.prefix) +
		commonPrefixLen(after, anchor.suffix)
	);
}

/** Normalize for fuzzy comparison: collapse whitespace, lowercase. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Dice coefficient over character bigrams — cheap, dependency-free fuzzy score. */
function diceCoefficient(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const bigrams = new Map<string, number>();
	for (let i = 0; i < a.length - 1; i++) {
		const bg = a.slice(i, i + 2);
		bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
	}
	let intersection = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const bg = b.slice(i, i + 2);
		const count = bigrams.get(bg) ?? 0;
		if (count > 0) {
			bigrams.set(bg, count - 1);
			intersection++;
		}
	}
	return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/**
 * Locate a comment's anchor in the CURRENT canonical Markdown.
 *
 * 1. **Exact unique** — the quote occurs exactly once → that range.
 * 2. **Context-disambiguated** — the quote occurs more than once → the occurrence
 *    whose surrounding text best matches prefix+suffix; ties break by proximity to
 *    `offsetHint`.
 * 3. **Fuzzy fallback** — the quote isn't found verbatim (it was edited) → search a
 *    window around `offsetHint` for the best normalized near-match of the quote; if
 *    no candidate clears {@link FUZZY_MIN_SCORE}, return `null`.
 * 4. Returns `null` only when nothing reasonable is found (the orphan path).
 */
export function locateAnchor(
	markdown: string,
	anchor: CommentAnchor,
): AnchorRange | null {
	const { quote } = anchor;
	if (!quote) return null;

	const occurrences = allOccurrences(markdown, quote);

	if (occurrences.length === 1) {
		const start = occurrences[0] as number;
		return { from: start, to: start + quote.length };
	}

	if (occurrences.length > 1) {
		let best = occurrences[0] as number;
		let bestScore = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const start of occurrences) {
			const score = contextScore(markdown, start, quote.length, anchor);
			const distance = Math.abs(start - anchor.offsetHint);
			if (
				score > bestScore ||
				(score === bestScore && distance < bestDistance)
			) {
				best = start;
				bestScore = score;
				bestDistance = distance;
			}
		}
		return { from: best, to: best + quote.length };
	}

	// Fuzzy fallback: the quoted text itself was edited. Slide a window of the
	// quote's length across a region around the hint and keep the best near-match.
	return fuzzyLocate(markdown, anchor);
}

function fuzzyLocate(
	markdown: string,
	anchor: CommentAnchor,
): AnchorRange | null {
	const { quote, offsetHint } = anchor;
	if (markdown.length === 0) return null;

	const normQuote = normalize(quote);
	if (!normQuote) return null;

	const windowLen = quote.length;
	// Search a generous region around the hint (the quote may have grown/shrunk and
	// the surrounding text may have shifted), clamped to the document.
	const slack = Math.max(windowLen * 2, CONTEXT_LEN * 2, 64);
	const regionStart = Math.max(0, offsetHint - slack);
	const regionEnd = Math.min(markdown.length, offsetHint + windowLen + slack);

	let bestStart = -1;
	let bestEnd = -1;
	let bestScore = 0;
	// Coarse step keeps this cheap on large docs; the window length itself is the
	// resolution that matters for a bigram score.
	const step = windowLen > 24 ? 2 : 1;
	for (let start = regionStart; start + 1 <= regionEnd; start += step) {
		// Try a couple of candidate window lengths so a slight edit in length still
		// scores well (the quote may have gained/lost a few chars).
		for (const len of candidateLengths(windowLen)) {
			const end = Math.min(markdown.length, start + len);
			if (end <= start) continue;
			const candidate = normalize(markdown.slice(start, end));
			if (!candidate) continue;
			const score = diceCoefficient(normQuote, candidate);
			if (score > bestScore) {
				bestScore = score;
				bestStart = start;
				bestEnd = end;
			}
			if (end >= markdown.length) break;
		}
	}

	if (bestStart === -1 || bestScore < FUZZY_MIN_SCORE) return null;
	return { from: bestStart, to: bestEnd };
}

/** A few window lengths around the quote length for the fuzzy slide. */
function candidateLengths(base: number): number[] {
	if (base <= 4) return [base];
	const delta = Math.max(2, Math.round(base * 0.15));
	return [base, base - delta, base + delta].filter((n) => n > 0);
}
