/** A rule family the writer can toggle independently (A/B/granular fork). */
export type LintCategory = "passive" | "readability" | "adverb" | "weasel";

/** One highlightable issue, as a char range into the canonical-markdown BODY. */
export type LintIssue = {
	/** 0-indexed start offset into the analyzed text (= canonical markdown body). */
	from: number;
	/** 0-indexed end offset (exclusive). */
	to: number;
	category: LintCategory;
	/** Short human reason, e.g. "passive voice" / "hard to read" / "weasel word". */
	message: string;
	/**
	 * The exact substring `source.slice(from, to)`. CodeMirror maps issues by
	 * numeric offset (its doc string IS the source), but Milkdown/ProseMirror
	 * positions are tree positions, not source offsets — its decoration plugin
	 * re-derives the range by searching the document text for this string.
	 */
	text: string;
};

/** Which categories are active. All true = analyze everything. */
export type LintOptions = Record<LintCategory, boolean>;

export const ALL_CATEGORIES: readonly LintCategory[] = [
	"passive",
	"readability",
	"adverb",
	"weasel",
];
