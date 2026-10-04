/**
 * A line-array mirror of the text view's string.
 *
 * The vim core reads the buffer constantly — `getLine`, `getRange`, `getCursor`
 * and friends run dozens of times for a single keystroke — but it writes rarely.
 * If every one of those reads crossed into Swift the bridge would dominate the
 * per-key cost, so JS keeps its own copy and only *edits* travel back. Swift
 * replays the edit list onto the NSTextStorage; the two strings stay identical
 * because both apply the same ops in the same order.
 *
 * **The document is the string.** Line endings are stored exactly as they
 * arrived, never normalised. CodeMirror 6 normalises before the vim core sees a
 * document and this mirror did too, until that turned out to break the one
 * invariant the whole design rests on: given `a\r\nb`, a normalising mirror
 * holds `a\nb` and reports `x` on line 2 as `{from: 2, to: 3}`, which against
 * the native storage deletes the `\n` of the CRLF instead of the `b`. Both
 * sides have to be indexing the same string.
 *
 * The line array is the source of truth; the flat string and the offset index
 * are caches rebuilt on demand. Two measured decisions are baked in here, both
 * from the 950 kB benchmark in `RectoVimPerfTests` (p95 CPU per keystroke):
 *
 *   - Splicing only the lines an edit touches, instead of re-splitting the
 *     whole buffer: 1.42 ms -> 0.54 ms.
 *   - Rebuilding the offset index lazily rather than patching it in place.
 *     Patching sounds cheaper but measured worse (0.86 ms vs 0.54 ms): it walks
 *     the tail eagerly on every edit, while the rebuild is one tight
 *     typed-array loop that runs once however many edits a command made. That
 *     only holds while a command makes *one* edit, which is why `replaceAt`
 *     exists — see `RectoCM.replaceSelections`.
 *
 * Offsets are UTF-16 code units throughout, which is what JS string indices and
 * `NSRange` both already are, so an offset produced here drops straight into an
 * `NSRange` with no conversion. Astral characters (emoji, some CJK extensions)
 * are two units wide in both worlds; see README "Coordinates" for where that
 * still bites.
 */

/** @typedef {{line: number, ch: number}} Pos */

/** The three line endings. `\r\n` is one ending and two code units. */
const LINE_ENDING = /\r\n|\n|\r/g;

/**
 * Split into content lines and the ending that followed each one.
 *
 * The last entry always has an empty ending, so `lines.length` equals
 * `endings.length` and a document ending in a newline has a final empty line —
 * exactly what `split("\n")` produced before, and what vim means by "the last
 * line".
 *
 * @param {string} text
 */
export function splitLines(text) {
	const lines = [];
	const endings = [];
	let at = 0;
	LINE_ENDING.lastIndex = 0;
	let match = LINE_ENDING.exec(text);
	while (match) {
		lines.push(text.slice(at, match.index));
		endings.push(match[0]);
		at = match.index + match[0].length;
		match = LINE_ENDING.exec(text);
	}
	lines.push(text.slice(at));
	endings.push("");
	return { lines, endings };
}

/**
 * Whether a string is exactly one line ending. `Intl.Segmenter` reports `\r\n`
 * as one cluster, so a caller stepping by cluster gets the whole thing.
 *
 * @param {string} text
 */
export function isLineEnding(text) {
	return text === "\n" || text === "\r\n" || text === "\r";
}

export class RectoDoc {
	/** @param {string} text */
	constructor(text) {
		this.setText(text);
	}

	/** @param {string} text */
	setText(text) {
		const split = splitLines(text);
		this.lines = split.lines;
		this.endings = split.endings;
		this._invalidate();
	}

	_invalidate() {
		/** @type {string | null} */
		this._text = null;
		/** @type {Int32Array | null} */
		this._starts = null;
	}

	/** Flat buffer. Materialised on demand — search and `getValue` are the users. */
	get text() {
		if (this._text === null) {
			const parts = [];
			for (let i = 0; i < this.lines.length; i++) {
				parts.push(this.lines[i], this.endings[i]);
			}
			this._text = parts.join("");
		}
		return this._text;
	}

	get lineCount() {
		return this.lines.length;
	}

	get length() {
		const starts = this._lineStarts();
		const last = this.lines.length - 1;
		return starts[last] + this.lines[last].length;
	}

	/**
	 * Prefix sums of line start offsets. `Int32Array` because this is rebuilt
	 * after every edit and reaches ~14,000 entries on a 950 kB document, where
	 * unboxed integers are worth real time. It was the hottest thing per
	 * keystroke when profiled (36% of the time).
	 */
	_lineStarts() {
		if (this._starts) return this._starts;
		const n = this.lines.length;
		const starts = new Int32Array(n);
		let at = 0;
		for (let i = 0; i < n; i++) {
			starts[i] = at;
			at += this.lines[i].length + this.endings[i].length;
		}
		this._starts = starts;
		return starts;
	}

