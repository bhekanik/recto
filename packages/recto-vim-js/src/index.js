/**
 * `RectoVim` — the whole vim layer as one global, for a `JSContext` to load.
 *
 * Swift talks to exactly the functions on this object. A keystroke is one call
 * in and one JSON string out, which is the entire reason the adapter keeps a
 * copy of the document: whatever the core does in between — and for something
 * like `3dd` that is hundreds of buffer reads — costs nothing at the bridge.
 */

import { RectoCM } from "./adapter.js";
import { installDomShim } from "./dom-shim.js";
import { initVim } from "./generated/vim-core.js";
import { nextCluster, previousCluster } from "./grapheme.js";
import { wrapHost } from "./host.js";
import { Pos } from "./pos.js";

const globalObject = globalThis;

/** DOM-style key names the core understands; see README "Key names". */
const KEY_CODES = { Enter: 13, Escape: 27, Backspace: 8 };

class VimSession {
	/**
	 * @param {string} text
	 * @param {import("./host.js").RawVimHost | null} rawHost
	 */
	constructor(text, rawHost) {
		this.host = wrapHost(rawHost);
		installDomShim(globalObject, {
			clipboard: this.host?.clipboard,
			isMac: true,
		});
		this.cm = new RectoCM(text, this.host);
		this.mode = "normal";
		this.subMode = "";
		this.modeChanged = false;

		this.cm.on("vim-mode-change", (e) => {
			this.mode = e.mode;
			this.subMode = e.subMode || "";
			this.modeChanged = true;
		});
		Vim.enterVimMode(this.cm);
	}

	/**
	 * Feed one key. `key` uses DOM `KeyboardEvent.key` names because that is what
	 * the core's own `vimKeyFromEvent` expects — letting it do the naming keeps
	 * `<C-w>`-style spelling in one place instead of duplicating it in Swift.
	 *
	 * @param {string} key
	 * @param {number} mods bitmask: 1 ctrl, 2 alt, 4 meta, 8 shift
	 */
	handleKey(key, mods = 0) {
		const event = {
			key,
			keyCode: KEY_CODES[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0),
			ctrlKey: !!(mods & 1),
			altKey: !!(mods & 2),
			metaKey: !!(mods & 4),
			shiftKey: !!(mods & 8),
		};

		// A prompt swallows everything while it is open: that is how `:` and `/`
		// collect a line without the buffer seeing the keys.
		if (this.cm.$prompt) {
			this.cm.$prompt.handleKey(event);
			return this._result(true);
		}

		const vim = this.cm.state.vim;
		if (!vim) return this._result(false);
		const vimKey = Vim.vimKeyFromEvent(event, vim);
		if (!vimKey) return this._result(false);

		vim.status = (vim.status || "") + vimKey;
		let handled = Vim.multiSelectHandleKey(this.cm, vimKey, "user");
		if (!handled) handled = this._fallthrough(event, vimKey);
		globalObject.__rectoDrainTimers?.();
		return this._result(!!handled);
	}

	/**
	 * What the text view would have done with a key vim did not claim.
	 *
	 * In insert mode the core deliberately does not insert typed characters —
	 * on the web CodeMirror's own input handling does that, and the core only
	 * watches the resulting change to build dot-repeat. Since JS holds the
	 * buffer mirror here, JS has to perform the insert too, or the mirror and
	 * the text view would disagree about what was typed. Routing it through
	 * `operation()` is what makes the core see the change and keep `.` working.
	 *
	 * In normal mode nothing falls through: unmapped keys are swallowed, exactly
	 * as upstream's input handler swallows text input outside insert mode.
	 */
	_fallthrough(event, vimKey) {
		const cm = this.cm;
		const vim = cm.state.vim;
		if (!vim?.insertMode) return false;

		const insert = (text) =>
			cm.operation(() => {
				if (cm.state.overwrite) cm.overWriteSelection(text);
				else cm.replaceSelection(text);
			});

		if (vimKey === "<CR>") {
			cm.operation(() => RectoCM.commands.newlineAndIndent(cm));
			return true;
		}
		if (vimKey === "<BS>") {
			cm.operation(() => RectoCM.keys.Backspace(cm));
			return true;
		}
		if (vimKey === "<Del>") {
			cm.operation(() => RectoCM.keys.Delete(cm));
			return true;
		}
		if (vimKey === "<Space>") {
			insert(" ");
			return true;
		}
		if (vimKey === "<Tab>") {
			insert("\t");
			return true;
		}
		// Single printable characters only. Anything bracketed (`<C-x>`, `<Up>`)
		// is a chord vim declined to handle, and inserting its name would be
		// worse than dropping it.
		if (
			event.key &&
			event.key.length === 1 &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			insert(event.key);
			return true;
		}
		return false;
	}

	/** Keys typed into an open `:`/`/` line, when the host routes them itself. */
	promptKey(key, mods = 0) {
		if (!this.cm.$prompt) return this._result(false);
		this.cm.$prompt.handleKey({
			key,
			keyCode: KEY_CODES[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0),
			ctrlKey: !!(mods & 1),
			altKey: !!(mods & 2),
			metaKey: !!(mods & 4),
			shiftKey: !!(mods & 8),
		});
		return this._result(true);
	}

