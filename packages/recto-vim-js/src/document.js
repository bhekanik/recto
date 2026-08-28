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
 * The line array is the source of truth; the flat string and the offset index
 * are caches rebuilt on demand. Two measured decisions are baked in here, both
 * from the 950 kB benchmark in `VimSpikeSuite` (p95 CPU per keystroke):
 *
 *   - Splicing only the lines an edit touches, instead of re-splitting the
 *     whole buffer: 1.42 ms -> 0.54 ms.
 *   - Rebuilding the offset index lazily rather than patching it in place.
 *     Patching sounds cheaper but measured worse (0.86 ms vs 0.54 ms): it walks
 *     the tail eagerly on every edit, while the rebuild is one tight
 *     typed-array loop that runs once however many edits a command made.
 *
 * Offsets are UTF-16 code units throughout, which is what JS string indices and
 * `NSRange` both already are, so an offset produced here drops straight into an
 * `NSRange` with no conversion. Astral characters (emoji, some CJK extensions)
 * are two units wide in both worlds; see README "Coordinates" for where that
 * still bites.
 */

/** @typedef {{line: number, ch: number}} Pos */

export class RectoDoc {
	/** @param {string} text */
	constructor(text) {
		this.setText(text);
	}

	/** @param {string} text */
	setText(text) {
		// CM6 normalises line endings before the vim core ever sees them; do the
		// same so a CRLF document does not produce phantom \r at line ends.
		this.lines = text.replace(/\r\n?/g, "\n").split("\n");
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
		if (this._text === null) this._text = this.lines.join("\n");
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
			at += this.lines[i].length + 1; // +1 for the newline
		}
		this._starts = starts;
		return starts;
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

	/** @param {number} offset @returns {Pos} */
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
		return { line: lo, ch: clamped - starts[lo] };
	}

	/** @param {number} from @param {number} to */
	slice(from, to) {
		const start = this.posFromIndex(from);
		const end = this.posFromIndex(to);
		if (start.line === end.line) {
			return this.lines[start.line].slice(start.ch, end.ch);
		}
		const parts = [this.lines[start.line].slice(start.ch)];
		for (let i = start.line + 1; i < end.line; i++) parts.push(this.lines[i]);
		parts.push(this.lines[end.line].slice(0, end.ch));
		return parts.join("\n");
	}

	/**
	 * Apply one replacement in offset space, splicing only the affected lines.
	 * @param {number} from @param {number} to @param {string} insert
	 */
	replace(from, to, insert) {
		const start = this.posFromIndex(from);
		const end = this.posFromIndex(to);
		const head = this.lines[start.line].slice(0, start.ch);
		const tail = this.lines[end.line].slice(end.ch);
		const replacement = (head + insert + tail).split("\n");
		const removedLines = end.line - start.line + 1;

		if (replacement.length > 30000) {
			this.lines = this.lines
				.slice(0, start.line)
				.concat(replacement, this.lines.slice(end.line + 1));
		} else {
			this.lines.splice(start.line, removedLines, ...replacement);
		}
		this._invalidate();
	}
}