	/**
	 * The ending to use for a line break vim inserts (`o`, `O`, `<CR>`, a put,
	 * a paste): the first ending in the buffer, LF while there is none.
	 *
	 * This is the host storage's policy exactly — `MarkdownLineEnding(detecting:)`
	 * scans for the first ending the same way — so bytes the mirror writes are
	 * bytes the storage keeps. Using the edited line's own ending instead meant
	 * a mixed-ending document had the two sides disagree: the mirror wrote the
	 * minority line's LF, the storage rewrote it to the majority CRLF, and the
	 * reconcile resync kicked insert mode out mid-session.
	 */
	documentEnding() {
		for (const ending of this.endings)
			if (ending) return ending === "\r\n" ? "\r\n" : "\n";
		return "\n";
	}

	/** @param {number} row */
	getLine(row) {
		if (row < 0 || row >= this.lines.length) return "";
		return this.lines[row];
	}

	/**
	 * Clamp-and-convert, matching upstream `indexFromPos` exactly: an out-of-range
	 * line snaps to the first/last line and `ch` is clamped to that line's length.
	 * The vim core relies on this being total — it hands over positions past the
	 * end of a line all the time (`$`, `Number.MAX_VALUE` for "end of line").
	 * @param {Pos} pos
	 */
	indexFromPos(pos) {
		let ch = pos.ch;
		let lineNumber = pos.line + 1;
		if (lineNumber < 1) {
			lineNumber = 1;
			ch = 0;
		}
		if (lineNumber > this.lines.length) {
			lineNumber = this.lines.length;
			ch = Number.MAX_VALUE;
		}
		const starts = this._lineStarts();
		const from = starts[lineNumber - 1];
		const to = from + this.lines[lineNumber - 1].length;
		return Math.min(from + Math.max(0, ch), to);
	}

	/**
	 * `ch` is clamped into the line's *content*, so an offset landing between the
	 * `\r` and the `\n` of a CRLF resolves to the end of that line rather than to
	 * a column that does not exist.
	 *
	 * @param {number} offset
	 * @returns {Pos}
	 */
	posFromIndex(offset) {
		const starts = this._lineStarts();
		const clamped = Math.max(0, Math.min(offset, this.length));
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= clamped) lo = mid;
			else hi = mid - 1;
		}
		return {
			line: lo,
			ch: Math.min(clamped - starts[lo], this.lines[lo].length),
		};
	}

	/** @param {number} from @param {number} to */
	slice(from, to) {
		const start = this.posFromIndex(from);
		const end = this.posFromIndex(to);
		if (start.line === end.line) {
			return this.lines[start.line].slice(start.ch, end.ch);
		}
		const parts = [
			this.lines[start.line].slice(start.ch),
			this.endings[start.line],
		];
		for (let i = start.line + 1; i < end.line; i++) {
			parts.push(this.lines[i], this.endings[i]);
		}
		parts.push(this.lines[end.line].slice(0, end.ch));
		return parts.join("");
	}

	/**
	 * Apply one replacement in offset space, splicing only the affected lines.
	 * @param {number} from @param {number} to @param {string} insert
	 */
	replace(from, to, insert) {
		this.replaceAt(this.posFromIndex(from), this.posFromIndex(to), insert);
	}

	/**
	 * The same replacement, addressed by position instead of by offset.
	 *
	 * Resolving an offset needs the line index and every edit invalidates it, so
	 * a command making N edits through `replace` rebuilds the index N times —
	 * 164 ms for a 1,000-selection visual-block edit on a 20,000-line document.
	 * `RectoCM.replaceSelections` resolves every position first, against a single
	 * index build, then applies the edits back-to-front so those positions are
	 * still valid when their turn comes.
	 *
	 * @param {Pos} start @param {Pos} end @param {string} insert
	 */
	replaceAt(start, end, insert) {
		const head = this.lines[start.line].slice(0, start.ch);
		const tail = this.lines[end.line].slice(end.ch);
		// The replaced span ends inside `end.line`, so whatever ended that line
		// still ends the last line of the replacement.
		const tailEnding = this.endings[end.line];
		const replacement = splitLines(head + insert + tail);
		replacement.endings[replacement.endings.length - 1] = tailEnding;
		const removedLines = end.line - start.line + 1;

		if (replacement.lines.length > 30000) {
			this.lines = this.lines
				.slice(0, start.line)
				.concat(replacement.lines, this.lines.slice(end.line + 1));
			this.endings = this.endings
				.slice(0, start.line)
				.concat(replacement.endings, this.endings.slice(end.line + 1));
		} else {
			this.lines.splice(start.line, removedLines, ...replacement.lines);
			this.endings.splice(start.line, removedLines, ...replacement.endings);
		}
		this._invalidate();
	}
}
