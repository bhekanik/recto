import { visit } from "unist-util-visit";
import { normalizeMarkdown } from "../normalize";
import { parseMarkdown } from "../parse";
import { stringifyMdast } from "../serialize";

/** Extract yaml frontmatter body bytes from parsed tree. */
export function extractYamlValue(markdown: string): string | null {
	const tree = parseMarkdown(markdown);
	let value: string | null = null;
	visit(tree, "yaml", (node) => {
		if ("value" in node && typeof node.value === "string") {
			value = node.value;
		}
	});
	return value;
}

/** Run assertions 1–4 for a single corpus input. */
export function assertCorpusPipeline(
	input: string,
	checkFrontmatter?: boolean,
): void {
	const once = normalizeMarkdown(input);
	const twice = normalizeMarkdown(once);
	const parsed = parseMarkdown(input);
	const serialized = stringifyMdast(parsed);
	const reparsed = parseMarkdown(serialized);
	const reserialized = stringifyMdast(reparsed);

	if (twice !== once) {
		throw new Error("Assertion 1 failed: idempotence");
	}
	if (serialized !== once) {
		throw new Error("Assertion 2 failed: round-trip equality");
	}
	if (reserialized !== serialized) {
		throw new Error("Assertion 3 failed: second-pass stability");
	}

	if (checkFrontmatter) {
		const inYaml = extractYamlValue(input);
		const outYaml = extractYamlValue(once);
		if (inYaml !== outYaml) {
			throw new Error("Assertion 4 failed: yaml.value not byte-exact");
		}
	}
}

/** CM6 surface: raw text → parse → serialize. */
export function cm6SurfaceConverge(normalized: string): string {
	return normalizeMarkdown(normalized);
}

/** Milkdown surface proxy: normalize after parse (same as canonical for text path). */
export function milkdownSurfaceConverge(normalized: string): string {
	return normalizeMarkdown(normalized);
}

/** Assertion 5: both surfaces yield same bytes from normalized form. */
export function assertCrossSurfaceConvergence(normalized: string): void {
	const fromCm = cm6SurfaceConverge(normalized);
	const fromMd = milkdownSurfaceConverge(normalized);
	if (fromCm !== fromMd) {
		throw new Error("Assertion 5 failed: cross-surface convergence");
	}
}

export function assertFullCorpusCase(
	input: string,
	checkFrontmatter?: boolean,
): void {
	assertCorpusPipeline(input, checkFrontmatter);
	const normalized = normalizeMarkdown(input);
	assertCrossSurfaceConvergence(normalized);
}
