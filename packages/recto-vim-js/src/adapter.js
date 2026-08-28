/**
 * `RectoCM` — the editor adapter the vim core talks to.
 *
 * Upstream ships one of these written against a CodeMirror 6 `EditorView`. This
 * is the same interface written against a plain string plus a set of selection
 * offsets, so it runs in JavaScriptCore with no editor underneath it. The core
 * cannot tell the difference: it only ever calls the ~60 members below.
 *
 * Two things travel back to Swift and nothing else:
 *   - `edits`: `{from, to, insert}` in UTF-16 offsets, applied in order.
 *   - `selections`: the final ranges, same units.
 * Everything the core reads on the way to producing those is answered locally,
 * which is what keeps a keystroke to one bridge crossing each way.
 *
 * Geometry (`charCoords`, `getScrollInfo`, `findPosV` by page) is the exception:
 * only the text view knows where a line was laid out, so those call the host.
 * They are reached by scrolling and visual-line commands (`H`/`M`/`L`, `zz`,
 * `Ctrl-D`, `gj`) and never by the editing commands, so the extra crossings are
 * rare. With no host attached they fall back to a fixed-metrics approximation,
 * which is what lets the keystroke suite run headless.
 */

import { RectoDoc } from "./document.js";
import { StringStream } from "./generated/string-stream.js";
import { hardWrap, scanForBracket } from "./generated/vim-helpers.js";
import { Pos } from "./pos.js";
import { Prompt } from "./prompt.js";

/** Assumed metrics when no text view is attached (headless runs). */
const FALLBACK_LINE_HEIGHT = 20;
const FALLBACK_CHAR_WIDTH = 8;
const FALLBACK_VIEWPORT_HEIGHT = 600;

/* ------------------------------------------------------------------ events */

function on(emitter, type, f) {
	emitter._handlers ??= {};
	const map = emitter._handlers;
	map[type] = (map[type] || []).concat(f);
}

function off(emitter, type, f) {
	const map = emitter._handlers;
	const arr = map?.[type];
	if (!arr) return;
	const index = arr.indexOf(f);
	if (index > -1) map[type] = arr.slice(0, index).concat(arr.slice(index + 1));
}

function signal(emitter, type, ...args) {
	const handlers = emitter._handlers?.[type];
	if (!handlers) return;
	for (const h of handlers.slice()) h(...args);
}

function signalTo(handlers, ...args) {
	if (!handlers) return;
	for (const h of handlers.slice()) h(...args);
}

let wordChar;
try {
	wordChar = /[\w\p{Alphabetic}\p{Number}_]/u;
} catch {
	wordChar = /[\w]/;
}

/* ------------------------------------------------------------- position map */

/**
 * Move an offset across one replacement, the way CodeMirror's `mapPos` does.
 * `assoc < 0` sticks to the text before the edit, `assoc > 0` to the text after.
 * `trackDel` reports a position swallowed by the edit as gone, which is how
 * marks and `:g` line handles learn that their line was deleted.
 */
function mapOffset(
	offset,
	from,
	to,
	insertLength,
	assoc = -1,
	trackDel = false,
) {
	if (offset <= from) return offset;
	if (offset >= to) return offset + insertLength - (to - from);
	if (trackDel) return null;
	return assoc > 0 ? from + insertLength : from;
}

/** A bookmark (`` `a ``, `'a`) that survives edits. */
class Marker {
	constructor(cm, offset, assoc) {
		this.cm = cm;
		this.id = cm.$mid++;
		this.offset = offset;
		this.assoc = assoc;
		cm.marks[this.id] = this;
	}

	clear() {
		delete this.cm.marks[this.id];
	}

	find() {
		if (this.offset == null) return null;
		return this.cm.posFromIndex(this.offset);
	}

	update(from, to, insertLength) {
		if (this.offset == null) return;
		this.offset = mapOffset(
			this.offset,
			from,
			to,
			insertLength,
			this.assoc,
			true,
		);
	}
}

/* ----------------------------------------------------------------- adapter */

