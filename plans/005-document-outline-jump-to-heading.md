# Plan 005: Document outline / table-of-contents with jump-to-heading

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat a25c506..HEAD -- \
>   lib/keyboard/actions.ts \
>   lib/keyboard/app-shortcuts.ts \
>   components/command-palette.tsx \
>   components/studio-shell.tsx \
>   components/workspace/pane-editor.tsx \
>   components/workspace/render-pane-node.tsx \
>   lib/editor/handle.ts \
>   lib/editor/codemirror/index.tsx \
>   lib/editor/milkdown/index.tsx \
>   lib/editor/preview/index.tsx \
>   lib/workspace/document-registry.ts \
>   lib/studio/use-studio-settings.ts \
>   lib/studio/settings-context.tsx \
>   components/history/history-panel.tsx
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

Long-form drafts have no structural navigation — the only way to reach a section
is scrolling. Headings already live in the canonical MDAST that Recto parses on
every sync, so deriving an outline is cheap and lossless. This plan adds two
keyboard-driven ways to navigate by heading (Obsidian's model): a togglable
docked outline panel, and a "Go to heading…" command-palette mode that
fuzzy-filters the active document's headings. Both jump the active editor to the
chosen heading and place the caret there. Outcome: a writer can move around a
20-page draft by structure, not by scrollbar.

This is a genuine A/B UX fork (docked panel vs palette-only quick jump). Per the
project convention "build a switchable setting, don't pick one" — ship **both**.
The palette mode is always available; the panel is toggleable and its open/closed
state is persisted in studio settings.

## Current state

### How the document is parsed into MDAST (reuse this)

`lib/markdown/parse.ts` (whole file):
```ts
import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkFrontmatter, ["yaml"]);

/** Parse canonical Markdown into remark MDAST. */
export function parseMarkdown(markdown: string): Root {
	return parser.parse(markdown) as Root;
}
```

`lib/markdown/derive-title.ts:31-38` shows the heading-walk + phrasing-to-text
pattern you will reuse for outline text extraction:
```ts
/** Derive default title from MDAST root. */
export function deriveTitleFromMdast(root: Root): string {
	let title = "";
	visit(root, "heading", (node) => {
		if (title.length > 0) return;
		title = phrasingToText(node.children).trim();
	});
	return title.length > 0 ? title : "Untitled";
}
```
and `lib/markdown/derive-title.ts:6-18` — the `phrasingToText` helper (recurses
into `children`, reads `value`):
```ts
function phrasingToText(nodes: PhrasingContent[]): string {
	return nodes
		.map((node) => {
			if ("value" in node && typeof node.value === "string") {
				return node.value;
			}
			if ("children" in node && Array.isArray(node.children)) {
				return phrasingToText(node.children as PhrasingContent[]);
			}
			return "";
		})
		.join("");
}
```
NOTE: remark `heading` nodes carry `depth` (1–6) and `position.start.offset`
(string character offset into the parsed source). `visit` from `unist-util-visit`
does NOT descend into `code` (fenced code block) node *content* as headings —
fenced code is a single `code` leaf node, so `### inside a fence` never becomes a
heading node. This is why "headings inside code fences excluded" is free with the
MDAST walk (verify in the test, do not special-case it).

`lib/markdown/index.ts` re-exports the public markdown API. `parseMarkdown` is
exported there:
```ts
export { parseMarkdown } from "./parse";
```

### The EditorHandle API (the scroll/caret surface)

`lib/editor/handle.ts` (whole file):
```ts
import type { FormatCommand } from "@/lib/editor/format";
import type { CaretPosition } from "@/lib/modes/types";

/** Shared editor surface API for sync and mode switching. */
export type EditorHandle = {
	seed: (markdown: string, opts?: { programmatic?: boolean }) => void;
	getCanonicalMarkdown: () => string;
	exportCaret: () => CaretPosition;
	importCaret: (caret: CaretPosition) => void;
	focus: () => void;
	isFocused: () => boolean;
	getRootElement: () => HTMLElement | null;
	/** Apply a formatting command (from the top toolbar / floating bar). */
	runFormat: (command: FormatCommand, opts?: { href?: string }) => void;
};

/** Read-only preview — no editing surface. */
export function createPreviewHandle(getMarkdown: () => string): EditorHandle {
	return {
		seed() {},
		getCanonicalMarkdown: getMarkdown,
		exportCaret: () => ({ offset: 0, anchor: 0, head: 0 }),
		importCaret() {},
		focus() {},
		isFocused: () => false,
		getRootElement: () => null,
		runFormat() {},
	};
}
```

`CaretPosition` is `{ offset: number; anchor: number; head: number }` (see
`lib/modes/caret.ts` and `lib/modes/types`). `clampOffset` clamps into bounds.

**Critical: `EditorHandle` has NO scroll-to-offset method, and the three editor
types use DIFFERENT offset spaces.** See the "Decisions" section below before
writing any jump code.

### Where the active editor handle is obtained

`components/studio-shell.tsx:234-243` — how the shell gets the primary handle for
the active document (use this exact pattern to reach the right editor):
```ts
const getExportSource = useCallback((): ExportSource | null => {
	if (!activeDocId || !workspace) return null;
	const handle = registry.getPrimaryHandle(
		activeDocId,
		workspace.activePaneId,
	);
	const markdown =
		handle?.getCanonicalMarkdown() ?? activeSync?.markdown ?? "";
	return { title: activeTitle, markdown };
}, [activeDocId, workspace, registry, activeSync, activeTitle]);
```

`lib/workspace/document-registry.ts:94-121` — `getPrimaryHandle` resolves the
active pane's live editor handle (rich → `richRef.current`, raw/vim →
`cmRef.current`; returns `null` for preview, since preview registers no handle):
```ts
getPrimaryHandle(
	documentId: Id<"documents">,
	activePaneId: string | null,
): EditorHandle | null {
	const entry = this.entries.get(documentId);
	if (!entry) return null;

	const tryRegistration = (
		reg: PaneRegistration | undefined,
	): EditorHandle | null => {
		if (!reg) return null;
		if (reg.mode === "rich") return reg.richRef.current;
		if (reg.mode === "raw" || reg.mode === "vim") return reg.cmRef.current;
		return null;
	};

	if (activePaneId) {
		const active = entry.registrations.get(activePaneId);
		const handle = tryRegistration(active);
		if (handle) return handle;
	}
	for (const reg of entry.registrations.values()) {
		const handle = tryRegistration(reg);
		if (handle) return handle;
	}
	return null;
}
```

