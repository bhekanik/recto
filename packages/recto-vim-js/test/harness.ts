/**
 * Loads the shipped bundle and drives it exactly as Swift will.
 *
 * The point is that this runs `dist/recto-vim.js` — the same bytes the
 * `JSContext` loads — rather than the sources. A green suite here means the
 * bundle is correct; a red one in Swift then means the *bridge* is wrong, which
 * is a much smaller place to look.
 */

export type KeySpec = { key: string; mods: number };

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
	/** `host` is the object JS calls back into; Swift passes its `JSExport`
	 *  bridge, this harness passes a `TestHost`. */
	init: (text: string, host: TestHost | null) => string;
	handleKey: (key: string, mods: number) => string;
	setCursor: (line: number, ch: number) => string;
	getText: () => string;
	getState: () => string;
};

const MOD_CTRL = 1;
const MOD_ALT = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

/** vim key notation → the DOM `key` name the core's `vimKeyFromEvent` expects. */
const NAMED_KEYS = new Map([
	["CR", "Enter"],
	["Enter", "Enter"],
	["Esc", "Escape"],
	["BS", "Backspace"],
	["Del", "Delete"],
	["Space", " "],
	["Tab", "Tab"],
	["Left", "ArrowLeft"],
	["Right", "ArrowRight"],
	["Up", "ArrowUp"],
	["Down", "ArrowDown"],
	["lt", "<"],
]);

/**
 * Parse a vim-style key string ("3dd", "/fox<CR>nN", "ciw<Esc>") into keys.
 * Angle brackets group a named key or a chord; everything else is one key per
 * character, which is what vim itself does.
 */
export function parseKeys(spec: string): KeySpec[] {
	const out: KeySpec[] = [];
	let i = 0;
	// `charAt` rather than `spec[i]`: it returns a plain string, which keeps the
	// UTF-16 indices consistent with `indexOf`/`slice` below and sidesteps
	// `noUncheckedIndexedAccess`.
	while (i < spec.length) {
		if (spec.charAt(i) === "<") {
			const end = spec.indexOf(">", i);
			if (end === -1) throw new Error(`unterminated key group in ${spec}`);
			const body = spec.slice(i + 1, end);
			i = end + 1;
			let mods = 0;
			let rest = body;
			// Chord prefixes: C- A- M- S-, possibly stacked (<C-S-x>).
			for (;;) {
				const m = /^([CAMS])-/.exec(rest);
				if (!m) break;
				mods |=
					m[1] === "C"
						? MOD_CTRL
						: m[1] === "A"
							? MOD_ALT
							: m[1] === "M"
								? MOD_META
								: MOD_SHIFT;
				rest = rest.slice(2);
			}
			out.push({ key: NAMED_KEYS.get(rest) ?? rest, mods });
			continue;
		}
		const ch = spec.charAt(i);
		// An uppercase letter is Shift on a real keyboard, and the core checks
		// `shiftKey` when naming chords.
		out.push({ key: ch, mods: /^[A-Z]$/.test(ch) ? MOD_SHIFT : 0 });
		i++;
	}
	return out;
}

/**
 * A stand-in for the Swift host.
 *
 * Undo is the interesting part: in the product `u` does not run vim's own
 * history, it runs the document's undo tree, so the host performs the change
 * and hands the new buffer back. This models that with a snapshot stack, which
 * is enough to prove the round trip and the resync path.
 */
export class TestHost {
	private undoStack: Snapshot[] = [];
	private redoStack: Snapshot[] = [];
	private pending: Snapshot | null = null;
	private clipboardText = "";
	private api: RectoVimApi;

	constructor(api: RectoVimApi) {
		this.api = api;
	}

	private capture(): Snapshot {
		// SAFETY: `getState` is the bundle's own serialiser for `VimResult`; the
		// Swift side decodes the identical payload with `JSONDecoder`, so a shape
		// mismatch would fail the Swift suite rather than pass silently here.
		const state = JSON.parse(this.api.getState()) as VimResult;
		const sel = state.selections[state.mainIndex] ?? { anchor: 0, head: 0 };
		return { text: this.api.getText(), anchor: sel.anchor, head: sel.head };
	}

	/** Remember where we were, in case this key turns out to change something. */
	beginKey(): void {
		this.pending = this.capture();
	}

	/**
	 * Commit an undo entry only if the key actually edited. Keys that merely
	 * moved the caret must not push a state, or `u` would appear to do nothing.
	 * A resync is the host's own undo coming back and is never re-recorded.
	 */
	endKey(result: VimResult): void {
		if (this.pending && result.edits.length > 0 && !result.resynced) {
			this.undoStack.push(this.pending);
			this.redoStack = [];
		}
		this.pending = null;
	}

	historyCommand(kind: string): string | null {
		const from = kind === "undo" ? this.undoStack : this.redoStack;
		const to = kind === "undo" ? this.redoStack : this.undoStack;
		const target = from.pop();
		if (!target) return null;
		to.push(this.capture());
		return JSON.stringify(target);
	}

	clipboardRead(): string {
		return this.clipboardText;
	}

	clipboardWrite(text: string): void {
		this.clipboardText = text;
	}
}

type Snapshot = { text: string; anchor: number; head: number };

/** Evaluate the built bundle into this realm and hand back the global it sets. */
export async function loadBundle(path: string): Promise<RectoVimApi> {
	const source = await Bun.file(path).text();
	// The bundle is an IIFE that assigns `globalThis.RectoVim`, so it has to be
	// evaluated rather than imported — the same thing `JSContext.evaluateScript`
	// does on the Swift side. `Function` keeps it out of this module's scope.
	new Function(source)();
	const api = (globalThis as unknown as { RectoVim?: RectoVimApi }).RectoVim;
	if (!api) throw new Error(`bundle at ${path} did not define RectoVim`);
	return api;
}