export class RectoCM {
	/**
	 * @param {string} text
	 * @param {import("./host.js").VimHost} [host]
	 */
	constructor(text, host) {
		this.doc = new RectoDoc(text);
		this.host = host || null;
		this.state = {};
		this.marks = Object.create(null);
		this.$mid = 0;
		this.options = {};
		this._handlers = {};
		this.$lastChangeEndOffset = 0;
		this.virtualSelection = null;
		this.curOp = null;
		/** @type {{anchor: number, head: number}[]} */
		this.selections = [{ anchor: 0, head: 0 }];
		this.mainIndex = 0;
		/** Edits produced since the last `takeEdits()`, in application order. */
		this.edits = [];
		/** Live `/` search regex, so the host can paint match highlights. */
		this.searchOverlay = null;
		/** @type {import("./prompt.js").Prompt | null} */
		this.$prompt = null;
		this.$notification = null;
		this.$scrollRequest = null;
		this.$inputField = { _handlers: {} };
		this.$lineHandleEdits = null;
	}

	/* -- text ------------------------------------------------------------- */

	firstLine() {
		return 0;
	}

	lastLine() {
		return this.doc.lineCount - 1;
	}

	lineCount() {
		return this.doc.lineCount;
	}

	getLine(row) {
		return this.doc.getLine(row);
	}

	getValue() {
		return this.doc.text;
	}

	setValue(text) {
		this.doc.setText(text);
		this.selections = [{ anchor: 0, head: 0 }];
		this.mainIndex = 0;
	}

	/**
	 * Adopt text the host changed behind our back — an undo, or an edit made
	 * with the vim layer idle. Deliberately does *not* journal an edit: the host
	 * has already applied this to its own storage, and echoing it back would
	 * apply it twice.
	 */
	resetTo(text, anchor, head) {
		this.doc.setText(text);
		const clamp = (n) => Math.max(0, Math.min(n ?? 0, this.doc.length));
		this.selections = [{ anchor: clamp(anchor), head: clamp(head ?? anchor) }];
		this.mainIndex = 0;
		this.marks = Object.create(null);
		this.$resynced = true;
	}

	indexFromPos(pos) {
		return this.doc.indexFromPos(pos);
	}

	posFromIndex(offset) {
		const p = this.doc.posFromIndex(offset);
		return new Pos(p.line, p.ch);
	}

	clipPos(p) {
		let ch = p.ch;
		let lineNumber = p.line + 1;
		if (lineNumber < 1) {
			lineNumber = 1;
			ch = 0;
		}
		if (lineNumber > this.doc.lineCount) {
			lineNumber = this.doc.lineCount;
			ch = Number.MAX_VALUE;
		}
		const line = this.doc.getLine(lineNumber - 1);
		ch = Math.min(Math.max(0, ch), line.length);
		return new Pos(lineNumber - 1, ch);
	}

	getRange(s, e) {
		return this.doc.slice(this.doc.indexFromPos(s), this.doc.indexFromPos(e));
	}

	/**
	 * The single write path. Everything the core changes funnels through here,
	 * so this is also where the edit journal, marks and selections are kept
	 * consistent — there is no second place a mutation can sneak in.
	 */
	replaceRange(text, s, e, origin) {
		if (!e) e = s;
		const from = this.doc.indexFromPos(s);
		const to = this.doc.indexFromPos(e);
		this._applyEdit(from, to, text, origin);
	}

	_applyEdit(from, to, insert, origin) {
		if (from === to && insert === "") return;
		this.edits.push({ from, to, insert });

		for (const id in this.marks) this.marks[id].update(from, to, insert.length);
		if (this.$lineHandleEdits) this.$lineHandleEdits.push({ from, to, insert });
		this.selections = this.selections.map((r) => ({
			anchor: mapOffset(r.anchor, from, to, insert.length),
			head: mapOffset(r.head, from, to, insert.length),
		}));
		if (this.virtualSelection) {
			this.virtualSelection = this.virtualSelection.map((r) => ({
				anchor: mapOffset(r.anchor, from, to, insert.length),
				head: mapOffset(r.head, from, to, insert.length),
			}));
		}

		this.doc.replace(from, to, insert);
		this._recordChange(from, insert, origin);
	}

