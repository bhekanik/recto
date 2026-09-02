/**
 * The wire between `dist/recto-vim.js` and everything that drives it.
 *
 * These live at the package root rather than in `test/` because `build.ts` and
 * `bare-realm.ts` are production code and must not depend on the test harness —
 * the DOM-free gate runs during the build, before any test does.
 *
 * `VimResult` mirrors what `src/index.js` serialises and what Swift's
 * `VimResult` decodes. It is a hand-written mirror of a JSON payload, so it is a
 * claim rather than a proof; the Swift suite decoding the *same* payload with
 * `JSONDecoder` is what makes a shape mismatch fail somewhere instead of
 * nowhere.
 */

export type KeySpec = { key: string; mods: number };

/** The Swift-side contract, as `src/host.js` documents it. All optional. */
export type VimHost = {
	geometry?: (requestJson: string) => string | null;
	historyCommand?: (kind: string) => string | null;
	clipboardRead?: () => string;
	clipboardWrite?: (text: string) => void;
	/** `:w` — the host decides what saving means. */
	saveRequested?: () => void;
};

export type VimResult = {
	handled: boolean;
	edits: { from: number; to: number; insert: string }[];
	selections: { anchor: number; head: number }[];
	mainIndex: number;
	mode: string;
	subMode: string;
	pending: string;
	insertMode: boolean;
	visualMode: boolean;
	prompt: { prefix: string; value: string } | null;
	notification: { text: string } | null;
	search: string | null;
	resynced: boolean;
	/**
	 * The cursor handoff that produced this result has to start a new undo block.
	 * Only `moveCursorFromHost` ever sets it; `<C-g>U` is what clears it.
	 */
	undoBreak: boolean;
};

export type RectoVimApi = {
	version: string;
	/**
	 * `host` is whatever JS calls back into — Swift passes its `JSExport`
	 * bridge, the test harness passes a `TestHost`, and the DOM-free gate in
	 * `build.ts` passes `null`. `src/host.js` reads only the four optional
	 * methods it documents, so the structural type is deliberately open rather
	 * than a union of things that live in different worlds.
	 */
	init: (text: string, host: VimHost | null) => string;
	handleKey: (key: string, mods: number) => string;
	setCursor: (line: number, ch: number) => string;
	/** Adopt text the host changed while vim was idle; cancels any pending command. */
	setText: (text: string, anchor: number, head: number) => string;
	getText: () => string;
	getState: () => string;
	/**
	 * Hand text input to the host's own input system instead of synthesising it
	 * from key names. Native adapters turn this on; the headless suites do not.
	 */
	setExternalInput: (enabled: boolean) => string;
	/** Text the host's input system produced, as one transaction. */
	insertText: (text: string, from?: number, to?: number) => string;
	/**
	 * The host's own input system moved the caret — an arrow key insert mode
	 * declines, Home/End, a click. Keeps the mode, unlike `setText`.
	 */
	moveCursorFromHost: (anchor: number, head?: number) => string;
	/**
	 * Text the host's input system rewrote and has already applied to its own
	 * storage — an IME composition. Keeps the mode and records the change for `.`.
	 */
	adoptText: (
		text: string,
		anchor?: number,
		head?: number,
		composing?: boolean,
	) => string;
	/** Registers and marks as JSON, for persistence across a relaunch. */
	saveState: () => string;
	restoreState: (json: string) => string;
};
