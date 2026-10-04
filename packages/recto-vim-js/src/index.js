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
import {
	clusterAlignedDiff,
	clusterStart,
	nextCluster,
	previousCluster,
} from "./grapheme.js";
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

		/**
		 * True when the host owns text input — an `NSTextView`/`UITextView` whose
		 * input system produces `insertText:`. See `insertText` below.
		 */
		this.externalInput = false;

		/**
		 * `<C-g>U` state. Vim's insert-mode prefix for "the next cursor movement
		 * does not break undo"; the core has no command for it, so the bridge
		 * holds the flag and `moveCursorFromHost` consumes it.
		 */
		this.pendingUndoJoin = false;
		this.suppressUndoBreak = false;
		/** Set only by `moveCursorFromHost`; see `_result`. */
		this.undoBreak = false;

		this.cm.on("vim-mode-change", (e) => {
			this.mode = e.mode;
			this.subMode = e.subMode || "";
			this.modeChanged = true;
			// `<C-g>U` is insert-mode state; leaving insert must not carry a
			// half-typed prefix into the next session, where the `U` of an
			// unrelated command would complete it.
			this.pendingUndoJoin = false;
			this.suppressUndoBreak = false;
			// Upstream's own view plugin clears the pending keys here and on
			// `vim-command-done`; without both, `pending` accumulates every key of
			// the session instead of showing a half-typed command.
			if (this.cm.state.vim) this.cm.state.vim.status = "";
		});
		this.cm.on("vim-command-done", () => {
			if (this.cm.state.vim) this.cm.state.vim.status = "";
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
		if (vim.insertMode && this._handleUndoJoin(vimKey))
			return this._result(true);

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
	 * buffer mirror here, someone has to perform the insert, and routing it
	 * through `operation()` is what makes the core see the change and keep `.`
	 * working.
	 *
	 * **Who performs it depends on `externalInput`.** A `keyDown` event carries
	 * one key name; real text input does not. NFD input arrives as a base letter
	 * and a combining mark, an emoji as several scalars, a dead key as a
	 * composition, and an IME as marked text that is rewritten before it commits.
	 * Synthesising the insert from the key name loses all of that. So a native
	 * host sets `externalInput` and this declines printable characters, letting
	 * the text view's own input system produce them and hand them back through
	 * `RectoVim.insertText` — one transaction, mirror and dot-repeat included.
	 * The headless suites leave it off and drive the keys directly.
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
			!this.externalInput &&
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

	/**
	 * Text the host's input system produced: a typed character, a composed dead
	 * key, an emoji from the picker, a committed IME string, a paste.
	 *
	 * This is one transaction. It goes through `operation()` so the core sees the
	 * change and dot-repeat replays it, it updates the mirror, and it returns the
	 * usual result so the host applies the same edit to its storage — the host
	 * must **not** have inserted the text itself first.
	 *
	 * `from`/`to` are optional UTF-16 offsets, for a replacement range: AppKit
	 * and UIKit both hand one over when replacing marked text.
	 *
	 * @param {string} text
	 * @param {number} [from]
	 * @param {number} [to]
	 */
	insertText(text, from, to) {
		const cm = this.cm;
		// This is the boundary: the arguments come across from Swift through
		// JSCore, where a missing `replacementRange` arrives as `undefined` and a
		// `JSValue` that failed to convert arrives as something else entirely.
		// Everything below this point deals in the parsed values.
		if (typeof text !== "string" || text === "") return this._result(false);
		const hasRange = typeof from === "number" && Number.isFinite(from);
		const rangeEnd = typeof to === "number" && Number.isFinite(to) ? to : from;
		cm.operation(() => {
			if (hasRange) {
				cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(rangeEnd));
			} else if (cm.state.overwrite) {
				cm.overWriteSelection(text);
			} else {
				cm.replaceSelection(text);
			}
		});
		return this._result(true);
	}

	/**
	 * `<C-g>U`, vim's insert-mode prefix for "the next cursor movement does not
	 * break undo".
	 *
	 * The core has no command for it, so the two keys are consumed here and the
	 * flag is read by `moveCursorFromHost`. Returns true when the key was
	 * swallowed; a `<C-g>` followed by anything else runs that second key
	 * normally, which is what vim does with an unknown `<C-g>` sequence.
	 *
	 * @param {string} vimKey
	 */
	_handleUndoJoin(vimKey) {
		if (this.pendingUndoJoin) {
			this.pendingUndoJoin = false;
			if (vimKey === "U") {
				this.suppressUndoBreak = true;
				return true;
			}
			return false;
		}
		if (vimKey === "<C-g>") {
			this.pendingUndoJoin = true;
			return true;
		}
		return false;
	}

	/**
	 * The host's own input system moved the caret: an arrow key or Home/End that
	 * insert mode declines to vim, a click, a menu command.
	 *
	 * Deliberately **not** `setText`. That cancels through `<Esc>`, so through a
	 * real `NSTextView` `iab<Left>` left the engine at offset 2 while the
	 * selection was at 1, the next `c` landed at the engine's offset (`abctail`
	 * rather than vim's `acbtail`), and `u` then removed all three characters.
	 * Setting the selection on its own keeps the mode and lets the core's own
	 * `onCursorActivity` do what it does on the web — reset the dot-repeat change
	 * and move `insertEnd`, so `.` replays what was typed *after* the move.
	 *
	 * @param {number} anchor @param {number} [head] UTF-16 offsets
	 */
	moveCursorFromHost(anchor, head) {
		const cm = this.cm;
		// Vim starts a new undo block at a cursor key; `<C-g>U` is the documented
		// exception, and the host reads the decision back off the result.
		this.undoBreak = !!cm.state.vim?.insertMode && !this.suppressUndoBreak;
		this.suppressUndoBreak = false;
		cm.operation(() => {
			cm.setSelection(
				cm.posFromIndex(this._clampOffset(anchor)),
				cm.posFromIndex(this._clampOffset(head ?? anchor)),
			);
		});
		// Vim resets the wanted column (`curswant`) when the mouse moves the
		// cursor. The core only recomputes `lastHSPos`/`lastHPos` when the
		// previous motion was not a vertical one, so after `gj` a host move
		// would leave `gj`/`gk` aiming at the old column.
		if (cm.state.vim) cm.state.vim.lastMotion = null;
		const result = this._result(true);
		this.undoBreak = false;
		return result;
	}

	/**
	 * The host's input system rewrote the text itself and has already applied the
	 * result to its own storage — an IME composition, which AppKit and UIKit own
	 * from the first marked-text change to the commit.
	 *
	 * Unlike `setText` this keeps the mode. The composition used to arrive through
	 * `setText`, whose `<Esc>` left the engine in normal mode, so after committing
	 * `日` mid-insert the next `y` ran as an operator instead of being typed. The
	 * change goes through the ordinary edit path so the core records it for `.`,
	 * and the journal is dropped afterwards because the host is not waiting for it
	 * — it is handing us text it already has.
	 *
	 * The change and the selection share one operation on purpose: the core only
	 * skips its "the cursor moved on its own" reset when the cursor activity
	 * arrives in the same operation as the change it belongs to, and that reset is
	 * what would throw the composed text out of the dot-repeat record.
	 *
	 * `composing` is what keeps dot-repeat honest across a composition. Each
	 * marked-text update rewrites the whole provisional run, so recording every
	 * one of them would make `.` replay `ni日` rather than the `日` that was
	 * committed. Provisional updates go in under an origin the core's `onChange`
	 * ignores; the commit arrives with the marked run gone, is recorded, and its
	 * range covers the provisional text it replaces.
	 *
	 * @param {string} text @param {number} [anchor] @param {number} [head]
	 * @param {boolean} [composing] the host still has marked text up
	 */
	adoptText(text, anchor, head, composing) {
		const cm = this.cm;
		if (typeof text !== "string") return this._result(false);
		const before = cm.getValue();
		cm.operation(() => {
			if (before !== text) {
				const patch = clusterAlignedDiff(before, text);
				cm.replaceRange(
					patch.insert,
					cm.posFromIndex(patch.from),
					cm.posFromIndex(patch.to),
					composing ? "+composition" : "+input",
				);
			}
			cm.setSelection(
				cm.posFromIndex(this._clampOffset(anchor)),
				cm.posFromIndex(this._clampOffset(head ?? anchor)),
			);
		});
		cm.takeEdits();
		return this._result(true);
	}

	/** @param {unknown} offset @returns {number} */
	_clampOffset(offset) {
		const n =
			typeof offset === "number" && Number.isFinite(offset) ? offset : 0;
		return Math.max(0, Math.min(n, this.cm.doc.length));
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

	/**
	 * The host changed the buffer (typing with vim idle, a sync landing, undo).
	 *
	 * Any half-typed command is cancelled first. Swapping the text underneath an
	 * operator leaves the core holding state that refers to a buffer that no
	 * longer exists: type `d`, sync in a new document, type `w`, and the old
	 * operator completes against the new text and deletes a word nobody asked
	 * for. `<Esc>` is the core's own way back to idle — it clears the operator,
	 * the count and the register, and leaves visual and insert mode — so this
	 * uses that rather than reaching into `inputState`.
	 */
	setText(text, anchor, head) {
		this._cancelPendingCommand();
		this.cm.resetTo(text, anchor, head);
		return this._result(true);
	}

	_cancelPendingCommand() {
		const cm = this.cm;
		if (cm.$prompt) {
			cm.$prompt.close();
			cm.$prompt = null;
		}
		const vim = cm.state.vim;
		if (!vim) return;
		const idle =
			!vim.insertMode &&
			!vim.visualMode &&
			!vim.status &&
			!vim.inputState?.operator &&
			!vim.inputState?.motion &&
			!vim.inputState?.keyBuffer?.length;
		if (!idle) Vim.handleKey(cm, "<Esc>", "recto-external-sync");
		vim.status = "";
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
			// True only on the result of a `moveCursorFromHost` that has to start a
			// new undo block; every other call leaves it false.
			undoBreak: this.undoBreak,
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
 * Registers hold `\n`-separated text whatever the document's ending.
 *
 * Upstream slices register text by single characters: a linewise put after the
 * cursor is `'\n' + text.slice(0, -1)`, which on a yank of `beta\r\n` leaves
 * `\nbeta\r` — a stray CR that became an extra blank line in a CRLF file. With
 * registers normalised on the way in, that arithmetic is right, and the write
 * path (`RectoCM._applyEdit`) puts the document's own ending back on the way
 * out. Patched on the prototypes so a `Vim` reset keeps it.
 */
{
	const controller = Vim.getRegisterController();
	// `setText` accepts a missing text (upstream reads `text || ''`).
	const normalise = (text) => (text ?? "").replace(/\r\n|\r/g, "\n");
	const controllerProto = Object.getPrototypeOf(controller);
	const pushText = controllerProto.pushText;
	controllerProto.pushText = function (
		name,
		operator,
		text,
		linewise,
		blockwise,
	) {
		return pushText.call(
			this,
			name,
			operator,
			normalise(text),
			linewise,
			blockwise,
		);
	};
	const registerProto = Object.getPrototypeOf(controller.unnamedRegister);
	const setText = registerProto.setText;
	registerProto.setText = function (text, linewise, blockwise) {
		return setText.call(this, normalise(text), linewise, blockwise);
	};
}

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

/**
 * `r` — replace each character in the range with the typed one, counting
 * grapheme clusters rather than code units.
 *
 * Overridden rather than clamped after the fact. Upstream computes the range as
 * `curStart.ch + repeat` and then puts the caret at `curEnd - 1`, both in code
 * units. Widening the range in `_applyEdit` fixed the *text* — `r-` on an emoji
 * family produced `a-b` — but left the caret one position past the replacement,
 * because `curEnd` was still the position upstream asked for rather than the one
 * that was replaced. There is no way to map that back afterwards: "one character
 * before the end" is character arithmetic, not an offset mapping. Doing the
 * whole action in cluster terms is the only version that is right about both.
 *
 * Everything else follows upstream: the count clamps to the end of the line
 * rather than refusing (which is what the web lens does), `r<CR>` deletes the
 * range and opens a line, visual mode replaces the selection and exits, and
 * visual block expands tabs first.
 */
Vim.defineAction("replace", (cm, actionArgs, vim) => {
	const replaceWith = actionArgs.selectedCharacter || "";
	const selections = cm.listSelections();
	let curStart;
	let curEnd;

	if (vim.visualMode) {
		curStart = cm.getCursor("start");
		curEnd = cm.getCursor("end");
	} else {
		curStart = cm.getCursor();
		const line = cm.getLine(curStart.line);
		let ch = curStart.ch;
		for (let n = actionArgs.repeat || 1; n > 0 && ch < line.length; n--) {
			ch = nextCluster(line, ch);
		}
		curEnd = new Pos(curStart.line, Math.min(ch, line.length));
	}

	if (replaceWith === "\n") {
		if (!vim.visualMode) cm.replaceRange("", curStart, curEnd);
		RectoCM.commands.newlineAndIndent(cm);
		return;
	}

	if (vim.visualBlock) {
		const spaces = " ".repeat(cm.getOption("tabSize") || 4);
		cm.replaceSelections(
			cm
				.getSelections()
				.map((piece) =>
					replaceClusters(piece.replace(/\t/g, spaces), replaceWith),
				),
		);
		return;
	}

	const replacement = replaceClusters(
		cm.getRange(curStart, curEnd),
		replaceWith,
	);
	cm.replaceRange(replacement, curStart, curEnd);

	if (vim.visualMode) {
		const first = selections[0];
		const before =
			first.anchor.line < first.head.line ||
			(first.anchor.line === first.head.line &&
				first.anchor.ch <= first.head.ch);
		cm.setCursor(before ? first.anchor : first.head);
		Vim.exitVisualMode(cm, false);
	} else {
		// Vim leaves the caret on the last character it replaced, not after it.
		const start = cm.indexFromPos(curStart);
		cm.setCursor(
			cm.posFromIndex(
				replacement.length > 0
					? clusterStart(cm.getValue(), start + replacement.length - 1)
					: start,
			),
		);
	}
});

/**
 * One `replaceWith` per grapheme cluster, line endings left alone — `r` never
 * replaces a newline (`r<CR>` is the separate case above).
 *
 * @param {string} text @param {string} replaceWith
 */
function replaceClusters(text, replaceWith) {
	let out = "";
	let at = 0;
	while (at < text.length) {
		const end = nextCluster(text, at);
		const cluster = text.slice(at, end);
		out += /^(\r\n|\n|\r)$/.test(cluster) ? cluster : replaceWith;
		at = end;
	}
	return out;
}

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

	/**
	 * Hand text input to the host's own input system rather than synthesising it
	 * from key names. Native adapters turn this on; the headless suites do not.
	 * @param {boolean} enabled
	 */
	setExternalInput: (enabled) => {
		session.externalInput = !!enabled;
		return session._result(true);
	},
	insertText: (text, from, to) => session.insertText(text, from, to),
	promptKey: (key, mods) => session.promptKey(key, mods),
	setText: (text, anchor, head) => session.setText(text, anchor, head),
	moveCursorFromHost: (anchor, head) =>
		session.moveCursorFromHost(anchor, head),
	adoptText: (text, anchor, head, composing) =>
		session.adoptText(text, anchor, head, composing),

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

	/**
	 * Named registers and marks, as JSON, so the host can carry them across a
	 * relaunch. Not the whole vim state: the current mode, pending keys and the
	 * search history are session-scoped and restoring them would resume the user
	 * mid-command.
	 *
	 * Registers are flattened to their text. A macro register holds a key string,
	 * which is exactly what `toString()` gives and what `setText` takes back, so
	 * `@q` survives a relaunch. Insert-mode change lists and per-register search
	 * queries do not, and should not — replaying them against a document that has
	 * moved on is how you corrupt a file.
	 */
	saveState() {
		const registers = {};
		const all = Vim.getRegisterController().registers;
		for (const name of Object.keys(all)) {
			const register = all[name];
			const text = register?.toString?.() ?? "";
			if (!text) continue;
			registers[name] = {
				text,
				linewise: !!register.linewise,
				blockwise: !!register.blockwise,
			};
		}

		const marks = {};
		const vimMarks = session?.cm.state.vim?.marks ?? {};
		for (const name of Object.keys(vimMarks)) {
			const found = vimMarks[name]?.find?.();
			if (found) marks[name] = session.cm.indexFromPos(found);
		}

		return JSON.stringify({ registers, marks });
	},

	/**
	 * @param {string} json output of `saveState`
	 */
	restoreState(json) {
		const state = JSON.parse(json || "{}");
		const controller = Vim.getRegisterController();
		for (const name of Object.keys(state.registers || {})) {
			const saved = state.registers[name];
			controller
				.getRegister(name)
				.setText(saved.text, !!saved.linewise, !!saved.blockwise);
		}
		const vim = session?.cm.state.vim;
		if (vim) {
			for (const name of Object.keys(state.marks || {})) {
				const offset = state.marks[name];
				if (typeof offset !== "number") continue;
				vim.marks[name]?.clear?.();
				vim.marks[name] = session.cm.setBookmark(
					session.cm.posFromIndex(offset),
				);
			}
		}
		return session ? session._result(true) : "{}";
	},

	/** Escape hatch for debugging from the Swift side. */
	_session: () => session,
	_Vim: Vim,
};

globalObject.RectoVim = RectoVim;

export { RectoVim, Vim, VimSession };
