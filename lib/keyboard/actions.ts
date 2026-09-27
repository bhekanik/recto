/**
 * The single application action registry (blueprint 13 §7.3.4). The capture-phase
 * chord handler and the cmdk command palette both surface these — one
 * implementation per action, two surfaces. The palette reads the shortcut hints
 * from here so they always match the real chord.
 */

export type ActionSection =
	| "Documents"
	| "Modes"
	| "Format"
	| "Panes"
	| "Navigate"
	| "History"
	| "Review"
	| "AI"
	| "Copy/Export"
	| "View"
	| "Theme";

export type ActionId =
	| "new-document"
	| "open-in-mac-app"
	| "mode-rich"
	| "mode-raw"
	| "mode-vim"
	| "mode-preview"
	| "cycle-next"
	| "cycle-prev"
	| "split-v"
	| "split-h"
	| "close-pane"
	| "focus-next"
	| "focus-prev"
	| "go-to-heading"
	| "toggle-outline"
	| "checkpoint"
	| "undo-tree"
	| "version-history"
	| "undo"
	| "redo"
	| "manage-sharing"
	| "review-surface"
	| "toggle-comments"
	| "add-comment"
	| "ai-transform"
	| "ai-critique"
	| "ai-related"
	| "ai-reindex"
	| "toggle-ai"
	| "toggle-transform-mode"
	| "copy-rich"
	| "copy-markdown"
	| "export-md"
	| "export-html"
	| "export-docx"
	| "find-replace"
	| "toggle-status"
	| "toggle-focus"
	| "toggle-font"
	| "zoom-in"
	| "zoom-out"
	| "zoom-reset"
	| "toggle-spellcheck"
	| "toggle-lint-passive"
	| "toggle-lint-readability"
	| "toggle-lint-adverb"
	| "toggle-lint-weasel"
	| "toggle-smart-paste"
	| "toggle-toolbar"
	| "toggle-typewriter"
	| "toggle-focus-dim"
	| "toggle-focus-blur"
	| "toggle-quiet-chrome"
	| FormatActionId
	| "cycle-dim-scope"
	| "toggle-email-preview"
	| "set-goal"
	| "toggle-goal-style"
	| "toggle-goal-scope"
	| "appearance-system"
	| "appearance-light"
	| "appearance-dark"
	| "theme-twilight"
	| "theme-aurora"
	| "theme-dawn"
	| "theme-moonlit";

/** The formatting toolbar's commands, as `format-<command>` (the Mac app's ids). */
export type FormatActionId =
	| "format-bold"
	| "format-italic"
	| "format-strike"
	| "format-code"
	| "format-link"
	| "format-h1"
	| "format-h2"
	| "format-h3"
	| "format-quote"
	| "format-bulletList"
	| "format-orderedList"
	| "format-codeBlock";

export type ActionDef = {
	id: ActionId;
	label: string;
	section: ActionSection;
	aliases?: string[];
	shortcut: { mac: string; other: string };
};

const M = "⌘";
const S = "⇧";
const A = "⌥";

/**
 * The formatting toolbar's buttons, in its order. The chords are Milkdown's
 * (commonmark + gfm keymaps), so they apply in the Rich lens. Code block shows
 * none: Milkdown's Mod-Alt-C never reaches the editor, because the capture-phase
 * handler takes ⌘⌥C for Copy as Markdown.
 */
const FORMAT_ACTIONS: ActionDef[] = (
	[
		["format-bold", "Bold", "B", ""],
		["format-italic", "Italic", "I", ""],
		["format-strike", "Strikethrough", "X", "alt"],
		["format-code", "Inline code", "E", ""],
		["format-link", "Link", "", ""],
		["format-h1", "Heading 1", "1", "alt"],
		["format-h2", "Heading 2", "2", "alt"],
		["format-h3", "Heading 3", "3", "alt"],
		["format-quote", "Quote", "B", "shift"],
		["format-bulletList", "Bullet list", "8", "alt"],
		["format-orderedList", "Numbered list", "7", "alt"],
		["format-codeBlock", "Code block", "", ""],
	] as const
).map(([id, label, key, extra]) => ({
	id,
	label,
	section: "Format",
	aliases: ["format", "markdown"],
	shortcut: key
		? {
				mac: `${extra === "alt" ? A : extra === "shift" ? S : ""}${M}${key}`,
				other: `Ctrl+${extra === "alt" ? "Alt+" : extra === "shift" ? "Shift+" : ""}${key}`,
			}
		: { mac: "", other: "" },
}));

