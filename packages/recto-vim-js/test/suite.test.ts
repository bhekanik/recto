import { describe, expect, test } from "bun:test";
import suite from "../fixtures/keystroke-suite.json";
import {
	loadBundle,
	parseKeys,
	type RectoVimApi,
	TestHost,
	type VimResult,
} from "./harness.ts";

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
};

/** Drive one fixture case and report where the buffer and caret ended up. */
function run(testCase: Case): { text: string; cursor: [number, number]; mode: string } {
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
	for (const testCase of suite.cases as Case[]) {
		test(testCase.name, () => {
			const result = run(testCase);
			expect(result.text).toBe(testCase.expectText);
			if (testCase.expectCursor) expect(result.cursor).toEqual(testCase.expectCursor);
			if (testCase.expectMode) expect(result.mode).toBe(testCase.expectMode);
		});
	}
});

test("suite is large enough to be evidence", () => {
	expect(suite.cases.length).toBeGreaterThanOrEqual(40);
});
