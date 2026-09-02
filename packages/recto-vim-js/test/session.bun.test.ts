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

/* -- the host's own caret and text changes ------------------------------- */

test("a cursor handoff keeps insert mode and moves the engine", () => {
	// Through a real NSTextView an insert-mode `<Left>` is declined to AppKit,
	// which moves the selection and left the engine two units behind: the next
	// character then landed at the engine's offset (`abctail`, not `acbtail`).
	const host = start("tail\n");
	api.setExternalInput(true);
	press("i", host);
	api.insertText("a");
	api.insertText("b");
	expect(api.getText()).toBe("abtail\n");

	const moved: VimResult = JSON.parse(api.moveCursorFromHost(1, 1));
	expect(moved.insertMode).toBe(true);
	expect(moved.mode).toBe("insert");
	expect(moved.selections[moved.mainIndex]).toEqual({ anchor: 1, head: 1 });
	// Vim starts a new undo block at a cursor key.
	expect(moved.undoBreak).toBe(true);

	api.insertText("c");
	expect(api.getText()).toBe("acbtail\n");
	api.setExternalInput(false);
});

test("a cursor handoff in normal mode does not ask for an undo break", () => {
	const host = start("one two\n");
	const moved: VimResult = JSON.parse(api.moveCursorFromHost(4, 4));
	expect(moved.insertMode).toBe(false);
	expect(moved.undoBreak).toBe(false);
	press("x", host);
	expect(api.getText()).toBe("one wo\n");
});

test("a cursor handoff clamps to the document", () => {
	start("ab\n");
	const moved: VimResult = JSON.parse(api.moveCursorFromHost(99, 99));
	expect(moved.selections[moved.mainIndex]).toEqual({ anchor: 3, head: 3 });
});

test("a mouse selection through the handoff enters visual mode", () => {
	// The core's own `handleExternalSelection` does this on the web; it only runs
	// because the handoff signals cursor activity outside a vim operation.
	start("one two three\n");
	const dragged: VimResult = JSON.parse(api.moveCursorFromHost(0, 3));
	expect(dragged.visualMode).toBe(true);
	expect(dragged.mode).toBe("visual");
});

test("dot repeats only what was typed after a cursor handoff", () => {
	// Stock vim: an arrow key ends the recorded insert, so `.` replays the tail.
	const host = start("xy\n");
	api.setExternalInput(true);
	press("i", host);
	api.insertText("a");
	api.moveCursorFromHost(1, 1);
	api.insertText("b");
	press("<Esc>", host);
	expect(api.getText()).toBe("abxy\n");
	press("$.", host);
	expect(api.getText()).toBe("abxby\n");
	api.setExternalInput(false);
});

test("<C-g>U suppresses the undo break for exactly one movement", () => {
	const host = start("tail\n");
	api.setExternalInput(true);
	press("i", host);
	api.insertText("a");

	// Both keys are swallowed: neither may reach the buffer as text.
	const prefix = press("<C-g>", host);
	expect(prefix.handled).toBe(true);
	const join = press("U", host);
	expect(join.handled).toBe(true);
	expect(api.getText()).toBe("atail\n");

	expect(JSON.parse(api.moveCursorFromHost(0, 0)).undoBreak).toBe(false);
	// One movement only.
	expect(JSON.parse(api.moveCursorFromHost(1, 1)).undoBreak).toBe(true);
	api.setExternalInput(false);
});

test("<C-g> followed by anything else runs that key normally", () => {
	const host = start("tail\n");
	api.setExternalInput(true);
	press("i", host);
	press("<C-g>", host);
	// `<Esc>` after the swallowed prefix still leaves insert mode.
	const escaped = press("<Esc>", host);
	expect(escaped.insertMode).toBe(false);
	api.setExternalInput(false);
});

test("adopting composed text keeps insert mode and the following key types", () => {
	// The first marked-text change used to arrive through `setText`, whose `<Esc>`
	// dropped the engine into normal mode: after committing the composed
	// character the next `y` ran as an operator instead of being inserted.
	const host = start("tail\n");
	api.setExternalInput(true);
	press("i", host);
	api.insertText("X");

	const adopted: VimResult = JSON.parse(api.adoptText("X日tail\n", 2, 2));
	expect(adopted.insertMode).toBe(true);
	expect(adopted.mode).toBe("insert");
	// The host already applied this; echoing the journal back would double it.
	expect(adopted.edits).toEqual([]);
	expect(api.getText()).toBe("X日tail\n");

	api.insertText("y");
	expect(api.getText()).toBe("X日ytail\n");
	api.setExternalInput(false);
});

test("dot repeats a composed insert", () => {
	const host = start("ab\n");
	api.setExternalInput(true);
	press("i", host);
	api.adoptText("日ab\n", 1, 1);
	press("<Esc>", host);
	expect(api.getText()).toBe("日ab\n");
	press("$.", host);
	expect(api.getText()).toBe("日a日b\n");
	api.setExternalInput(false);
});

test("adopting text that did not change is only a selection move", () => {
	const host = start("ab\n");
	api.setExternalInput(true);
	press("i", host);
	const adopted: VimResult = JSON.parse(api.adoptText("ab\n", 1, 1));
	expect(adopted.edits).toEqual([]);
	expect(adopted.insertMode).toBe(true);
	expect(adopted.selections[adopted.mainIndex]).toEqual({ anchor: 1, head: 1 });
	api.setExternalInput(false);
});

test("a dangling <C-g> does not survive into the next insert session", () => {
	const host = start("tail\n");
	api.setExternalInput(true);
	press("i", host);
	press("<C-g>", host);
	press("<Esc>", host);
	// `U` in normal mode is an undo command, not the tail of `<C-g>U`; the next
	// insert session must start with no prefix pending either.
	press("i", host);
	const join = press("U", host);
	expect(join.handled).toBe(false);
	expect(JSON.parse(api.moveCursorFromHost(0, 0)).undoBreak).toBe(true);
	api.setExternalInput(false);
});

test(":w reaches the host's save hook and nothing else", () => {
	const host = start("alpha beta\n");
	const result = press(":w<CR>", host);
	expect(host.saveRequests).toBe(1);
	expect(result.edits).toEqual([]);
	expect(result.mode).toBe("normal");
	expect(api.getText()).toBe("alpha beta\n");
});

test(":w without a save hook is a no-op rather than an error", () => {
	api.init("alpha\n", {});
	api.setCursor(0, 0);
	let last: VimResult = JSON.parse(api.getState());
	for (const { key, mods } of parseKeys(":w<CR>")) {
		last = JSON.parse(api.handleKey(key, mods));
	}
	expect(last.notification ?? null).toBeNull();
	expect(api.getText()).toBe("alpha\n");
});

test("host text with bare LF lands with the document's CRLF and keeps insert mode", () => {
	const host = start("alpha\r\nbeta\r\n", 0, 5);
	api.setExternalInput(true);
	press("i", host);
	const result: VimResult = JSON.parse(api.insertText("X\nY"));
	expect(result.edits).toEqual([{ from: 5, to: 5, insert: "X\r\nY" }]);
	expect(result.mode).toBe("insert");
	expect(api.getText()).toBe("alphaX\r\nY\r\nbeta\r\n");
	api.setExternalInput(false);
});
