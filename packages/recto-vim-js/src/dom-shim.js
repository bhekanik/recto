/**
 * The smallest DOM that keeps the vim core happy inside JavaScriptCore.
 *
 * JSC is a bare ECMAScript engine: no `document`, no `window`, not even
 * `setTimeout`. The extracted core touches exactly four host things, and only
 * four, which is why this file is short rather than a browser emulation:
 *
 *   1. `document.createElement` / `createTextNode`, via the core's own `dom()`
 *      helper, used to build the `:`/`/` prompt and the message line. Both are
 *      text in our status bar, so nodes only have to remember their text.
 *   2. `window.setTimeout` / `clearTimeout`, for the insert-mode escape-key
 *      timeout (`jk`-style mappings). Real timers, driven by the host.
 *   3. `navigator.clipboard`, for the `"+` / `"*` registers. Forwarded to
 *      NSPasteboard/UIPasteboard. `readText` must return a promise, and vim
 *      reads the result asynchronously, so a paste from the system clipboard
 *      lands one turn later — see README "Clipboard".
 *   4. `navigator.platform`, read once to decide Mac-style key names.
 *
 * Anything the core does not touch is deliberately absent: if a future upstream
 * version reaches for more DOM, we want a loud `undefined is not an object`
 * during the keystroke suite, not a silent wrong answer from a fake.
 */

class ShimNode {
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.tag = tag;
		this.children = [];
		this.attrs = {};
		this.style = {};
		this.value = "";
		this.parentElement = null;
	}

	appendChild(child) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	replaceChild(next, prev) {
		const i = this.children.indexOf(prev);
		if (i >= 0) {
			this.children[i] = next;
			next.parentElement = this;
			prev.parentElement = null;
		}
	}

	remove() {
		this.parentElement?.children.splice(
			this.parentElement.children.indexOf(this),
			1,
		);
		this.parentElement = null;
	}

	setAttribute(key, value) {
		this.attrs[key] = value;
	}

	contains(other) {
		if (other === this) return true;
		return this.children.some((c) => c.contains?.(other));
	}

	getElementsByTagName(tag) {
		const want = tag.toLowerCase();
		const out = [];
		const walk = (node) => {
			if (node.tag === want) out.push(node);
			for (const child of node.children || []) walk(child);
		};
		walk(this);
		return out;
	}

	/** Input stand-ins get focus/select called on them; both are no-ops here. */
	focus() {}
	blur() {}
	select() {}

	get textContent() {
		return this.children.map((c) => c.textContent).join("");
	}
}

class ShimText {
	constructor(text) {
		this.tag = "#text";
		this.nodeType = 3;
		this.children = [];
		this.text = String(text);
		this.parentElement = null;
	}
	get textContent() {
		return this.text;
	}
	contains() {
		return false;
	}
}

// The core checks `a.nodeType` to tell a child node from an attribute bag.
ShimNode.prototype.nodeType = 1;

/**
 * @param {object} target the global object to install onto
 * @param {{clipboard?: {read: () => string, write: (t: string) => void},
 *          isMac?: boolean}} [hooks]
 */
export function installDomShim(target, hooks = {}) {
	if (typeof target.setTimeout !== "function") {
		// JSC has no timer at all. Queue callbacks and let the host drain them;
		// the only user is the insert-mode escape timeout, which is allowed to
		// be approximate but must eventually fire or `jk` mappings wedge.
		const pending = new Map();
		let nextId = 1;
		target.__rectoTimers = pending;
		target.setTimeout = (fn, ms) => {
			const id = nextId++;
			pending.set(id, { fn, dueAt: Date.now() + (ms || 0) });
			return id;
		};
		target.clearTimeout = (id) => {
			pending.delete(id);
		};
		/** Host calls this on a tick to fire anything due. */
		target.__rectoDrainTimers = () => {
			const now = Date.now();
			for (const [id, t] of [...pending]) {
				if (t.dueAt <= now) {
					pending.delete(id);
					t.fn();
				}
			}
		};
	}

	target.document = {
		createElement: (tag) => new ShimNode(tag),
		createTextNode: (text) => new ShimText(text),
		activeElement: null,
	};

	target.window = target;

	const clipboard = hooks.clipboard;
	target.navigator = {
		platform: hooks.isMac === false ? "Linux x86_64" : "MacIntel",
		clipboard: {
			readText: () => Promise.resolve(clipboard ? clipboard.read() : ""),
			writeText: (text) => {
				clipboard?.write(text);
				return Promise.resolve();
			},
		},
	};

	return target;
}

export { ShimNode, ShimText };
