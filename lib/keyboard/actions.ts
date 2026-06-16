/**
 * The single application action registry (blueprint 13 §7.3.4). The capture-phase
 * chord handler and the cmdk command palette both surface these — one
 * implementation per action, two surfaces. The palette reads the shortcut hints
 * from here so they always match the real chord.
 */

export type ActionSection =
	| "Documents"
	| "Modes"
	| "Panes"
	| "History"
	| "Copy/Export"
	| "View"
	| "Theme";

export type ActionId =
	| "new-document"
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
	| "checkpoint"
	| "undo-tree"
	| "version-history"
	| "undo"
	| "redo"
	| "copy-rich"
	| "copy-markdown"
	| "export-md"
	| "export-html"
	| "toggle-status"
	| "toggle-focus"
	| "toggle-font"
	| "zoom-in"
	| "zoom-out"
	| "zoom-reset"
	| "toggle-spellcheck"
	| "toggle-toolbar"
	| "theme-twilight"
	| "theme-aurora"
	| "theme-dawn"
	| "theme-moonlit";

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

export const ACTIONS: ActionDef[] = [
	{
		id: "new-document",
		label: "New document",
		section: "Documents",
		aliases: ["create", "add"],
		shortcut: { mac: `${M}N`, other: "Ctrl+Alt+N" },
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
	"Panes",
	"History",
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
