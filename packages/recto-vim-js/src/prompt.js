/**
 * The `:` and `/` line.
 *
 * Upstream builds a real `<input>` and lets the browser handle typing. Here the
 * status bar is a Swift view, so the prompt keeps its own string and the host
 * forwards keys into `handleKey`. The event contract is upstream's: `onKeyDown`
 * first and it may swallow the key (that is how `<Up>` walks search history and
 * `<Esc>` cancels), Enter runs the callback, `onKeyUp` drives incremental
 * search highlighting.
 */

/** Text of everything before the input — the `:` or `/` vim shows as a prefix. */
function prefixText(template, input) {
	let out = "";
	let stop = false;
	const walk = (node) => {
		if (stop || !node) return;
		if (node === input) {
			stop = true;
			return;
		}
		if (node.tag === "#text") {
			out += node.textContent;
			return;
		}
		for (const child of node.children || []) walk(child);
	};
	walk(template);
	return out;
}

export class Prompt {
	constructor(cm, template, callback, options) {
		this.cm = cm;
		this.callback = callback;
		this.options = options || {};
		this.input = template?.getElementsByTagName?.("input")[0] ?? { value: "" };
		this.prefix = prefixText(template, this.input);
		this.closed = false;
		if (this.options.value) this.input.value = this.options.value;
		if (this.input.value == null) this.input.value = "";
	}

	get value() {
		return this.input.value || "";
	}

	set value(v) {
		this.input.value = v;
	}

	/**
	 * @param {{key?: string, keyCode: number, ctrlKey?: boolean, altKey?: boolean,
	 *          metaKey?: boolean, shiftKey?: boolean}} event
	 */
	handleKey(event) {
		const close = this.close.bind(this);
		let prevented = false;
		const e = {
			key: event.key,
			keyCode: event.keyCode,
			ctrlKey: !!event.ctrlKey,
			altKey: !!event.altKey,
			metaKey: !!event.metaKey,
			shiftKey: !!event.shiftKey,
			preventDefault() {
				prevented = true;
			},
			stopPropagation() {},
		};

		if (this.options.onKeyDown?.(e, this.value, close)) return;
		if (prevented || this.closed) return;

		if (event.keyCode === 13) {
			const value = this.value;
			this.close();
			this.callback?.(value);
			return;
		}
		if (event.keyCode === 27) {
			this.close();
			return;
		}
		if (event.keyCode === 8) {
			this.value = this.value.slice(0, -1);
		} else if (event.key && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
			this.value += event.key;
		}
		this.options.onKeyUp?.(e, this.value, close);
	}

	/** Upstream's `close(newVal)`: a string sets the field, anything else closes. */
	close(newVal) {
		if (typeof newVal === "string") {
			this.value = newVal;
			return;
		}
		if (this.closed) return;
		this.closed = true;
		if (this.cm.$prompt === this) this.cm.$prompt = null;
		this.options.onClose?.(this);
	}
}