`registry` and `workspace` come from `useWorkspace()` in `StudioWorkspace`
(`components/studio-shell.tsx:54-62`). `activeDocId` / `activeSync` /
`activeTitle` are derived at `components/studio-shell.tsx:178-183`.

### The editor types and their offset/DOM realities (load-bearing)

- **CodeMirror** (`lib/editor/codemirror/index.tsx`, raw + vim modes):
  `importCaret` maps a string offset into `view.state.doc` and dispatches a
  selection (`lib/editor/codemirror/index.tsx:338-346`). It exposes
  `getCmView(): EditorView | null` (`:369-371`). CodeMirror renders the FULL
  canonical markdown INCLUDING the YAML frontmatter block. So MDAST
  `node.position.start.offset` (computed from the full parsed source) maps
  directly to a CodeMirror document offset.
- **Milkdown** (`lib/editor/milkdown/index.tsx`, rich mode): `importCaret`
  treats the number as a ProseMirror document position
  (`view.state.doc.content.size`), NOT a string offset
  (`lib/editor/milkdown/index.tsx:183-201`). ProseMirror positions do NOT equal
  MDAST string offsets, and Milkdown renders ONLY the body (frontmatter is held
  out — `:75-78`, `:137-151`). It exposes `getPmView(): PMEditorView | null`
  (`:280-288`). Mapping a string offset to a PM position is non-trivial.
- **Preview** (`lib/editor/preview/index.tsx`): read-only; `getRootElement()`
  returns null and `importCaret` is a no-op (`createPreviewHandle`). Rendered
  HTML headings have NO `id`/slug attributes (the preview pipeline in
  `lib/preview/render.ts` runs `remark-rehype` → `rehype-sanitize` →
  `rehype-stringify` with no `rehype-slug`).

The only navigation primitive that works uniformly across all three is
**DOM-index lookup**: every editor renders headings in document order as DOM
elements. Find the Nth heading element under the editor's root and
`scrollIntoView` it. See "Decisions".

### Command palette structure (add a heading-navigation mode here)

`components/command-palette.tsx` — the cmdk palette. Props
(`:21-28`): `open`, `onOpenChange`, `scope?: "all" | "documents"`, `documents`,
`onRunAction(id)`, `onOpenDocument(id)`. The two style consts (reuse verbatim):
```ts
const HEADING =
	"[&_[cmdk-group-heading]]:px-[var(--space-2)] [&_[cmdk-group-heading]]:pt-[var(--space-3)] [&_[cmdk-group-heading]]:pb-[var(--space-1)] [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-[var(--color-ink-tertiary)]";

const ITEM =
	"recto-item flex cursor-pointer items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-secondary)]";
```
The `run` helper (`:71-75`) runs the action synchronously then closes; `scope`
gates which sections render (`:77-78`). Items render via `Command.Group` →
`Command.Item value=… onSelect=… className={ITEM}` (`:115-179`). The input
placeholder is chosen from `scope` (`:100-108`).

### Action registry + chord handler (add new actions here)

`lib/keyboard/actions.ts` — the single action registry. `ActionId` union
(`:17-50`), `ActionDef` shape (`:52-58`):
```ts
export type ActionDef = {
	id: ActionId;
	label: string;
	section: ActionSection;
	aliases?: string[];
	shortcut: { mac: string; other: string };
};
```
`ActionSection` (`:8-15`) is a union; `SECTION_ORDER` (`:298-306`) controls the
palette group order. Example entry (`:206-211`):
```ts
{
	id: "toggle-status",
	label: "Toggle word count / status bar",
	section: "View",
	shortcut: { mac: "Ctrl+⇧+S", other: "Ctrl+Shift+S" },
},
```
`shortcutHint(def)` (`:312-314`) picks mac vs other by `navigator.platform`.

