import { expect, test } from "bun:test";

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

function press(keys: string, host: TestHost): VimResult {
	let last: VimResult = JSON.parse(api.getState());
	for (const { key, mods } of parseKeys(keys)) {
		host.beginKey();
		last = JSON.parse(api.handleKey(key, mods));
		host.endKey(last);
	}
	return last;
}

function start(text: string, line = 0, column = 0) {
	const host = new TestHost(api);
	api.init(text, host);
	api.setCursor(line, column);
	return host;
}

/**
 * Session behaviour that is not a keystroke fixture: the pending-command
 * display, what happens when the host swaps the buffer mid-command, and the
 * external-input path the native adapters use instead of synthesising typed
 * characters from key names.
 */

test("pending shows a half-typed command and clears when it completes", () => {
	const host = start("the quick brown fox\n");
	expect(press("3", host).pending).toBe("3");
	expect(press("d", host).pending).toBe("3d");
	// Upstream clears the accumulator on `vim-command-done`; without subscribing
	// to it, `pending` grew for the lifetime of the session.
	expect(press("w", host).pending).toBe("");
	expect(api.getText()).toBe("fox\n");
});

test("pending clears on a mode change", () => {
	const host = start("one\n");
	press("i", host);
	expect(JSON.parse(api.getState()).pending).toBe("");
	const escaped = press("<Esc>", host);
	expect(escaped.pending).toBe("");
});

test("an external sync cancels a pending operator", () => {
	// Type `d`, sync a new buffer in, then type `w`. Before the cancellation the
	// stale operator completed against the new text and deleted "alpha ".
	const host = start("the quick brown fox\n");
	press("d", host);
	api.setText("alpha beta\n", 0, 0);
	press("w", host);
	expect(api.getText()).toBe("alpha beta\n");
});

test("an external sync leaves visual mode", () => {
	const host = start("one two three\n");
	press("vll", host);
	const synced: VimResult = JSON.parse(api.setText("alpha beta\n", 0, 0));
	expect(synced.visualMode).toBe(false);
	expect(synced.mode).toBe("normal");
	press("d", host);
	// `d` with no pending visual selection is an operator waiting for a motion,
	// so the buffer must be untouched.
	expect(api.getText()).toBe("alpha beta\n");
});

test("an external sync leaves insert mode and does not echo its edits", () => {
	const host = start("one\n");
	press("iXY", host);
	expect(api.getText()).toBe("XYone\n");
	const synced: VimResult = JSON.parse(api.setText("fresh\n", 0, 0));
	expect(synced.insertMode).toBe(false);
	expect(synced.resynced).toBe(true);
	// The host already has this text; replaying anything would double-apply.
	expect(synced.edits).toEqual([]);
	expect(api.getText()).toBe("fresh\n");
});

test("an external sync closes an open ex line", () => {
	const host = start("one\n");
	press(":", host);
	expect(JSON.parse(api.getState()).prompt).not.toBeNull();
	const synced: VimResult = JSON.parse(api.setText("two\n", 0, 0));
	expect(synced.prompt).toBeNull();
});

test("external input inserts what the host's input system produced", () => {
	const host = start("ab\n");
	api.setExternalInput(true);
	press("i", host);
	// The key is declined, so the text view's input system owns it and hands the
	// text back — which is the only way NFD, emoji and IME survive.
	const declined = press("X", host);
	expect(declined.handled).toBe(false);
	expect(api.getText()).toBe("ab\n");

	const inserted: VimResult = JSON.parse(api.insertText("X"));
	expect(inserted.handled).toBe(true);
	expect(inserted.edits).toEqual([{ from: 0, to: 0, insert: "X" }]);
	expect(api.getText()).toBe("Xab\n");
	api.setExternalInput(false);
});

test("external input carries combining marks and emoji whole", () => {
	const host = start("ab\n");
	api.setExternalInput(true);
	press("i", host);
	// NFD: a `keyDown` would report only the base letter and drop the mark.
	api.insertText("é");
	api.insertText("\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}");
	expect(api.getText()).toBe("é\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}ab\n");
	api.setExternalInput(false);
});

test("external input replaces a marked-text range", () => {
	// IME composition: the host commits over the range it was showing.
	const host = start("abc\n");
	api.setExternalInput(true);
	press("i", host);
	api.insertText("nihon", 0, 0);
	expect(api.getText()).toBe("nihonabc\n");
	const committed: VimResult = JSON.parse(api.insertText("日本", 0, 5));
	expect(committed.edits).toEqual([{ from: 0, to: 5, insert: "日本" }]);
	expect(api.getText()).toBe("日本abc\n");
	api.setExternalInput(false);
});

test("dot repeats an insert that came through external input", () => {
	const host = start("ab\n");
	api.setExternalInput(true);
	press("i", host);
	api.insertText("XY");
	press("<Esc>", host);
	expect(api.getText()).toBe("XYab\n");
	// The core only learns what was typed by watching the change, which is why
	// `insertText` goes through `operation()` rather than straight to the mirror.
	// `$` lands on the `b` and the repeated command was `i`, which inserts
	// *before* the cursor.
	press("$.", host);
	expect(api.getText()).toBe("XYaXYb\n");
	api.setExternalInput(false);
});

test("external input is off by default so the suites keep driving keys", () => {
	const host = start("ab\n");
	press("iX", host);
	expect(api.getText()).toBe("Xab\n");
});