	/** Build the CM5 change object the core reads for dot-repeat and macros. */
	_recordChange(fromB, insert, origin) {
		this.curOp ??= {};
		const curOp = this.curOp;
		if (curOp.$changeStart == null || curOp.$changeStart > fromB) {
			curOp.$changeStart = fromB;
		}
		this.$lastChangeEndOffset = fromB + insert.length;
		const change = { text: insert.split("\n"), origin };
		if (!curOp.lastChange) {
			curOp.lastChange = curOp.change = change;
		} else {
			curOp.lastChange.next = change;
			curOp.lastChange = change;
		}
		if (!curOp.changeHandlers) {
			curOp.changeHandlers = this._handlers.change?.slice();
		}
	}

	getLastEditEnd() {
		return this.posFromIndex(this.$lastChangeEndOffset);
	}

	/* -- selections ------------------------------------------------------- */

	getCursor(p) {
		const sel = this.selections[this.mainIndex];
		const offset =
			p === "head" || !p
				? sel.head
				: p === "anchor"
					? sel.anchor
					: p === "start"
						? Math.min(sel.anchor, sel.head)
						: p === "end"
							? Math.max(sel.anchor, sel.head)
							: null;
		if (offset == null) throw new Error("Invalid cursor type");
		return this.posFromIndex(offset);
	}

	setCursor(line, ch) {
		if (typeof line === "object") {
			ch = line.ch;
			line = line.line;
		}
		const offset = this.doc.indexFromPos({ line, ch: ch || 0 });
		this.selections = [{ anchor: offset, head: offset }];
		this.mainIndex = 0;
		this._onSelectionChange();
		if (this.curOp && !this.curOp.isVimOp) this.onBeforeEndOperation();
	}

	listSelections() {
		return this.selections.map((r) => ({
			anchor: this.posFromIndex(r.anchor),
			head: this.posFromIndex(r.head),
		}));
	}

	setSelections(ranges, primIndex) {
		this.selections = ranges.map((x) => ({
			anchor: this.doc.indexFromPos(x.anchor),
			head: this.doc.indexFromPos(x.head),
		}));
		this.mainIndex = primIndex || 0;
		this._onSelectionChange();
	}

	setSelection(anchor, head, options) {
		this.setSelections([{ anchor, head }], 0);
		if (options && options.origin === "*mouse") this.onBeforeEndOperation();
	}

	getSelection() {
		return this.getSelections().join("\n");
	}

	getSelections() {
		return this.selections.map((r) =>
			this.doc.slice(Math.min(r.anchor, r.head), Math.max(r.anchor, r.head)),
		);
	}

	somethingSelected() {
		return this.selections.some((r) => r.anchor !== r.head);
	}

	replaceSelection(text) {
		this.replaceSelections(this.selections.map(() => text));
	}

	/**
	 * Replace every selection. Applied last-to-first so each edit's offsets are
	 * still valid when it runs — the journal Swift replays keeps that order.
	 */
	replaceSelections(replacements) {
		const ordered = this.selections
			.map((r, i) => ({
				from: Math.min(r.anchor, r.head),
				to: Math.max(r.anchor, r.head),
				insert: replacements[i] || "",
			}))
			.sort((a, b) => b.from - a.from);
		const caretsReversed = [];
		for (const edit of ordered) {
			this._applyEdit(edit.from, edit.to, edit.insert);
			const caret = edit.from + edit.insert.length;
			caretsReversed.push({ anchor: caret, head: caret });
		}
		this.selections = caretsReversed.reverse();
		this.mainIndex = Math.min(this.mainIndex, this.selections.length - 1);
		this._onSelectionChange();
	}

	/**
	 * Replace mode (`R`): consume the character under the cursor instead of
	 * pushing it right. Upstream keeps this on the adapter because the CM6 view
	 * plugin, not the vim core, drives it; we are that plugin now.
	 */
	overWriteSelection(text) {
		this.selections = this.selections.map((r) => {
			if (r.anchor !== r.head) return r;
			const next = this.doc.slice(r.head, r.head + 1);
			return next && next !== "\n" ? { anchor: r.anchor, head: r.head + 1 } : r;
		});
		this.replaceSelection(text);
	}

	isInMultiSelectMode() {
		return this.selections.length > 1;
	}