export const ACTIONS: ActionDef[] = [
	{
		id: "new-document",
		label: "New document",
		section: "Documents",
		aliases: ["create", "add"],
		shortcut: { mac: `${M}N`, other: "Ctrl+Alt+N" },
	},
	{
		id: "open-in-mac-app",
		label: "Open in Recto app",
		section: "Documents",
		aliases: ["mac", "desktop", "native"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "mode-rich",
		label: "Switch to Rich text",
		section: "Modes",
		aliases: ["wysiwyg", "rich"],
		shortcut: { mac: "Ctrl+⇧+R", other: "Ctrl+Shift+R" },
	},
	{
		id: "mode-raw",
		label: "Switch to Raw Markdown",
		section: "Modes",
		aliases: ["markdown", "source", "raw"],
		shortcut: { mac: "Ctrl+⇧+M", other: "Ctrl+Shift+M" },
	},
	{
		id: "mode-vim",
		label: "Switch to Vim",
		section: "Modes",
		aliases: ["modal"],
		shortcut: { mac: "Ctrl+⇧+V", other: "Ctrl+Shift+V" },
	},
	{
		id: "mode-preview",
		label: "Switch to Preview",
		section: "Modes",
		aliases: ["read", "rendered", "pv"],
		shortcut: { mac: "Ctrl+⇧+P", other: "Ctrl+Shift+P" },
	},
	{
		id: "cycle-next",
		label: "Cycle mode forward",
		section: "Modes",
		shortcut: { mac: "Ctrl+⇧+]", other: "Ctrl+Shift+]" },
	},
	{
		id: "cycle-prev",
		label: "Cycle mode backward",
		section: "Modes",
		shortcut: { mac: "Ctrl+⇧+[", other: "Ctrl+Shift+[" },
	},
	...FORMAT_ACTIONS,
	{
		id: "split-v",
		label: "Split pane — vertical",
		section: "Panes",
		aliases: ["column", "right"],
		shortcut: { mac: `${M}\\`, other: "Ctrl+\\" },
	},
	{
		id: "split-h",
		label: "Split pane — horizontal",
		section: "Panes",
		aliases: ["row", "below"],
		shortcut: { mac: `${M}${S}\\`, other: "Ctrl+Shift+\\" },
	},
	{
		id: "close-pane",
		label: "Close pane",
		section: "Panes",
		// Ctrl+Shift+W on every platform — ⌘⇧W is reserved by the browser (close window).
		shortcut: { mac: "Ctrl+⇧+W", other: "Ctrl+Shift+W" },
	},
	{
		id: "focus-next",
		label: "Focus next pane",
		section: "Panes",
		shortcut: { mac: "Ctrl+⇧+→", other: "Ctrl+Shift+→" },
	},
	{
		id: "focus-prev",
		label: "Focus previous pane",
		section: "Panes",
		shortcut: { mac: "Ctrl+⇧+←", other: "Ctrl+Shift+←" },
	},
	{
		id: "go-to-heading",
		label: "Go to heading…",
		section: "Navigate",
		aliases: ["outline", "jump", "heading", "section", "toc"],
		shortcut: { mac: "Ctrl+⇧+O", other: "Ctrl+Shift+O" },
	},
	{
		id: "toggle-outline",
		label: "Toggle outline panel",
		section: "Navigate",
		aliases: ["outline", "table of contents", "toc", "sidebar"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "checkpoint",
		label: "Create version / checkpoint",
		section: "History",
		aliases: ["tag", "save", "snapshot"],
		shortcut: { mac: `${M}S`, other: "Ctrl+S" },
	},
	{
		id: "undo-tree",
		label: "Open undo-tree visualizer",
		section: "History",
		aliases: ["branches"],
		shortcut: { mac: "Ctrl+⇧+U", other: "Ctrl+Shift+U" },
	},
	{
		id: "version-history",
		label: "Open version history",
		section: "History",
		aliases: ["versions"],
		shortcut: { mac: "Ctrl+⇧+H", other: "Ctrl+Shift+H" },
	},
	{
		id: "undo",
		label: "Undo",
		section: "History",
		shortcut: { mac: `${M}Z`, other: "Ctrl+Z" },
	},
	{
		id: "redo",
		label: "Redo",
		section: "History",
		shortcut: { mac: `${M}${S}Z`, other: "Ctrl+Y" },
	},
	{
		id: "manage-sharing",
		label: "Manage sharing…",
		section: "Review",
		aliases: ["share", "invite", "collaborate", "reviewer", "comment access"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "review-surface",
		label: "Review suggestions…",
		section: "Review",
		aliases: [
			"review",
			"suggestions",
			"branches",
			"accept",
			"reject",
			"changes",
			"feedback",
		],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-comments",
		label: "Toggle comments panel",
		section: "Review",
		aliases: ["comments", "notes", "feedback", "annotations", "review"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "add-comment",
		label: "Add comment on selection",
		section: "Review",
		aliases: ["comment", "annotate", "note", "leave a comment"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "ai-transform",
		label: "Transform selection with AI…",
		section: "AI",
		aliases: ["rewrite", "tighten", "expand", "fix grammar", "edit", "ai"],
		shortcut: { mac: "Ctrl+⇧+I", other: "Ctrl+Shift+I" },
	},
	{
		id: "ai-critique",
		label: "AI review (comments)…",
		section: "AI",
		aliases: [
			"review",
			"feedback",
			"ai review",
			"comments",
			"critique",
			"notes",
			"ai",
		],
		shortcut: { mac: "Ctrl+⇧+J", other: "Ctrl+Shift+J" },
	},
	{
		id: "ai-related",
		label: "Related passages from past drafts…",
		section: "AI",
		aliases: ["rag", "search drafts", "related", "similar", "ai"],
		shortcut: { mac: "Ctrl+⇧+K", other: "Ctrl+Shift+K" },
	},
	{
		id: "ai-reindex",
		label: "Re-index this draft for search",
		section: "AI",
		aliases: ["embed", "index", "reindex", "rag", "ai"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-ai",
		label: "Toggle AI features",
		section: "AI",
		aliases: ["enable ai", "disable ai", "ai off", "ai on"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-transform-mode",
		label: "Toggle AI transform mode (pending/replace)",
		section: "AI",
		aliases: ["transform mode", "pending", "replace", "confirm", "ai"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "copy-rich",
		label: "Copy as rich text",
		section: "Copy/Export",
		aliases: ["html", "clipboard"],
		shortcut: { mac: `${M}${S}C`, other: "Ctrl+Shift+C" },
	},
	{
		id: "copy-markdown",
		label: "Copy as Markdown",
		section: "Copy/Export",
		aliases: ["source"],
		shortcut: { mac: `${M}${A}C`, other: "Ctrl+Alt+C" },
	},
	{
		id: "export-md",
		label: "Export as .md",
		section: "Copy/Export",
		aliases: ["download markdown"],
		shortcut: { mac: "Ctrl+⇧+E", other: "Ctrl+Shift+E" },
	},
	{
		id: "export-html",
		label: "Export as rich text (.html)",
		section: "Copy/Export",
		aliases: ["download html"],
		shortcut: { mac: "Ctrl+⇧+E", other: "Ctrl+Shift+E" },
	},
	{
		id: "export-docx",
		label: "Export as Word (.docx)",
		section: "Copy/Export",
		aliases: ["download docx", "word"],
		shortcut: { mac: "Ctrl+⇧+E", other: "Ctrl+Shift+E" },
	},
	{
		id: "find-replace",
		label: "Find & replace",
		section: "View",
		aliases: ["search", "replace", "regex", "find"],
		shortcut: { mac: `${M}F`, other: "Ctrl+F" },
	},
	{
		id: "toggle-status",
		label: "Toggle word count / status bar",
		section: "View",
		shortcut: { mac: "Ctrl+⇧+S", other: "Ctrl+Shift+S" },
	},
	{
		id: "toggle-focus",
		label: "Toggle zen mode",
		section: "View",
		aliases: ["focus", "distraction-free", "zen", "fullscreen"],
		shortcut: { mac: "Ctrl+⇧+F", other: "Ctrl+Shift+F" },
	},
	{
		id: "toggle-font",
		label: "Toggle body font (sans / serif)",
		section: "View",
		aliases: ["serif", "sans", "typeface", "font"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "zoom-in",
		label: "Increase text size",
		section: "View",
		aliases: ["zoom in", "bigger text", "larger"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "zoom-out",
		label: "Decrease text size",
		section: "View",
		aliases: ["zoom out", "smaller text"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "zoom-reset",
		label: "Reset text size",
		section: "View",
		aliases: ["zoom 100", "default size"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-spellcheck",
		label: "Toggle spellcheck",
		section: "View",
		aliases: ["spelling", "squiggles"],
		shortcut: { mac: `${M};`, other: "Ctrl+;" },
	},
	{
		id: "toggle-lint-passive",
		label: "Lint: toggle passive voice",
		section: "View",
		aliases: ["passive", "lint", "prose"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-lint-readability",
		label: "Lint: toggle readability",
		section: "View",
		aliases: ["readability", "hard to read", "lint", "prose"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-lint-adverb",
		label: "Lint: toggle adverbs",
		section: "View",
		aliases: ["adverb", "lint", "prose"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-lint-weasel",
		label: "Lint: toggle weasel words",
		section: "View",
		aliases: ["weasel", "lint", "prose"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-smart-paste",
		label: "Toggle smart paste (HTML → Markdown)",
		section: "View",
		aliases: ["paste", "clean paste", "word", "google docs"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-toolbar",
		label: "Toggle formatting toolbar",
		section: "View",
		aliases: ["top toolbar", "format bar"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-typewriter",
		label: "Toggle typewriter scrolling",
		section: "View",
		aliases: ["typewriter", "center line", "scroll", "focus"],
		shortcut: { mac: "Ctrl+⇧+T", other: "Ctrl+Shift+T" },
	},
	{
		id: "toggle-focus-dim",
		label: "Toggle focus dimming",
		section: "View",
		aliases: ["dim", "focus text", "highlight current", "spotlight"],
		shortcut: { mac: "Ctrl+⇧+D", other: "Ctrl+Shift+D" },
	},
	{
		id: "toggle-focus-blur",
		label: "Toggle focus blur",
		section: "View",
		aliases: ["blur", "typewriter", "focus", "current line", "zen"],
		shortcut: { mac: "Ctrl+⇧+B", other: "Ctrl+Shift+B" },
	},
	{
		id: "toggle-quiet-chrome",
		label: "Toggle quiet chrome while typing",
		section: "View",
		aliases: ["fade", "hide toolbar", "distraction", "quiet"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "cycle-dim-scope",
		label: "Focus scope: sentence / paragraph",
		section: "View",
		aliases: ["sentence", "paragraph", "scope", "dim scope"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-email-preview",
		label: "Toggle email/inbox preview",
		section: "View",
		aliases: ["email", "newsletter", "inbox", "preheader", "subject"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "set-goal",
		label: "Set word goal…",
		section: "View",
		aliases: ["target", "goal", "words", "ulysses", "scrivener", "streak"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-goal-style",
		label: "Toggle goal display (ring / bar)",
		section: "View",
		aliases: ["ring", "bar", "goal style", "progress"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "toggle-goal-scope",
		label: "Toggle goal scope (document / daily)",
		section: "View",
		aliases: ["daily goal", "document goal", "goal scope"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "appearance-system",
		label: "Appearance: Match system",
		section: "Theme",
		aliases: ["auto", "light", "dark", "system", "os", "prefers-color-scheme"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "appearance-light",
		label: "Appearance: Light (Paper)",
		section: "Theme",
		aliases: ["light", "paper", "day", "white", "bright"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "appearance-dark",
		label: "Appearance: Dark",
		section: "Theme",
		aliases: ["dark", "night", "twilight"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "theme-twilight",
		label: "Theme: Twilight",
		section: "Theme",
		aliases: [
			"indigo",
			"periwinkle",
			"calm",
			"appearance",
			"palette",
			"colour",
		],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "theme-aurora",
		label: "Theme: Aurora",
		section: "Theme",
		aliases: ["teal", "aqua", "mint", "appearance", "palette", "colour"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "theme-dawn",
		label: "Theme: Dawn",
		section: "Theme",
		aliases: ["rose", "lavender", "appearance", "palette", "colour"],
		shortcut: { mac: "", other: "" },
	},
	{
		id: "theme-moonlit",
		label: "Theme: Moonlit",
		section: "Theme",
		aliases: ["silver", "cyan", "minimal", "appearance", "palette", "colour"],
		shortcut: { mac: "", other: "" },
	},
];

export const SECTION_ORDER: ActionSection[] = [
	"Documents",
	"Modes",
	"Format",
	"Panes",
	"Navigate",
	"History",
	"Review",
	"AI",
	"Copy/Export",
	"View",
	"Theme",
];

const isMac =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad|iPod/.test(navigator.platform);

export function shortcutHint(def: ActionDef): string {
	return isMac ? def.shortcut.mac : def.shortcut.other;
}

/**
 * A tooltip that teaches the chord: "Bold (⌘B)", or the text alone when the
 * action has none.
 */
export function withShortcut(text: string, id: ActionId): string {
	const def = ACTIONS.find((action) => action.id === id);
	const hint = def ? shortcutHint(def) : "";
	return hint ? `${text} (${hint})` : text;
}
