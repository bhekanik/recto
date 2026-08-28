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
		this.text = text.replace(/\r\n?/g, "\n");
		this.lines = this.text.split("\n");
		/** @type {number[] | null} */
		this._starts = null;
	}

	get lineCount() {
		return this.lines.length;
	}

	get length() {
		return this.text.length;
	}

	/** Prefix sums of line start offsets, rebuilt lazily after each edit. */
	_lineStarts() {
		if (this._starts) return this._starts;
		const starts = new Array(this.lines.length);
		let at = 0;
		for (let i = 0; i < this.lines.length; i++) {
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
		const clamped = Math.max(0, Math.min(offset, this.text.length));
		// Binary search for the line containing `clamped`.
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
		return this.text.slice(from, to);
	}

	/**
	 * Apply one replacement in offset space and keep the line array in step.
	 * @param {number} from @param {number} to @param {string} insert
	 */
	replace(from, to, insert) {
		this.text = this.text.slice(0, from) + insert + this.text.slice(to);
		this.lines = this.text.split("\n");
		this._starts = null;
	}
}
