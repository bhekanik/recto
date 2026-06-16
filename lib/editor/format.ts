/**
 * Editor-agnostic formatting commands. The chrome (top toolbar) and the
 * in-editor floating selection bar both emit these; the active editor listens
 * and applies them in its own idiom (Milkdown → ProseMirror commands, CodeMirror
 * → Markdown wrapping, Preview → ignored). One vocabulary, every surface.
 */
export type FormatCommand =
	| "bold"
	| "italic"
	| "strike"
	| "code"
	| "link"
	| "h1"
	| "h2"
	| "h3"
	| "paragraph"
	| "quote"
	| "bulletList"
	| "orderedList"
	| "codeBlock";

export const FORMAT_EVENT = "recto:format";

export type FormatEventDetail = {
	command: FormatCommand;
	href?: string;
};

/** Fire a formatting command at whichever editor is currently active. */
export function dispatchFormat(
	command: FormatCommand,
	detail?: Omit<FormatEventDetail, "command">,
): void {
	window.dispatchEvent(
		new CustomEvent<FormatEventDetail>(FORMAT_EVENT, {
			detail: { command, ...detail },
		}),
	);
}
