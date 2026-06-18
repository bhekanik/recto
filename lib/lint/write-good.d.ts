declare module "write-good" {
	type WriteGoodSuggestion = {
		/** 0-indexed start offset into the analyzed text. */
		index: number;
		/** Length of the flagged span. */
		offset: number;
		/** Human-readable reason, e.g. `"quickly" can weaken meaning`. */
		reason: string;
	};
	type WriteGoodOptions = {
		passive?: boolean;
		weasel?: boolean;
		illusion?: boolean;
		so?: boolean;
		thereIs?: boolean;
		adverb?: boolean;
		tooWordy?: boolean;
		cliches?: boolean;
		eprime?: boolean;
		whitelist?: string[];
		// biome-ignore lint/suspicious/noExplicitAny: write-good's custom-checks shape is untyped upstream
		checks?: Record<string, any>;
	};
	export default function writeGood(
		text: string,
		opts?: WriteGoodOptions,
	): WriteGoodSuggestion[];
}