	get inVirtualSelectionMode() {
		return !!this.virtualSelection;
	}

	virtualSelectionMode() {
		return !!this.virtualSelection;
	}

	forEachSelection(command) {
		const saved = this.selections.slice();
		this.virtualSelection = saved.slice();
		for (let i = 0; i < this.virtualSelection.length; i++) {
			const range = this.virtualSelection[i];
			if (!range) continue;
			this.selections = [range];
			this.mainIndex = 0;
			command();
			this.virtualSelection[i] = this.selections[0];
		}
		this.selections = this.virtualSelection;
		this.mainIndex = 0;
		this.virtualSelection = null;
		this._onSelectionChange();
	}

	moveH(increment, unit) {
		if (unit !== "char") return;
		const cur = this.getCursor();
		this.setCursor(cur.line, cur.ch + increment);
	}

	toggleOverwrite(on) {
		this.state.overwrite = on;
	}

	/* -- line handles (`:g`) ---------------------------------------------- */

	getLineHandle(row) {
		if (!this.$lineHandleEdits) this.$lineHandleEdits = [];
		return { row, index: this.indexFromPos(new Pos(row, 0)) };
	}

	getLineNumber(handle) {
		const edits = this.$lineHandleEdits;
		if (!edits) return null;
		let offset = handle.index;
		for (const e of edits) {
			offset = mapOffset(offset, e.from, e.to, e.insert.length, 1, true);
			if (offset == null) return null;
		}
		const pos = this.posFromIndex(offset);
		return pos.ch === 0 ? pos.line : null;
	}

	releaseLineHandles() {
		this.$lineHandleEdits = null;
	}

	/* -- search ------------------------------------------------------------ */

	/**
	 * CM5-shaped search cursor over the whole buffer.
	 *
	 * Upstream drives CodeMirror's `RegExpCursor` and has to pre-escape braces
	 * for it; a plain `RegExp` needs no such rewriting, so the query the core
	 * built is used as-is. The `m` flag makes `^`/`$` line anchors, matching
	 * what `/^foo` means in vim, and the absence of `s` keeps `.` off newlines.
	 */
	getSearchCursor(query, pos) {
		const doc = this.doc;
		const cm = this;
		let last = null;
		let lastResult = null;
		let afterEmptyMatch = false;
		if (pos.ch === undefined) pos.ch = Number.MAX_VALUE;
		const firstOffset = doc.indexFromPos(pos);
		const flags = `gm${query.ignoreCase ? "i" : ""}`;

		const matchAt = (text, from) => {
			const re = new RegExp(query.source, flags);
			re.lastIndex = from;
			const m = re.exec(text);
			return m ? { from: m.index, to: m.index + m[0].length, match: m } : null;
		};

		const lastMatchBefore = (limit) => {
			const text = doc.text;
			const re = new RegExp(query.source, flags);
			let best = null;
			let m = re.exec(text);
			while (m) {
				if (m.index >= limit) break;
				best = { from: m.index, to: m.index + m[0].length, match: m };
				if (re.lastIndex === m.index) re.lastIndex++;
				m = re.exec(text);
			}
			return best;
		};

		return {
			findNext() {
				return this.find(false);
			},
			findPrevious() {
				return this.find(true);
			},
			find(back) {
				if (back) {
					const endAt = last
						? afterEmptyMatch
							? last.to - 1
							: last.from
						: firstOffset;
					last = lastMatchBefore(Math.max(0, endAt));
				} else {
					const startFrom = last
						? afterEmptyMatch
							? last.to + 1
							: last.to
						: firstOffset;
					last = startFrom > doc.length ? null : matchAt(doc.text, startFrom);
				}
				lastResult = last && {
					from: cm.posFromIndex(last.from),
					to: cm.posFromIndex(last.to),
					match: last.match,
				};
				afterEmptyMatch = last ? last.from === last.to : false;
				return last?.match;
			},
			from() {
				return lastResult?.from;
			},
			to() {
				return lastResult?.to;
			},
			replace(text) {
				if (!last) return;
				cm._applyEdit(last.from, last.to, text);
				last.to = last.from + text.length;
				if (lastResult) lastResult.to = cm.posFromIndex(last.to);
			},
			get match() {
				return lastResult?.match;
			},
		};
	}

