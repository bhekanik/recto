/**
 * The Swift side of the bridge, as JS sees it.
 *
 * Everything here is a *pull*: JS asks the host a question mid-keystroke and
 * blocks on the answer. That is only acceptable because these calls are rare —
 * the editing commands never reach them. The common path (a motion, an
 * operator, an insert) answers entirely from the JS-side mirror and reports its
 * result once, as the return value of `handleKey`.
 *
 * Arguments and replies cross as JSON strings rather than as objects. Reading
 * a property off a `JSValue` is a bridge crossing of its own, so a five-field
 * dictionary costs five crossings plus boxing, whereas a string costs one and
 * `JSONDecoder` handles the rest on the Swift side.
 *
 * @typedef {object} RawVimHost
 * @property {(requestJson: string) => string | null} [geometry]
 *   Answers layout questions the text view alone can answer: `charCoords`,
 *   `coordsChar`, `scrollInfo`, `lineHeight`, `findPosV`. Returning null (or
 *   omitting the method) makes the adapter fall back to fixed metrics, which is
 *   what the headless keystroke suite runs on.
 * @property {(kind: "undo" | "redo") => string | null} [historyCommand]
 *   `u` and `<C-r>`. The host owns undo — natively that is the document's undo
 *   tree, exactly as `u` is remapped on the web — so it performs the change
 *   itself and returns the resulting `{text, anchor, head}` for JS to resync to.
 *   No edits are emitted for these keys; the host already applied them.
 * @property {() => string} [clipboardRead]
 * @property {(text: string) => void} [clipboardWrite]
 *   The `"+` / `"*` registers, backed by NSPasteboard/UIPasteboard.
 */

/**
 * Wraps a raw host (a `JSExport` object from Swift, or a plain object in tests)
 * so the adapter can deal in objects while the wire stays strings.
 *
 * @param {RawVimHost | null} raw
 */
export function wrapHost(raw) {
	if (!raw) return null;
	return {
		geometry(request) {
			if (!raw.geometry) return null;
			const answer = raw.geometry(JSON.stringify(request));
			return answer ? JSON.parse(answer) : null;
		},
		historyCommand(kind, cm) {
			if (!raw.historyCommand) return;
			const answer = raw.historyCommand(kind);
			if (!answer) return;
			const { text, anchor, head } = JSON.parse(answer);
			cm.resetTo(text, anchor, head);
		},
		clipboard: {
			read: () => raw.clipboardRead?.() ?? "",
			write: (text) => raw.clipboardWrite?.(text),
		},
	};
}
