import { describe, expect, test } from "bun:test";
import suite from "../fixtures/keystroke-suite.json";
import {
	loadBundle,
	parseKeys,
	type RectoVimApi,
	TestHost,
	type VimResult,
} from "./harness";

const api: RectoVimApi = await loadBundle(
	`${import.meta.dir}/../dist/recto-vim.js`,
);

type Case = {
	name: string;
	text: string;
	cursor: [number, number];
	keys: string;
	expectText: string;
	expectCursor?: [number, number];
	expectMode?: string;
	/** Why an expectation diverges from real vim, where one does. */
	note?: string;
};

type CaseOutcome = { text: string; cursor: [number, number]; mode: string };

/** Drive one fixture case and report where the buffer and caret ended up. */
function run(testCase: Case): CaseOutcome {
	const host = new TestHost(api);
	api.init(testCase.text, host);
	api.setCursor(testCase.cursor[0], testCase.cursor[1]);

	let last: VimResult = JSON.parse(api.getState());
	for (const { key, mods } of parseKeys(testCase.keys)) {
		host.beginKey();
		last = JSON.parse(api.handleKey(key, mods));
		host.endKey(last);
	}

	const text = api.getText();
	const head = last.selections[last.mainIndex]?.head ?? 0;
	return { text, cursor: offsetToPos(text, head), mode: last.mode };
}

function offsetToPos(text: string, offset: number): [number, number] {
	const before = text.slice(0, offset);
	const line = before.split("\n").length - 1;
	const ch = offset - (before.lastIndexOf("\n") + 1);
	return [line, ch];
}

describe("keystroke suite", () => {
	// SAFETY: the fixture is imported as JSON, so TypeScript infers a wider shape
	// than the file actually holds; `Case` is the contract the Swift suite decodes
	// the same file into, and a mismatch there fails that suite.
	for (const testCase of suite.cases as Case[]) {
		test(testCase.name, () => {
			const result = run(testCase);
			expect(result.text).toBe(testCase.expectText);
			if (testCase.expectCursor)
				expect(result.cursor).toEqual(testCase.expectCursor);
			if (testCase.expectMode) expect(result.mode).toBe(testCase.expectMode);
		});
	}
});

test("suite is large enough to be evidence", () => {
	expect(suite.cases.length).toBeGreaterThanOrEqual(100);
});

test("every case name is unique", () => {
	// The Swift suite reports failures by name, and a duplicate would make one of
	// them unfindable.
	const names = new Set(suite.cases.map((c) => c.name));
	expect(names.size).toBe(suite.cases.length);
});

test("grapheme clusters are covered by more than one case", () => {
	// The clamping in src/grapheme.js is the acceptance criterion the N0c spike
	// flagged; a suite that quietly lost those cases would still be green.
	const multiCodepoint =
		/\p{Emoji_Modifier}|\u200d|\p{Regional_Indicator}|\p{Mn}/u;
	const cases = (suite.cases as Case[]).filter((c) =>
		multiCodepoint.test(c.text),
	);
	expect(cases.length).toBeGreaterThanOrEqual(15);
});