	addOverlay({ query }) {
		this.searchOverlay = query;
		return query;
	}

	removeOverlay() {
		this.searchOverlay = null;
	}

	/* -- brackets ---------------------------------------------------------- */

	scanForBracket(pos, dir, style, config) {
		return scanForBracket(this, pos, dir, style, config);
	}

	findMatchingBracket(pos, config) {
		// Upstream defers to CodeMirror's syntax-aware matcher. Without a parse
		// tree we scan the text, which is what `scanForBracket` already does for
		// the `i(`/`a{` text objects — same answer outside strings and comments.
		const line = this.getLine(pos.line);
		const ch = line.charAt(pos.ch);
		const forward = /[([{<]/.test(ch);
		const backward = /[)\]}>]/.test(ch);
		if (!forward && !backward) return { to: undefined };
		const found = scanForBracket(
			this,
			forward ? new Pos(pos.line, pos.ch + 1) : pos,
			forward ? 1 : -1,
			undefined,
			config,
		);
		return { to: found ? found.pos : undefined };
	}

	/**
	 * No syntax tree here, so nothing is reported as comment or string. The core
	 * uses this to keep `%` from matching a bracket inside a literal and to tune
	 * the quote text objects — both are code-editor concerns that do not arise
	 * in Markdown prose.
	 */
	getTokenTypeAt() {
		return "";
	}

	/* -- indentation, commands -------------------------------------------- */

	// `indentMore`/`indentLess` are deliberately absent: when they are missing
	// the core falls back to its own text-based indent, which is the behaviour
	// we want for Markdown (no language-aware indent unit to consult).

	indentLine(line, more) {
		const unit = " ".repeat(this.getOption("indentUnit") || 2);
		const text = this.getLine(line);
		if (more) {
			this.replaceRange(unit, new Pos(line, 0), new Pos(line, 0));
			return;
		}
		const existing = /^[ \t]*/.exec(text)[0];
		const drop = Math.min(existing.length, unit.length);
		if (drop > 0) this.replaceRange("", new Pos(line, 0), new Pos(line, drop));
	}

	execCommand(name) {
		const cur = this.getCursor();
		if (name === "goLineLeft") {
			this.setCursor(cur.line, 0);
		} else if (name === "goLineRight") {
			this.setCursor(cur.line, this.getLine(cur.line).length);
		} else if (name !== "indentAuto") {
			// indentAuto has no meaning without a language mode; anything else is
			// a command upstream added that we have not mapped yet.
			console.log(`${name} is not implemented`);
		}
	}

	hardWrap(options) {
		return hardWrap(this, options);
	}

	/* -- options ----------------------------------------------------------- */

	setOption(name, val) {
		if (name === "keyMap") this.state.keyMap = val;
		else if (name === "textwidth") this.state.textwidth = val;
		else this.options[name] = val;
	}

	getOption(name) {
		switch (name) {
			case "firstLineNumber":
				return 1;
			case "tabSize":
				return this.options.tabSize ?? 4;
			case "readOnly":
				return this.options.readOnly ?? false;
			case "indentWithTabs":
				return this.options.indentWithTabs ?? false;
			case "indentUnit":
				return this.options.indentUnit ?? 2;
			case "textwidth":
				return this.state.textwidth;
			case "keyMap":
				return this.state.keyMap || "vim";
			default:
				return this.options[name];
		}
	}

	/* -- geometry (host-backed) ------------------------------------------- */

	_geometry(request) {
		return this.host?.geometry ? this.host.geometry(request) : null;
	}

	defaultTextHeight() {
		return (
			this._geometry({ kind: "lineHeight" })?.lineHeight ?? FALLBACK_LINE_HEIGHT
		);
	}

	charCoords(pos, mode) {
		const offset = this.doc.indexFromPos(pos);
		const answer = this._geometry({ kind: "charCoords", offset, mode });
		if (answer) return answer;
		const p = this.doc.posFromIndex(offset);
		const top = p.line * FALLBACK_LINE_HEIGHT;
		return {
			left: p.ch * FALLBACK_CHAR_WIDTH,
			top,
			bottom: top + FALLBACK_LINE_HEIGHT,
		};
	}

