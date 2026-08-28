/** CM5-style buffer position. `ch` counts UTF-16 code units, like NSRange. */
export class Pos {
	/** @param {number} line @param {number} ch */
	constructor(line, ch) {
		this.line = line;
		this.ch = ch;
	}
}
