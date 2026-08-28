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
	/** Registers and marks as JSON, for persistence across a relaunch. */
	saveState: () => string;
	restoreState: (json: string) => string;
};