	coordsChar(coords, mode) {
		const answer = this._geometry({ kind: "coordsChar", coords, mode });
		if (answer) return this.posFromIndex(answer.offset);
		const line = Math.max(
			0,
			Math.min(this.lastLine(), Math.floor(coords.top / FALLBACK_LINE_HEIGHT)),
		);
		const ch = Math.max(0, Math.round(coords.left / FALLBACK_CHAR_WIDTH));
		return this.clipPos(new Pos(line, ch));
	}

	getScrollInfo() {
		const answer = this._geometry({ kind: "scrollInfo" });
		if (answer) return answer;
		const height = this.doc.lineCount * FALLBACK_LINE_HEIGHT;
		return {
			left: 0,
			top: 0,
			height,
			width: 0,
			clientHeight: FALLBACK_VIEWPORT_HEIGHT,
			clientWidth: 0,
		};
	}

	scrollTo(x, y) {
		this.$scrollRequest = { kind: "scrollTo", x, y };
	}

	scrollIntoView(pos, margin) {
		this.$scrollRequest = {
			kind: "scrollIntoView",
			offset: pos ? this.doc.indexFromPos(pos) : null,
			margin,
		};
	}

	/**
	 * Vertical motion. Without the text view we move by document line, so a
	 * soft-wrapped line counts once — `j` on a wrapped paragraph jumps the whole
	 * paragraph rather than one visual row. The host overrides this when it can,
	 * because only it knows the wrap points.
	 */
	findPosV(start, amount, unit, goalColumn) {
		const answer = this._geometry({
			kind: "findPosV",
			offset: this.doc.indexFromPos(start),
			amount,
			unit,
			goalColumn,
		});
		if (answer) {
			const pos = this.posFromIndex(answer.offset);
			if (answer.hitSide) pos.hitSide = true;
			return pos;
		}
		const perStep =
			unit === "page"
				? Math.max(
						1,
						Math.floor(
							this.getScrollInfo().clientHeight / this.defaultTextHeight(),
						),
					)
				: 1;
		let line = start.line + amount * perStep;
		let hitSide = false;
		if (line < this.firstLine()) {
			line = this.firstLine();
			hitSide = true;
		}
		if (line > this.lastLine()) {
			line = this.lastLine();
			hitSide = true;
		}
		const goal =
			goalColumn == null
				? start.ch
				: Math.round(goalColumn / FALLBACK_CHAR_WIDTH);
		const pos = new Pos(line, Math.min(goal, this.getLine(line).length));
		if (hitSide) pos.hitSide = true;
		return pos;
	}

	/* -- marks ------------------------------------------------------------- */

	setBookmark(cursor, options) {
		return new Marker(
			this,
			this.indexFromPos(cursor),
			options?.insertLeft ? 1 : -1,
		);
	}

	/* -- prompts and messages --------------------------------------------- */

	/**
	 * The `:` / `/` line. Upstream builds a real input element; we hand the
	 * prompt to the host as text and let `RectoVim.promptKey()` feed it, so the
	 * status bar owns the editing and JS owns the vim semantics.
	 */
	openDialog(template, callback, options) {
		// Not every dialog takes input. Macro recording opens one just to show
		// "recording @q", and upstream only wires key handling when the template
		// actually contains an input — treating that banner as a prompt would
		// swallow every key of the macro being recorded.
		if (!template?.getElementsByTagName?.("input").length) {
			return this.openNotification(template, { duration: 0 });
		}
		this.$prompt = new Prompt(this, template, callback, options);
		return this.$prompt.close.bind(this.$prompt);
	}

	openNotification(template, options) {
		this.$notification = {
			text: template?.textContent ?? String(template ?? ""),
			duration: options?.duration ?? 5000,
		};
		return () => {
			this.$notification = null;
		};
	}

	focus() {}

	getInputField() {
		return this.$inputField;
	}

	/* -- operations -------------------------------------------------------- */

	on(type, f) {
		on(this, type, f);
	}

	off(type, f) {
		off(this, type, f);
	}