`lib/keyboard/app-shortcuts.ts` — the capture-phase chord handler.
`AppShortcutAction` union (`:4-23`) lists every dispatched action. The handler
`createAppShortcutHandler` (`:110-316`) tests chords in order; each match does
`preventDefault(); stopPropagation(); onAction({...}); return;`. The
`matchCtrlShift(event, key)` helper (`:51-59`) matches `Ctrl+Shift+<key>` with
no meta/alt. Example existing branch (`:171-176`):
```ts
if (matchCtrlShift(event, "s")) {
	event.preventDefault();
	event.stopPropagation();
	onAction({ type: "toggle-status" });
	return;
}
```
The handler is wired in `components/studio-shell.tsx:385-466`: a `switch
(action.type)` routes each `AppShortcutAction` to shell state/dispatch. Example
(`:447-449`):
```ts
case "toggle-status":
	setStatusVisible((v) => !v);
	return;
```
The palette's `open-palette` action sets `commandScope` then opens
(`:390-393`). Adapt this for a heading-scope open.

### A side-panel exemplar (model the outline panel's chrome on this)

`components/history/history-panel.tsx` — a fixed right-docked panel that reads
from the active document. Its shell pattern (`:165-219`):
```tsx
if (!open || !history) return null;

return (
	<div className="fixed inset-y-0 right-0 z-[90] flex">
		<button
			type="button"
			aria-label="Close history"
			className="recto-scrim absolute inset-0 -left-[100vw]"
			onClick={onClose}
		/>
		<aside
			className="recto-panel relative z-10 flex h-full w-[min(24rem,100vw)] flex-col rounded-none border-y-0 border-r-0 border-l"
			role="dialog"
			aria-modal="true"
			aria-labelledby="recto-history-title"
		>
			<h2 id="recto-history-title" className="sr-only">Document history</h2>
			<header className="flex shrink-0 items-center justify-between border-b border-[var(--color-line)] px-[var(--space-4)] py-[var(--space-3)]">
				{/* …tabs + close button… */}
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]">
				{/* …rows… */}
			</div>
		</aside>
	</div>
);
```
It restores focus to the trigger on close (`:94-103`) and closes on Escape
(`:105-115`). Reuse both patterns. Its list rows use indentation via inline
`paddingInlineStart` (`:231`) — directly applicable to heading indent-by-depth.
`HistoryPanel` is mounted in `components/studio-shell.tsx:655-668` (guarded by
`activeDocId`); mount the outline panel the same way.

### Settings (persist the panel's open/closed state)

`lib/studio/use-studio-settings.ts` — persisted studio settings. The
`StudioSettings` shape (`:21-32`), `DEFAULTS` (`:38-44`), and a boolean toggle
example (`:161-163`):
```ts
const toggleTopToolbar = useCallback(() => {
	setSettings((s) => ({ ...s, topToolbar: !s.topToolbar }));
}, []);
```
`loadSettings()` (`:57-85`) validates each field from localStorage with a
`typeof … === "boolean"` guard and falls back to `DEFAULTS`. `StudioSettingsApi`
(`:87-97`) adds the methods; the hook returns spread settings + methods
(`:165-176`). `settings-context.tsx` provides `useStudioSettingsContext()` for
deep reads. The shell already holds `settings = useStudioSettings()` at
`components/studio-shell.tsx:82` and wraps the tree in
`StudioSettingsProvider value={settings}` (`:491`).

### Repo conventions that apply

- **Bun + Vitest.** Tests use `import { describe, expect, it } from "vitest";`
  (see `lib/markdown/*.test.ts`). The pure outline test runs under `vitest`.
- **UI** = compose existing classes/tokens. Dark-only OKLCH tokens via
  `var(--color-*)`, `var(--space-*)`, `var(--text-ui-sm)`, `var(--radius-*)`.
  Do NOT introduce raw hex or one-off styles. Match the `recto-panel`,
  `recto-item`, `recto-scrim`, `recto-kbd` utility classes already used.
- **One action, two surfaces** (blueprint 13 §7.3.4): every command is one
  `ActionDef` surfaced by both the chord handler and the palette. Keep it that
  way — the new actions go in `lib/keyboard/actions.ts`.
- **Editor owns live state; never bind editor value to a reactive `useQuery`.**
  The outline reads markdown from the live handle
  (`handle.getCanonicalMarkdown()`), falling back to `activeSync?.markdown` —
  same as `getExportSource` above. Debounce recompute.

## Commands you will need

| Purpose   | Command              | Expected on success            |
|-----------|----------------------|--------------------------------|
| Install   | `bun install`        | exit 0                         |
| Typecheck | `bun run typecheck`  | exit 0, no errors              |
| Lint      | `bun run biome`      | exit 0, no errors              |
| Tests     | `bun run test`       | all pass, incl. new tests      |
| Build     | `bun run build`      | exit 0                         |
| Dev (manual smoke) | `bun run dev` | starts Next + Convex          |