	/** The host changed the buffer (typing with vim idle, sync, undo). */
	setText(text, anchor, head) {
		this.cm.resetTo(text, anchor, head);
		return this._result(true);
	}

	_result(handled) {
		const cm = this.cm;
		const vim = cm.state.vim;
		const prompt = cm.$prompt;
		const result = {
			handled,
			edits: cm.takeEdits(),
			selections: cm.selections,
			mainIndex: cm.mainIndex,
			mode: this.mode,
			subMode: this.subMode,
			modeChanged: this.modeChanged,
			// The keys of a half-typed command (`3d` waiting for a motion), which
			// vim shows on the right of the status line.
			pending: vim?.status || "",
			insertMode: !!vim?.insertMode,
			visualMode: !!vim?.visualMode,
			prompt: prompt ? { prefix: prompt.prefix, value: prompt.value } : null,
			notification: cm.$notification,
			scroll: cm.$scrollRequest,
			search: cm.searchOverlay ? cm.searchOverlay.source : null,
			resynced: !!cm.$resynced,
		};
		this.modeChanged = false;
		cm.$notification = null;
		cm.$scrollRequest = null;
		cm.$resynced = false;
		return JSON.stringify(result);
	}
}

const Vim = initVim(RectoCM);

/**
 * `h`, `l`, `x`, `X`, `s`, `~`, `dl`, `dh` and every count on them, stepping by
 * grapheme cluster instead of by code point.
 *
 * Upstream's `moveByCharacters` is `new Pos(cur.line, cur.ch +/- repeat)` — plain
 * arithmetic on UTF-16 offsets. That is what severs ZWJ families and orphans
 * skin-tone modifiers: the resulting position lands inside a cluster and the
 * operator then deletes up to it. Replacing the motion through
 * `Vim.defineMotion` — a documented upstream extension point — fixes the whole
 * family of commands at the source, so operators, dot-repeat, macros and counts
 * all inherit it without a single upstream line being edited.
 *
 * Out-of-range results are produced deliberately, exactly as upstream does: `3l`
 * on a two-character line returns ch 3 and `clipCursorToContent` clamps it. The
 * cluster steppers keep counting past both ends for that reason.
 */
Vim.defineMotion("moveByCharacters", (cm, head, motionArgs) => {
	const repeat = motionArgs.repeat;
	if (!Number.isFinite(repeat)) {
		// Preserve upstream behaviour (NaN in, NaN out) rather than inventing a
		// default that would silently move the cursor somewhere plausible.
		const ch = motionArgs.forward ? head.ch + repeat : head.ch - repeat;
		return new Pos(head.line, ch);
	}
	const line = cm.getLine(head.line);
	const step = motionArgs.forward ? nextCluster : previousCluster;
	let ch = head.ch;
	for (let n = repeat; n > 0; n--) ch = step(line, ch);
	return new Pos(head.line, ch);
});

/** @type {VimSession | null} */
let session = null;

const RectoVim = {
	version: __RECTO_VIM_VERSION__,

	/** @param {string} text @param {import("./host.js").RawVimHost | null} host */
	init(text, host) {
		session = new VimSession(text || "", host || null);
		return session._result(true);
	},

	handleKey: (key, mods) => session.handleKey(key, mods),
	promptKey: (key, mods) => session.promptKey(key, mods),
	setText: (text, anchor, head) => session.setText(text, anchor, head),

	/** Whole-buffer read, for asserting in tests and for host resync. */
	getText: () => session.cm.getValue(),
	getState: () => session._result(true),

	map: (lhs, rhs, ctx) => Vim.map(lhs, rhs, ctx),
	noremap: (lhs, rhs, ctx) => Vim.noremap(lhs, rhs, ctx),
	unmap: (lhs, ctx) => Vim.unmap(lhs, ctx),
	setOption: (name, value, ctx) => Vim.setOption(name, value, session?.cm, ctx),
	getOption: (name, ctx) => Vim.getOption(name, session?.cm, ctx),
	defineEx: (name, prefix, fn) => Vim.defineEx(name, prefix, fn),
	// The web remaps `u`/`<C-r>` onto the undo tree with these two
	// (lib/editor/codemirror/index.tsx `ensureVimHistoryRemap`). Exposed so the
	// native client can run byte-identical remap code. Not needed for undo
	// itself — `CM.commands.undo` already routes to the host — but anything else
	// the product wants to rebind goes through here.
	defineAction: (name, fn) => Vim.defineAction(name, fn),
	mapCommand: (keys, type, name, args, extra) =>
		Vim.mapCommand(keys, type, name, args, extra),

	/** Place the caret, for tests and for handing focus to the vim layer. */
	setCursor: (line, ch) => {
		session.cm.setCursor(line, ch);
		return session._result(true);
	},
	exitInsertMode: () => {
		Vim.exitInsertMode(session.cm);
		return session._result(true);
	},

	/** Escape hatch for debugging from the Swift side. */
	_session: () => session,
	_Vim: Vim,
};

globalObject.RectoVim = RectoVim;

export { RectoVim, Vim, VimSession };