	signal(type, e, handlers) {
		signal(this, type, e, handlers);
	}

	_onSelectionChange() {
		this.curOp ??= {};
		const curOp = this.curOp;
		if (!curOp.cursorActivityHandlers) {
			curOp.cursorActivityHandlers = this._handlers.cursorActivity?.slice();
		}
		curOp.cursorActivity = true;
	}

	operation(fn) {
		if (!this.curOp) this.curOp = { $d: 0 };
		this.curOp.$d = (this.curOp.$d || 0) + 1;
		try {
			return fn();
		} finally {
			if (this.curOp) {
				this.curOp.$d--;
				if (!this.curOp.$d) this.onBeforeEndOperation();
			}
		}
	}

	onBeforeEndOperation() {
		const op = this.curOp;
		let scrollIntoView = false;
		if (op) {
			if (op.change) signalTo(op.changeHandlers, this, op.change);
			if (op.cursorActivity) {
				signalTo(op.cursorActivityHandlers, this, null);
				if (op.isVimOp) scrollIntoView = true;
			}
			this.curOp = null;
		}
		if (scrollIntoView) this.scrollIntoView();
	}

	/* -- host handoff ------------------------------------------------------ */

	/** Drain the edit journal. Called once per key, after the core has run. */
	takeEdits() {
		const edits = this.edits;
		this.edits = [];
		return edits;
	}
}

/* Statics the core reaches for as `CM.*`. */
RectoCM.Pos = Pos;
RectoCM.StringStream = StringStream;
RectoCM.isMac = true;
RectoCM.on = on;
RectoCM.off = off;
RectoCM.signal = signal;
RectoCM.keyName = undefined;
RectoCM.isWordChar = (ch) => wordChar.test(ch);
RectoCM.e_stop = (e) => {
	e?.stopPropagation?.();
	e?.preventDefault?.();
};
RectoCM.e_preventDefault = (e) => e?.preventDefault?.();
RectoCM.addClass = () => {};
RectoCM.rmClass = () => {};
// Upstream also returns null here — HTML tag objects (`it`, `at`) need a parse
// tree it does not have either. Markdown documents do not use them.
RectoCM.findMatchingTag = () => null;
RectoCM.findEnclosingTag = () => undefined;
RectoCM.keys = {
	Left: (cm) => cm.moveH(-1, "char"),
	Right: (cm) => cm.moveH(1, "char"),
	Up: (cm) => cm.setCursor(cm.findPosV(cm.getCursor(), -1, "line")),
	Down: (cm) => cm.setCursor(cm.findPosV(cm.getCursor(), 1, "line")),
	Backspace: (cm) => {
		const cur = cm.getCursor();
		const offset = cm.indexFromPos(cur);
		if (offset > 0) cm._applyEdit(offset - 1, offset, "");
	},
	Delete: (cm) => {
		const cur = cm.getCursor();
		const offset = cm.indexFromPos(cur);
		if (offset < cm.doc.length) cm._applyEdit(offset, offset + 1, "");
	},
};
// `map` is part of upstream's signature; the core passes its keymap and we
// only ever resolve against `RectoCM.keys`.
RectoCM.lookupKey = (key, _map, handle) => {
	let result = RectoCM.keys[key];
	if (!result && /^Arrow/.test(key)) result = RectoCM.keys[key.slice(5)];
	if (result) handle(result);
};
RectoCM.commands = {
	cursorCharLeft: (cm) => cm.moveH(-1, "char"),
	// `u` / `Ctrl-r` do not run vim's own history. On the web they are remapped
	// to the document's undo tree (lib/editor/codemirror/index.tsx); natively the
	// host owns undo for the same reason, so both route out of JS entirely.
	undo: (cm) => cm.host?.historyCommand?.("undo", cm),
	redo: (cm) => cm.host?.historyCommand?.("redo", cm),
	newlineAndIndent: (cm) => {
		const cur = cm.getCursor();
		const indent = /^[ \t]*/.exec(cm.getLine(cur.line))[0];
		cm.replaceSelection(`\n${indent}`);
	},
	indentAuto: () => {},
	newlineAndIndentContinueComment: undefined,
	save: undefined,
};