(These are the exact `package.json` scripts. `bun run test` runs
`vitest run` plus a bun-native Convex spike test — both must pass.)

## Suggested executor toolkit

- When writing the React panel, prefer composing existing `recto-*` classes and
  OKLCH tokens over new CSS — mirror `components/history/history-panel.tsx`.
- `unist-util-visit` is already a dependency (used in `derive-title.ts`). Use
  `visit(root, "heading", …)` — do not hand-roll a tree walk.

## Scope

**In scope** (the only files you should create or modify):
- `lib/outline/extract.ts` (create) — pure outline extraction from markdown.
- `lib/outline/extract.test.ts` (create) — vitest unit tests.
- `lib/outline/scroll-to-heading.ts` (create) — DOM-index scroll helper.
- `lib/keyboard/actions.ts` (modify) — add outline actions + a "Navigate" section.
- `lib/keyboard/app-shortcuts.ts` (modify) — add chords + `AppShortcutAction`s.
- `components/command-palette.tsx` (modify) — add a heading-jump scope/mode.
- `components/outline/outline-panel.tsx` (create) — docked outline panel.
- `components/studio-shell.tsx` (modify) — wire actions, mount panel, jump logic.
- `lib/studio/use-studio-settings.ts` (modify) — persist `outlineOpen`.

**Out of scope** (do NOT touch, even though they look related):
- `components/editor-pane.tsx` — DEAD CODE. Verified at `a25c506`:
  `grep -rn "editor-pane"` returns no importers. The live editor mount is
  `pane-editor.tsx` via `render-pane-node.tsx`. Do not edit or rely on it.
- `lib/editor/handle.ts` — do NOT add a `scrollToOffset` method to the shared
  handle. The DOM-index strategy (below) does not need it, and changing the
  handle contract touches all four editor implementations + the registry. If
  you believe the handle MUST change, that is a STOP condition.
- `lib/preview/render.ts` — do NOT add `rehype-slug`. DOM-index lookup needs no
  ids; adding slugs changes preview HTML output and is out of scope.
- Convex (`convex/**`) — the outline is derived client-side from live markdown;
  no schema, query, or mutation changes.

## Git workflow

- Branch: `advisor/005-document-outline-jump-to-heading`
- Commit per logical unit. Conventional commits, author = the repo user, and
  **NO AI attribution / Co-Authored-By lines** (project convention). Example
  from `git log`: `feat: add switchable calm color themes`.
- Do NOT push or open a PR unless the operator instructed it.

## Decisions (made — implement exactly)

### D1. Heading → editor scroll target: use DOM-index lookup (universal)

A single, robust strategy that works across rich/raw/vim/preview:

1. Extract headings from the live markdown in **document order** (Step 1).
2. To jump to the Nth heading (0-based index `i`):
   - Get the active handle: `registry.getPrimaryHandle(activeDocId, activePaneId)`.
   - Get its scroll root: `root = handle?.getRootElement()`. For **preview**
     (handle is null), reach the preview DOM another way (see D1a).
   - Query `root.querySelectorAll("h1, h2, h3, h4, h5, h6")` and pick element
     `[i]`. (Editors render headings in source order, so the index aligns with
     the extracted outline order. This is the load-bearing assumption — test it
     manually in all modes; if it fails in a mode, that mode falls back to
     no-op, not a crash.)
   - `el.scrollIntoView({ block: "start", behavior: "smooth" })`.
3. **Caret placement** (best-effort, only for editable modes): also call
   `handle.importCaret(caretAtOffset(headingOffset, docLength))` where
   `headingOffset` is the MDAST `position.start.offset`. This is CORRECT for
   CodeMirror (string offset === CM doc offset, frontmatter included). For
   Milkdown the offset space differs, so caret placement there is unreliable —
   **scroll is the primary effect; caret is a bonus.** Do not block scroll on
   caret. (Justification: per project rule "do it right" — scroll is the
   load-bearing UX and works everywhere via DOM; caret-to-PM-position mapping
   would be a large, fragile addition for marginal benefit. Ship scroll
   universally + caret where the offset space matches.)

This avoids adding a method to `EditorHandle` and needs no per-editor offset
translation for the primary effect.

#### D1a. Reaching the preview pane's DOM

Preview's `getPrimaryHandle` returns null. The preview renders an `<article>`
with class `recto-preview` inside the active pane. To find its scroll root when
the active mode is preview: scope the query to the active pane. Simplest robust
approach — query from the active pane container. The pane shell sets
`data-pane-id` (verify: `components/workspace/pane-shell.tsx`). If a
`[data-pane-id]` attribute exists, query
`document.querySelector('[data-pane-id="<activePaneId>"] .recto-preview')` and
scroll within it. If no such attribute exists, fall back to
`document.querySelector(".recto-preview h1, .recto-preview h2, …")[i]`.
**Verify the pane-id attribute first-hand before relying on it**; if neither the
attribute nor a single `.recto-preview` exists, preview-mode jump is a no-op
(acceptable — STOP only if ALL modes fail).

