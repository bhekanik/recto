import { parseMarkdown } from "./parse";
import { stringifyMdast } from "./serialize";

/** Round-trip through the canonical pipeline. */
export function normalizeMarkdown(markdown: string): string {
	return stringifyMdast(parseMarkdown(markdown));
}
