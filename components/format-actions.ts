import {
	Bold,
	Code,
	Heading1,
	Heading2,
	Heading3,
	Italic,
	Link2,
	List,
	ListOrdered,
	type LucideIcon,
	Quote,
	SquareCode,
	Strikethrough,
} from "lucide-react";

import type { FormatCommand } from "@/lib/editor/format";

export type FormatAction = {
	/** Every toolbar command but paragraph, which the toolbar has no button for. */
	command: Exclude<FormatCommand, "paragraph">;
	label: string;
	icon: LucideIcon;
};

/** Inline marks — the core of the floating selection bar. */
export const INLINE_ACTIONS: FormatAction[] = [
	{ command: "bold", label: "Bold", icon: Bold },
	{ command: "italic", label: "Italic", icon: Italic },
	{ command: "strike", label: "Strikethrough", icon: Strikethrough },
	{ command: "code", label: "Inline code", icon: Code },
	{ command: "link", label: "Link", icon: Link2 },
];

/** Block transforms — headings, quote, lists, code block. */
export const BLOCK_ACTIONS: FormatAction[] = [
	{ command: "h1", label: "Heading 1", icon: Heading1 },
	{ command: "h2", label: "Heading 2", icon: Heading2 },
	{ command: "h3", label: "Heading 3", icon: Heading3 },
	{ command: "quote", label: "Quote", icon: Quote },
	{ command: "bulletList", label: "Bullet list", icon: List },
	{ command: "orderedList", label: "Numbered list", icon: ListOrdered },
	{ command: "codeBlock", label: "Code block", icon: SquareCode },
];

/** Compact set for the floating selection bar (inline + the most-used blocks). */
export const SELECTION_ACTIONS: FormatAction[] = [
	...INLINE_ACTIONS,
	{ command: "h1", label: "Heading 1", icon: Heading1 },
	{ command: "h2", label: "Heading 2", icon: Heading2 },
	{ command: "quote", label: "Quote", icon: Quote },
	{ command: "bulletList", label: "Bullet list", icon: List },
];