### D2. A/B fork: ship BOTH surfaces (panel + palette)

- **Palette mode** (always available): a "Go to heading…" command opens the
  palette in a new `scope: "headings"`, fuzzy-filtering the active doc's
  headings; selecting one jumps. Models the existing `scope: "documents"` path.
- **Docked panel** (toggleable, persisted): a right-docked outline panel
  (model on `HistoryPanel`) listing headings indented by depth; clicking a
  heading jumps. Its open/closed state persists via a new `outlineOpen` setting.

Do not pick one; both ship. This honors the project memory "prefer user
toggles".

### D3. Live updating: debounce recompute (250 ms)

Recompute the outline from the live handle on document change, debounced. Reuse
the existing change signal: the shell already re-renders on `activeSync` updates.
Compute the outline with a `useMemo` keyed on the markdown string, and refresh
the markdown source on a 250 ms debounce timer (or recompute on panel open +
on a lightweight interval while open). Do NOT bind the outline to a reactive
`useQuery` of document content — read from the handle, fall back to
`activeSync?.markdown`, matching `getExportSource`.

## Steps

### Step 1: Create the pure outline-extraction function

Create `lib/outline/extract.ts`. Export a type and a function:
```ts
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import { parseMarkdown } from "@/lib/markdown/parse";

export type OutlineHeading = {
	/** Heading level 1–6. */
	depth: number;
	/** Plain text of the heading (markdown syntax stripped). */
	text: string;
	/** Character offset of the heading start in the parsed source. */
	offset: number;
	/** 0-based index in document order (aligns with rendered DOM order). */
	index: number;
};

/** Extract a flat, in-document-order outline of headings from markdown. */
export function extractOutline(markdown: string): OutlineHeading[] {
	return extractOutlineFromMdast(parseMarkdown(markdown));
}

export function extractOutlineFromMdast(root: Root): OutlineHeading[] {
	const out: OutlineHeading[] = [];
	visit(root, "heading", (node) => {
		const text = phrasingToText(node.children).trim();
		out.push({
			depth: node.depth,
			text,
			offset: node.position?.start.offset ?? 0,
			index: out.length,
		});
	});
	return out;
}
```
Copy `phrasingToText` from `lib/markdown/derive-title.ts:6-18` into this file
(small, self-contained; do not export from derive-title to keep blast radius
minimal — or import it if it is exported there, but it is NOT exported, so
inline a copy). Keep types `import`-only where possible (TS strict, ESM).

Decide how empty-text headings render: keep them with `text: ""` (the panel/
palette will show a placeholder like "(untitled heading)"); do not drop them, so
the `index` still aligns with the DOM.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Write the extraction tests

Create `lib/outline/extract.test.ts`, modeled on `lib/markdown/frontmatter.test.ts`
(same `describe`/`it`/`expect` from vitest). Cover exactly these cases:

- **nested headings**: a doc with H1, H2, H3, H2 in order → 4 entries with the
  right `depth` sequence `[1,2,3,2]` and ascending `index` `[0,1,2,3]`.
- **no headings**: a plain-paragraph doc → `[]`.
- **duplicate titles**: two `## Notes` headings → 2 entries, both `text:
  "Notes"`, distinct `index` 0 and 1 (so the DOM-index jump can disambiguate).
- **headings inside code fences excluded**: a doc containing
  ```` ```\n### not a heading\n``` ```` plus one real `## Real` → exactly 1
  entry, `text: "Real"`. (This is the key correctness case — proves fenced `###`
  is never parsed as a heading node.)
- **text extraction strips inline markdown**: `## Hello **world**` →
  `text: "Hello world"`.
- **frontmatter does not become a heading**: a doc with a YAML frontmatter
  block then `# Title` → exactly 1 entry, `text: "Title"`.
- **offset is monotonic non-decreasing** across headings in a multi-heading doc.

Use template-literal fixtures with `\n` like the existing tests (e.g.
``const md = `# A\n\n## B\n\n### C\n\n## D\n`;``).

**Verify**: `bun run test` → all pass, including the new `extract.test.ts`
cases. Run focused first if helpful: `bunx vitest run lib/outline/extract.test.ts`
→ all green.

### Step 3: Create the DOM-index scroll helper

Create `lib/outline/scroll-to-heading.ts`:
```ts
import type { EditorHandle } from "@/lib/editor/handle";

/**
 * Scroll the given editor root to its Nth rendered heading (document order),
 * matching the index from extractOutline. Best-effort: no-op if absent.
 */
export function scrollRootToHeadingIndex(
	root: HTMLElement | null,
	index: number,
): boolean {
	if (!root) return false;
	const headings = root.querySelectorAll<HTMLElement>(
		"h1, h2, h3, h4, h5, h6",
	);
	const el = headings[index];
	if (!el) return false;
	el.scrollIntoView({ block: "start", behavior: "smooth" });
	return true;
}
```
Keep the caret-placement concern in the shell (it needs the handle + doc length),
not here. This module is pure DOM + index. (You may also add a small helper that
takes the `EditorHandle` and does `scrollRootToHeadingIndex(handle.getRootElement(),
index)` — optional.)

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Step 4: Register the new actions

In `lib/keyboard/actions.ts`:
- Add `"Navigate"` to the `ActionSection` union (`:8-15`) and to `SECTION_ORDER`
  (`:298-306`), placed after `"Panes"` (so it sits with structural navigation).
- Add two `ActionId`s to the union (`:17-50`): `"go-to-heading"` and
  `"toggle-outline"`.
- Add two `ActionDef`s to `ACTIONS` (`:64-296`):
  ```ts
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
  ```
  NOTE: `Ctrl+Shift+O` is unused at `a25c506` (verify against
  `lib/keyboard/app-shortcuts.ts` `matchCtrlShift` cases — used letters: u, h,
  e, s, f, r, m, v, p, w, and arrows; `o` is free). Keep `toggle-outline` with
  empty shortcuts (palette/panel-button only) to avoid chord exhaustion; or
  assign one only if free.

**Verify**: `bun run typecheck` → exit 0 (the palette already maps over
`ACTIONS`/`SECTION_ORDER`, so the new section renders automatically).

### Step 5: Wire the chord handler

In `lib/keyboard/app-shortcuts.ts`:
- Add to the `AppShortcutAction` union (`:4-23`):
  ```ts
  | { type: "open-go-to-heading" }
  | { type: "toggle-outline" }
  ```
- Add a chord branch in `createAppShortcutHandler` (after the existing
  `matchCtrlShift(event, "f")` block, before `isCommandPaletteKey`), following
  the exact `preventDefault/stopPropagation/onAction/return` shape:
  ```ts
  if (matchCtrlShift(event, "o")) {
  	event.preventDefault();
  	event.stopPropagation();
  	onAction({ type: "open-go-to-heading" });
  	return;
  }
  ```
  (Only add a `toggle-outline` chord if you assigned one in Step 4; otherwise
  leave it palette/button-driven.)

**Verify**: `bun run typecheck` → exit 0.

### Step 6: Add the heading scope to the command palette

In `components/command-palette.tsx`:
- Extend the `scope` prop type (`:24`) to
  `scope?: "all" | "documents" | "headings"`.
- Add a `headings` prop: `headings: { text: string; depth: number; index: number }[]`
  and `onJumpToHeading: (index: number) => void`.
- When `scope === "headings"`, render ONLY a `Command.Group heading="Headings"`
  listing each heading (skip the document/action sections). Reuse `HEADING` and
  `ITEM` classes. Each item:
  ```tsx
  <Command.Item
  	key={h.index}
  	value={`heading ${h.text} ${h.index}`}
  	onSelect={() => run(() => onJumpToHeading(h.index))}
  	className={ITEM}
  >
  	<span
  		className="min-w-0 flex-1 truncate text-[var(--color-ink-primary)]"
  		style={{ paddingInlineStart: `${(h.depth - 1) * 12}px` }}
  	>
  		{h.text || "(untitled heading)"}
  	</span>
  	<span className="shrink-0 text-[var(--color-ink-tertiary)]">
  		H{h.depth}
  	</span>
  </Command.Item>
  ```
  IMPORTANT: cmdk's `value` is used for fuzzy filtering — include `h.text` (and
  the index, to keep duplicate-titled headings distinct/selectable). The
  duplicate-title case relies on `key`/`value` carrying the index.
- Set the input placeholder for `headings` scope to `"Go to heading…"`
  (extend the `:100-108` ternary).
- The `sections` computation (`:77-78`) currently does
  `scope === "documents" ? ["Documents"] : SECTION_ORDER`. Add a `headings`
  branch that bypasses the section loop entirely (render the headings group
  directly), OR special-case before the `sections.map`.

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Step 7: Persist the outline-panel open state

In `lib/studio/use-studio-settings.ts`:
- Add `outlineOpen: boolean;` to `StudioSettings` (`:21-32`) with a doc comment.
- Add `outlineOpen: false` to `DEFAULTS` (`:38-44`).
- Validate it in `loadSettings` (`:63-81`) with the boolean guard pattern:
  ```ts
  outlineOpen:
  	typeof parsed.outlineOpen === "boolean"
  		? parsed.outlineOpen
  		: DEFAULTS.outlineOpen,
  ```
- Add to `StudioSettingsApi` (`:87-97`): `toggleOutline: () => void;` and
  `setOutlineOpen: (open: boolean) => void;`.
- Implement them with the `useCallback`/`setSettings` pattern (mirror
  `toggleTopToolbar` `:161-163`) and include them in the returned object
  (`:165-176`).

**Verify**: `bun run typecheck` → exit 0.

### Step 8: Create the outline panel component

Create `components/outline/outline-panel.tsx`, modeled on
`components/history/history-panel.tsx` (the `fixed inset-y-0 right-0`,
`recto-scrim`, `recto-panel`, Escape-to-close, restore-focus-on-close patterns).
Props:
```ts
type OutlinePanelProps = {
	open: boolean;
	headings: { text: string; depth: number; index: number }[];
	onJumpToHeading: (index: number) => void;
	onClose: () => void;
};
```
Render a header (title "Outline" + close button matching HistoryPanel's `X`
button) and a scrollable list of heading rows. Each row is a `<button>` with
`paddingInlineStart` = `${depth * 16 - 8}px` (indent by depth, mirroring
HistoryPanel `:231`), the heading text (or "(untitled heading)"), and a muted
`H{depth}` badge. `onClick={() => onJumpToHeading(index)}`. Empty state when
`headings.length === 0`: "No headings yet." Use only `recto-*` classes and OKLCH
tokens; dark-only. Add `role="dialog"`, `aria-modal`, `aria-labelledby` like the
exemplar. Restore focus on close and close on Escape.

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Step 9: Wire everything in the studio shell

In `components/studio-shell.tsx`:
1. Add state: `const [outlineOpen, setOutlineOpenLocal] = useState(settings.outlineOpen);`
   — or drive directly from `settings.outlineOpen` and toggle via
   `settings.toggleOutline()`. Prefer driving from settings so it persists.
2. Compute the live outline. Get the markdown the same way `getExportSource`
   does (`:234-243`): primary handle `getCanonicalMarkdown()` ?? `activeSync?.markdown`.
   Recompute debounced (D3): keep an `outlineMarkdown` state updated on a 250 ms
   timer whenever `activeSync?.markdown` changes (or when the panel/palette opens),
   then `const outline = useMemo(() => extractOutline(outlineMarkdown), [outlineMarkdown]);`.
   Map to the palette/panel shape: `{ text, depth, index }`.
3. Implement the jump:
   ```ts
   const jumpToHeading = useCallback((index: number) => {
   	if (!activeDocId || !workspace) return;
   	const handle = registry.getPrimaryHandle(activeDocId, workspace.activePaneId);
   	// Scroll (works in editable modes via the handle root).
   	let root = handle?.getRootElement() ?? null;
   	// Preview mode has no handle — fall back to the active pane's preview DOM (D1a).
   	if (!root) {
   		root =
   			document.querySelector<HTMLElement>(
   				`[data-pane-id="${workspace.activePaneId}"] .recto-preview`,
   			) ?? document.querySelector<HTMLElement>(".recto-preview");
   	}
   	scrollRootToHeadingIndex(root, index);
   	// Best-effort caret (correct for CodeMirror; bonus for Milkdown).
   	const h = outline[index];
   	if (handle && h) {
   		const md = handle.getCanonicalMarkdown();
   		handle.importCaret(caretAtOffset(h.offset, md.length));
   		handle.focus();
   	}
   }, [activeDocId, workspace, registry, outline]);
   ```
   Import `caretAtOffset` from `@/lib/modes/caret`, `scrollRootToHeadingIndex`
   from `@/lib/outline/scroll-to-heading`, `extractOutline` from
   `@/lib/outline/extract`. VERIFY the `data-pane-id` selector against
   `components/workspace/pane-shell.tsx` (Step 9a) before relying on it.
4. Add to the `dispatch` switch (`:247-369`):
   ```ts
   case "go-to-heading":
   	setCommandScope("headings");
   	setCommandOpen(true);
   	return;
   case "toggle-outline":
   	settings.toggleOutline();
   	return;
   ```
   (`ActionId` now includes these, so the switch must handle them — TS
   exhaustiveness.)
5. Add to the chord-handler switch (`:388-454`):
   ```ts
   case "open-go-to-heading":
   	setCommandScope("headings");
   	setCommandOpen(true);
   	return;
   case "toggle-outline":
   	settings.toggleOutline();
   	return;
   ```
6. Pass new props to `<CommandPalette>` (`:634-645`): `headings={outline}` and
   `onJumpToHeading={jumpToHeading}`.
7. Mount `<OutlinePanel>` near `<HistoryPanel>` (`:655-668`), guarded by
   `!showEmpty`:
   ```tsx
   <OutlinePanel
   	open={settings.outlineOpen}
   	headings={outline}
   	onJumpToHeading={(i) => {
   		jumpToHeading(i);
   		dispatchFocusEditor();
   	}}
   	onClose={() => {
   		settings.setOutlineOpen(false);
   		dispatchFocusEditor();
   	}}
   />
   ```

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0;
`bun run build` → exit 0.

### Step 9a: Verify the preview pane DOM selector

Before finalizing Step 9's preview fallback, read
`components/workspace/pane-shell.tsx` to confirm whether a `data-pane-id`
attribute is set on the pane container. If it is, use the scoped selector. If it
is NOT, use only `document.querySelector(".recto-preview")` (note: with multiple
panes showing preview this could target the wrong one — acceptable degradation;
note it in Maintenance). Do NOT add a new attribute to pane-shell unless trivial
and clearly in keeping (if you must, that is a borderline scope expansion — note
it). Confirm `.recto-preview` is the actual class (it is set in
`pane-editor.tsx:490` via `className={`recto-preview ${surfaceClass}`}`).

**Verify**: re-run `bun run build` → exit 0.

### Step 10: Manual smoke test

Run `bun run dev`. In the studio:
- Create a doc with several headings (H1/H2/H3, including a duplicate title and a
  fenced code block containing `### fake`).
- `⌘K`-style: open palette, run "Go to heading…", confirm it lists exactly the
  real headings (no fenced one, indented by depth), and selecting one scrolls
  the editor in **rich**, **raw**, **vim**, and **preview** modes.
- Trigger `Ctrl+Shift+O` → palette opens in headings scope.
- Toggle the outline panel (via palette "Toggle outline panel"); confirm it
  docks right, lists headings indented by depth, clicking jumps, Escape closes,
  and the open state survives a page reload (persisted).

Record any mode where scroll does NOT work — if rich/Milkdown scroll fails AND
the DOM fallback also fails (no heading elements found under the root), see STOP
conditions.

## Test plan

- New file `lib/outline/extract.test.ts` (vitest), modeled structurally on
  `lib/markdown/frontmatter.test.ts`. Cases (all listed in Step 2): nested
  headings (depth + index sequence), no headings (empty), duplicate titles
  (distinct indices), headings inside code fences excluded, inline-markdown
  stripped from text, frontmatter not treated as heading, monotonic offsets.
- No new tests for the React components or the DOM scroll helper (DOM/integration
  is covered by the Step 10 manual smoke — the repo has no component-test
  harness; do not add one).
- Verification: `bun run test` → all pass, including the new `extract.test.ts`
  cases (the existing `vitest run` + bun Convex spike test must still pass).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run biome` exits 0
- [ ] `bun run test` exits 0; `lib/outline/extract.test.ts` exists and its
      cases (nested, none, duplicates, code-fence-excluded) pass
- [ ] `bun run build` exits 0
- [ ] `grep -rn "go-to-heading" lib/keyboard/actions.ts` returns the new action
- [ ] `grep -rn "headings" components/command-palette.tsx` shows the new scope
- [ ] `grep -rn "outlineOpen" lib/studio/use-studio-settings.ts` returns the
      new persisted field
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `components/editor-pane.tsx` is unchanged
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the
  codebase drifted since `a25c506` — the drift-check diff is non-empty).
- The command-palette structure changed such that `scope`, the `sections`
  computation (`:77-78`), or the `Command.Group`/`Command.Item` shape no longer
  matches the excerpt — do not guess a new structure.
- `EditorHandle` (`lib/editor/handle.ts`) gained or lost methods vs the excerpt,
  or `getPrimaryHandle` in `document-registry.ts` changed signature.
- Scroll-to-heading fails in **every** mode: i.e. for an editable mode the
  handle's `getRootElement()` returns an element but `querySelectorAll("h1…h6")`
  is empty (editors don't render heading elements the way assumed), AND the
  preview `.recto-preview` fallback also finds no headings. (If it works in some
  modes and not others, that is NOT a stop — note the failing mode in
  Maintenance and ship.)
- Implementing the feature appears to require modifying `lib/editor/handle.ts`,
  `lib/preview/render.ts`, or any `convex/**` file.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **DOM-index alignment is the core assumption.** `extractOutline` returns
  headings in MDAST document order; the jump picks the Nth rendered `<hN>`. If a
  future editor renders headings out of source order, or renders extra synthetic
  headings (e.g. a TOC widget inside the editor), the index will misalign. A
  more robust future approach: caret-to-position mapping per editor type
  (CodeMirror string offset is already exact; Milkdown would need an MDAST-offset
  → ProseMirror-position map). Deferred here because scroll works universally via
  DOM and caret is already exact for CodeMirror.
- **Caret in rich (Milkdown) mode is best-effort.** `importCaret` there uses
  ProseMirror positions, not string offsets, so the caret may land off the
  heading even though scroll is correct. If exact caret in rich mode becomes
  required, build an MDAST-offset → PM-position translator (use Milkdown's
  parser + `view.state.doc` mapping); do not bolt it onto `EditorHandle`
  without revisiting all four implementations.
- **Preview jump targeting with multiple preview panes**: if the `data-pane-id`
  scoped selector was not available (Step 9a), the fallback `.recto-preview`
  query can target the wrong pane when two preview panes are open. Revisit if
  multi-pane preview becomes common.
- **Debounce/recompute (D3)**: the outline reads from the live handle, not a
  reactive query. If sync timing changes (e.g. the central `useDocumentSync`
  cadence), confirm the outline still refreshes within ~250 ms of edits.
- A reviewer should scrutinize: (1) that no editor implementation or the shared
  handle was modified; (2) that the new palette `headings` scope does not leak
  into the `all`/`documents` scopes; (3) that `outlineOpen` persistence round-trips
  through `loadSettings`.
- Deferred out of scope: heading slugs/anchors in preview HTML (would enable
  `#fragment` deep-links and `id`-based jump), and an "active heading"
  highlight in the panel as the user scrolls (scroll-spy).
