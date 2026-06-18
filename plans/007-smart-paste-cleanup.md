# Plan 007: Smart paste — rich clipboard HTML becomes clean canonical Markdown

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat a25c506..HEAD -- lib/markdown/parse.ts lib/markdown/serialize.ts lib/markdown/stringify-options.ts lib/markdown/normalize.ts lib/markdown/index.ts lib/markdown/corpus.test.ts lib/preview/render.ts lib/editor/milkdown/index.tsx lib/editor/codemirror/index.tsx lib/studio/use-studio-settings.ts lib/studio/settings-context.tsx components/workspace/pane-editor.tsx lib/keyboard/actions.ts components/studio-shell.tsx
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: feature (direction) / bug-prevention (lossless invariant)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

Recto's entire promise is **lossless canonical Markdown** — one document, four
lenses, byte-stable round-trips guarded by `lib/markdown/corpus.test.ts`. Paste
is the single biggest entry point for corruption. When a writer pastes from
Word, Google Docs, or a web page, the clipboard carries `text/html` full of
style spans, `mso-*` attributes, smart quotes (`"` `'` `—`), and broken
structure. Today both editors accept that paste through their built-in handlers:
CodeMirror inserts the raw `text/plain` verbatim (which strips all structure —
a heading becomes a plain line), and Milkdown/ProseMirror parses the raw HTML
through its own DOM parser into nodes that do **not** pass through Recto's
canonical serializer, so the resulting Markdown can drift from the dialect.

This plan routes pasted rich content through the **same unified pipeline** the
rest of the app already uses: `rehype-parse` → sanitize → `rehype-remark` →
`remark-stringify` with the frozen `CANONICAL_STRINGIFY` options. The output is
canonical Markdown by construction, so it survives every round-trip the corpus
asserts. It also adds the user-preferred **switchable setting** (smart paste vs
paste-as-plain-markdown) plus a one-shot "paste as plain text" chord, because
this is a genuine A/B UX fork and the user prefers knobs over fixed picks.

## Current state

### Files and roles

- `lib/markdown/parse.ts` — canonical `parseMarkdown(md) → Root` (remark-parse +
  gfm + frontmatter). No change.
- `lib/markdown/serialize.ts` — canonical `stringifyMdast(Root) → string`
  (remark-stringify with `CANONICAL_STRINGIFY` + gfm + frontmatter). No change.
- `lib/markdown/stringify-options.ts` — the frozen `CANONICAL_STRINGIFY` config.
  **Reuse this exact object** in the new pipeline. No change.
- `lib/markdown/normalize.ts` — `normalizeMarkdown(md)` = parse→stringify
  round-trip. The new converter's output must be fed through this (the editors
  already normalize on insert/seed). No change.
- `lib/markdown/index.ts` — barrel. **Add an export** for the new
  `markdownFromHtml`.
- `lib/preview/render.ts` — the existing rehype/remark pipeline + the sanitize
  schema in use. **Mirror its sanitize approach** (`rehype-sanitize` +
  `defaultSchema`). No change.
- `lib/editor/milkdown/index.tsx` — Milkdown/ProseMirror setup. **Add a paste
  hook** via `editorViewOptionsCtx`.
- `lib/editor/codemirror/index.tsx` — CodeMirror setup. **Add a paste
  `domEventHandler`** extension.
- `lib/studio/use-studio-settings.ts` — persisted studio settings. **Add the
  `smartPaste` boolean + `toggleSmartPaste`.**
- `lib/studio/settings-context.tsx` — context that surfaces settings deep in the
  pane tree. No change (it re-exports the whole api).
- `components/workspace/pane-editor.tsx` — mounts both editors and already reads
  `spellcheck` from `useStudioSettingsContext()` and passes it as a prop.
  **Pass `smartPaste` the same way.**
- `lib/keyboard/actions.ts` — the action registry surfaced by the command
  palette. **Add a `toggle-smart-paste` action.**
- `components/studio-shell.tsx` — the `runAction` switch that maps action ids to
  `settings.*` calls. **Add the `toggle-smart-paste` case.**
- `lib/markdown/corpus.test.ts` — the round-trip guard. New converter output
  must still round-trip; the new test asserts this explicitly.

### Key excerpt — `lib/markdown/stringify-options.ts` (reuse verbatim)

```ts
// lib/markdown/stringify-options.ts:1-18
import type { Options as StringifyOptions } from "remark-stringify";

/** Frozen remark-stringify config — single serialization truth (06-markdown-dialect §2.2). */
export const CANONICAL_STRINGIFY: Readonly<StringifyOptions> = Object.freeze({
	bullet: "-",
	emphasis: "_",
	strong: "*",
	fence: "`",
	fences: true,
	listItemIndent: "one",
	rule: "-",
	ruleRepetition: 3,
	ruleSpaces: false,
	setext: false,
	incrementListMarker: true,
	tightDefinitions: true,
	resourceLink: true,
});
```

### Key excerpt — `lib/preview/render.ts` (mirror the sanitize approach)

```ts
// lib/preview/render.ts:1-23
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { parseMarkdown } from "@/lib/markdown/parse";

const sanitizeSchema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames ?? []), "br"],
};

const previewProcessor = unified()
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeSanitize, sanitizeSchema)
	.use(rehypeStringify);

/** Render canonical MDAST to sanitized HTML for preview mode. */
export function renderPreviewHtml(markdown: string): string {
	const tree = parseMarkdown(markdown);
	const hast = previewProcessor.runSync(tree);
	return previewProcessor.stringify(hast);
}
```

### Key excerpt — Milkdown editor setup (where to hook paste)

The editor is built with `Editor.make().config(...).use(...)`. The
`editorViewCtx`/`parserCtx` are already pulled out. `editorViewOptionsCtx`
(from `@milkdown/core`) accepts a `Partial<EditorOptions>` where
`EditorOptions = Omit<DirectEditorProps, "state">` — i.e. ProseMirror's
`EditorProps`, which is where `handlePaste`/`transformPastedHTML` live (verified
in `node_modules/@milkdown/core/lib/internal-plugin/editor-view.d.ts:3,7` and
`node_modules/prosemirror-view/dist/index.d.ts:700,736`).

```tsx
// lib/editor/milkdown/index.tsx:86-131 (current — abridged)
useEditor((root) => {
	rootRef.current = root;
	const editor = Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, root);
			ctx.set(defaultValueCtx, "");
			parserRef.current = ctx.get(parserCtx);
			ctx.set(rectoSlash.key, { /* slash view */ });
			ctx.set(rectoSelectionTooltip.key, { /* selection view */ });
		})
		.use(commonmark)
		.use(gfm)
		.use(rectoSlash)
		.use(rectoSelectionTooltip)
		.use(listener)
		.config((ctx) => {
			ctx.get(listenerCtx).markdownUpdated((_ctx, md, prevMd) => {
				if (programmaticRef.current) return;
				if (md !== prevMd) {
					bridgeSessionRef.current?.handleRichUpdate(
						composeFrontmatter(metaRef.current, md, extraRef.current),
					);
					onChangeRef.current?.();
				}
			});
		});
	editor.create().then((created) => { editorRef.current = created; });
	return editor;
}, []);
```

Note: `editorViewCtx` is imported at the top
(`lib/editor/milkdown/index.tsx:1-9`); `parserCtx` too. The parser
(`parserRef.current`) converts a Markdown string into a ProseMirror `Node`
(this is exactly what `BridgeSession.connectRich(pmView, parser)` uses in
`lib/bridge/coordinator.ts:62-65`). You will reuse the same parser to turn
converted Markdown into a ProseMirror slice for insertion.

### Key excerpt — CodeMirror editor setup (where to add a paste handler)

```tsx
// lib/editor/codemirror/index.tsx:254-269 (current extensions array)
const extensions: Extension[] = [
	vimExt,
	spellcheckCompartmentRef.current.of(
		spellcheckAttrs(spellcheckRef.current),
	),
	drawSelection(),
	markdown(),
	updateListener,
	EditorView.lineWrapping,
	EditorState.tabSize.of(2),
];

const view = new EditorView({
	state: EditorState.create({ doc: "", extensions }),
	parent: containerRef.current,
});
```

`EditorView`, `Compartment`, `EditorState`, `Extension`, `Transaction` are
already imported (`lib/editor/codemirror/index.tsx:3-11`). The component already
takes a `spellcheck` prop and reconfigures it via a `Compartment` (lines
36-38, 296-304). You will add a `smartPaste` prop and a paste
`domEventHandler` extension that reads it via a ref (so a setting change does not
require re-creating the view — match the `spellcheckRef`/`vimEnabledRef`
pattern at lines 224-227).

### Key excerpt — settings hook (where to add the toggle)

```ts
// lib/studio/use-studio-settings.ts:21-44 (current type + defaults)
export type StudioSettings = {
	theme: Theme;
	readingFont: ReadingFont;
	readingScale: number;
	spellcheck: boolean;
	topToolbar: boolean;
};

const DEFAULTS: StudioSettings = {
	theme: "twilight",
	readingFont: "sans",
	readingScale: 1,
	spellcheck: true,
	topToolbar: true,
};
```

`loadSettings()` (lines 57-85) validates each field on read; `setSettings`
persists to `localStorage` under `STORAGE_KEY = "recto:studio-settings"`. Each
boolean toggle follows the `toggleSpellcheck` shape (lines 157-159) and is
returned from the hook (lines 165-176). `toggleSpellcheck` is the exact
structural model — copy it.

### Key excerpt — how a toggle is dispatched + handled

- Action declared in `lib/keyboard/actions.ts` (the `ACTIONS` array; the
  `toggle-spellcheck` entry is at lines 247-253). Empty `shortcut` means
  palette-only (no chord), which is what `toggle-smart-paste` will use.
- Handled in `components/studio-shell.tsx` `runAction` switch
  (lines 351-353):
  ```ts
  case "toggle-spellcheck":
  	settings.toggleSpellcheck();
  	return;
  ```

### Design constraints (inlined from project memory + CLAUDE)

- **Switchable setting, not a hard pick.** Memory note "Recto: prefer user
  toggles" — for A/B design forks in Recto, build a switchable setting, don't
  pick one. Smart-paste-on vs paste-plain-markdown is exactly such a fork.
- **Lossless canonical Markdown is sacred.** All MDAST↔string crossing lives in
  `lib/markdown/`. The new converter belongs there
  (`lib/markdown/from-html.ts`), reusing `CANONICAL_STRINGIFY` so its output is
  the same dialect as everything else.
- **Prefer the existing ecosystem over Turndown.** The repo already depends on
  unified/rehype/remark. A `rehype-parse` → `rehype-remark` → `remark-stringify`
  pipeline reuses the canonical stringify config (lossless-consistent output)
  and adds no second Markdown dialect. Turndown would introduce a separate
  serializer with its own rules — rejected for that reason.
- **Editor owns live state.** Never bind editor value to a reactive `useQuery`.
  Paste mutates the editor directly (CM transaction / PM transaction), and the
  existing `updateListener` / `markdownUpdated` listener forwards the change to
  `bridgeSession` + sync — you do NOT call sync directly from the paste handler.
- **UI = compose existing primitives; dark-only; no one-off styles.** This plan
  adds no new visible chrome beyond one command-palette entry.

## Commands you will need

| Purpose      | Command                                              | Expected on success            |
|--------------|-----------------------------------------------------|--------------------------------|
| Add deps     | `bun add rehype-parse rehype-remark`                | exit 0; both in `package.json` |
| Install      | `bun install`                                       | exit 0                         |
| Typecheck    | `bun run typecheck`                                 | exit 0, no errors              |
| Lint/format  | `bun run biome`                                      | exit 0 (no errors)             |
| Unit tests   | `bun run test`                                       | all pass                       |
| New test only| `bunx vitest run lib/markdown/from-html.test.ts`    | all pass                       |
| Corpus guard | `bunx vitest run lib/markdown/corpus.test.ts`        | all pass (unchanged)           |
| Build        | `bun run build`                                      | exit 0                         |
| Dev (manual) | `bun run dev`                                        | studio loads at localhost      |

(`bun run test` runs `vitest run && bun test spikes/.../convex.bun.test.ts` —
see `package.json` scripts. Use the targeted `bunx vitest run <file>` while
iterating, then the full `bun run test` for the done gate.)

## Suggested executor toolkit

- Use the context7 MCP (`resolve-library-id` then `query-docs`) for
  `rehype-remark` if you need its handler/option surface — it is a thin wrapper
  over `hast-util-to-mdast`. Do not guess option names; verify.
- Reference: `lib/markdown/frontmatter.test.ts` and
  `lib/markdown/count-words.test.ts` are the structural model for the new
  Vitest file (describe/it, `@/lib/...` imports).

## Scope

**In scope** (the only files you should modify or create):

- `lib/markdown/from-html.ts` (create) — the HTML→canonical-Markdown converter.
- `lib/markdown/from-html.test.ts` (create) — its tests.
- `lib/markdown/index.ts` (edit) — export `markdownFromHtml`.
- `lib/editor/codemirror/index.tsx` (edit) — `smartPaste` prop + paste handler.
- `lib/editor/milkdown/index.tsx` (edit) — paste hook via `editorViewOptionsCtx`.
- `lib/studio/use-studio-settings.ts` (edit) — `smartPaste` setting + toggle.
- `components/workspace/pane-editor.tsx` (edit) — read + pass `smartPaste`.
- `lib/keyboard/actions.ts` (edit) — `toggle-smart-paste` action.
- `components/studio-shell.tsx` (edit) — handle `toggle-smart-paste`.
- `package.json` / `bun.lock` (edit, via `bun add`) — new deps.

**Out of scope** (do NOT touch, even though they look related):

- `lib/markdown/parse.ts`, `serialize.ts`, `stringify-options.ts`,
  `normalize.ts` — the canonical core. Reuse them; do not modify them. Changing
  `CANONICAL_STRINGIFY` would re-flow every existing document.
- `lib/preview/render.ts` — read it as the sanitize exemplar only; do not edit.
- `lib/bridge/*` — the live bridge already propagates editor edits; paste flows
  through the existing listeners. Do not add a bridge code path.
- `convex/*` and any sync code — Convex is the write path but paste is a normal
  editor edit; the existing debounced sync picks it up. No Convex change.
- `lib/markdown/corpus/*` and `lib/markdown/corpus.test.ts` — the guard must keep
  passing untouched; do not relax or edit it.

## Git workflow

- Branch: `advisor/007-smart-paste-cleanup`.
- Commit per logical unit; conventional commits, **no AI attribution**, author =
  the user. Example messages (match `git log` style):
  - `feat: convert pasted HTML to canonical markdown`
  - `feat: smart-paste toggle in both editors`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the dependencies

```
bun add rehype-parse rehype-remark
```

These are unified plugins already compatible with the installed
`unified@^11`, `rehype-sanitize@^6`, `remark-stringify@^11`, `remark-gfm@^4`.

**Verify**: `grep -E '"rehype-(parse|remark)"' package.json` → both lines
present. `bun run typecheck` → exit 0.

### Step 2: Create the HTML→canonical-Markdown converter

Create `lib/markdown/from-html.ts`. It is a pure, synchronous function that
takes a clipboard `text/html` string and returns canonical Markdown. Pipeline,
in order: `rehype-parse` (HTML→hast) → `rehype-sanitize` (drop scripts, styles,
`mso-*` junk — mirror `lib/preview/render.ts`) → `rehype-remark` (hast→mdast) →
`remark-gfm` (so tables/strikethrough/task-lists survive) → `remark-stringify`
with `CANONICAL_STRINGIFY`.

Target shape (verify plugin/option names against installed types before
finalizing — do not invent options):

```ts
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { normalizeMarkdown } from "./normalize";
import { CANONICAL_STRINGIFY } from "./stringify-options";

// Mirror lib/preview/render.ts: keep <br>, drop everything dangerous/styling.
const sanitizeSchema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames ?? []), "br"],
};

const htmlToMarkdownProcessor = unified()
	.use(rehypeParse, { fragment: true })
	.use(rehypeSanitize, sanitizeSchema)
	.use(rehypeRemark)
	.use(remarkGfm)
	.use(remarkStringify, CANONICAL_STRINGIFY);

/**
 * Convert clipboard `text/html` into canonical Markdown. The output uses the
 * same dialect as the rest of Recto (CANONICAL_STRINGIFY) and is run through
 * normalizeMarkdown so it is guaranteed round-trip-stable before it ever
 * reaches an editor surface.
 */
export function markdownFromHtml(html: string): string {
	const out = String(htmlToMarkdownProcessor.processSync(html));
	// Defensive: editors normalize on insert anyway, but converging here keeps
	// the function's contract "canonical Markdown" true in isolation.
	return normalizeMarkdown(out);
}
```

Notes the executor must honor:

- `rehypeParse` with `{ fragment: true }` — clipboard HTML is a fragment, not a
  full document. Verify this option exists on the installed `rehype-parse`
  types; if the shape differs, STOP and report (do not silently drop the
  option).
- Smart quotes / NBSP / em-dashes: `rehype-remark` carries the literal
  characters from the source HTML into mdast text nodes. The repo's normalize
  path does **not** transliterate them, and that is fine for body text —
  canonical Markdown is UTF-8 and `"` `'` `—` are valid content (the corpus and
  `frontmatter.test.ts:36-45` already round-trip a `"hello"` / `—` string). Do
  NOT add a smart-quote transliteration step unless a test in Step 4 proves a
  round-trip failure; if one does, narrow it (a targeted `String.prototype`
  replace inside `markdownFromHtml` only) and document it in a code comment.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Export the converter from the markdown barrel

In `lib/markdown/index.ts`, add (alphabetical-ish, next to the other exports):

```ts
export { markdownFromHtml } from "./from-html";
```

**Verify**: `grep -n markdownFromHtml lib/markdown/index.ts` → one match.
`bun run typecheck` → exit 0.

### Step 4: Write the converter tests

Create `lib/markdown/from-html.test.ts`, modeled on
`lib/markdown/frontmatter.test.ts` (Vitest `describe`/`it`, `@/lib/...`
imports). Each case asserts (a) the converted Markdown equals an expected
canonical string AND (b) the output **round-trips** (`normalizeMarkdown(out) ===
out`). Cover, at minimum:

- **Word-style bold/italic**: `<b>bold</b> and <i>ital</i>` →
  `**bold** and _ital_` (canonical: `*` strong, `_` emphasis — see
  `CANONICAL_STRINGIFY`). Also `<strong>`/`<em>` forms.
- **Headings**: `<h1>Title</h1><h2>Sub</h2>` → `# Title` / `## Sub` (ATX, since
  `setext: false`).
- **Nested lists** (Word/Docs export deeply nested `<ul><li>...<ul>...`):
  assert bullets use `-` and one-space indent (`listItemIndent: "one"`).
- **Ordered list**: `<ol><li>a</li><li>b</li></ol>` → `1. a` / `2. b`.
- **Links**: `<a href="https://x.com">x</a>` → `[x](https://x.com)`.
- **GFM table**: a simple `<table>` with `<thead>`/`<tbody>` → a pipe table
  (this exercises the `remarkGfm` plug).
- **Smart quotes / em-dash**: input containing `“hi” — there` survives and
  round-trips (assert `normalizeMarkdown(out) === out`).
- **Junk stripped**: `<p style="mso-x">t</p><script>bad()</script>` → `t` with
  no `<script>`, no `style` leakage.
- **Plain paragraph**: `<p>just text</p>` → `just text`.

Structural model to copy (from `frontmatter.test.ts:1-19`):

```ts
import { describe, expect, it } from "vitest";
import { markdownFromHtml } from "@/lib/markdown/from-html";
import { normalizeMarkdown } from "@/lib/markdown/normalize";

describe("markdownFromHtml", () => {
	it("converts Word-style bold/italic to canonical markers", () => {
		const out = markdownFromHtml("<p><b>bold</b> and <i>ital</i></p>");
		expect(out.trim()).toBe("**bold** and _ital_");
		expect(normalizeMarkdown(out)).toBe(out); // round-trip stable
	});
	// ...remaining cases
});
```

IMPORTANT: run the test FIRST and read the ACTUAL output before writing the
`expect(...).toBe(...)` strings — `rehype-remark` whitespace/escaping has exact
output you must observe, not guess. Paste the observed canonical string into the
assertion. (Per VERIFY-BEFORE-TEACHING: assert against verified output, not
assumptions.)

**Verify**: `bunx vitest run lib/markdown/from-html.test.ts` → all pass.

### Step 5: Add the `smartPaste` setting

In `lib/studio/use-studio-settings.ts`:

1. Add `smartPaste: boolean;` to the `StudioSettings` type (after `topToolbar`).
2. Add `smartPaste: true` to `DEFAULTS`.
3. In `loadSettings`, validate it like the other booleans:
   ```ts
   smartPaste:
   	typeof parsed.smartPaste === "boolean"
   		? parsed.smartPaste
   		: DEFAULTS.smartPaste,
   ```
4. Add `toggleSmartPaste: () => void;` to `StudioSettingsApi`.
5. Add the callback (model after `toggleSpellcheck`, lines 157-159):
   ```ts
   const toggleSmartPaste = useCallback(() => {
   	setSettings((s) => ({ ...s, smartPaste: !s.smartPaste }));
   }, []);
   ```
6. Return `toggleSmartPaste` from the hook's return object.

`settings-context.tsx` needs **no change** (it re-exposes the whole api).

**Verify**: `bun run typecheck` → exit 0.

### Step 6: Wire the CodeMirror paste handler

In `lib/editor/codemirror/index.tsx`:

1. Add `smartPaste?: boolean;` to `CodeMirrorEditorProps` (default `true` at the
   destructure, like `spellcheck = true`).
2. Add a `smartPasteRef` updated each render (mirror `spellcheckRef`,
   lines 226-227): `const smartPasteRef = useRef(smartPaste); smartPasteRef.current = smartPaste;`.
3. Add `markdownFromHtml` to the existing `@/lib/markdown` import.
4. Add a paste `domEventHandler` to the `extensions` array (Step "Key excerpt —
   CodeMirror"). Shape:
   ```ts
   EditorView.domEventHandlers({
   	paste(event, view) {
   		const data = event.clipboardData;
   		if (!data) return false; // let CM handle it
   		const html = data.getData("text/html");
   		const text = data.getData("text/plain");
   		// Smart paste only acts when there is rich HTML and the setting is on.
   		if (!smartPasteRef.current || !html) return false;
   		const md = markdownFromHtml(html);
   		if (!md.trim()) return false;
   		event.preventDefault();
   		const { from, to } = view.state.selection.main;
   		view.dispatch({
   			changes: { from, to, insert: md },
   			selection: { anchor: from + md.length },
   		});
   		return true;
   	},
   }),
   ```
   Returning `false` (and not calling `preventDefault`) leaves CM's default
   paste intact — which inserts `text/plain` verbatim. That IS the
   "paste as plain markdown" branch, so no extra code is needed for the off
   state. This insertion is a real user edit (no `bridgeOrigin` annotation /
   no `programmaticRef`), so the existing `updateListener` (lines 241-252)
   forwards it to `bridgeSession.handleRawUpdate` + `onChange` automatically.

**Verify**: `bun run typecheck` → exit 0. `bun run biome` → exit 0.

### Step 7: Wire the Milkdown / ProseMirror paste hook

In `lib/editor/milkdown/index.tsx`:

1. Import `editorViewOptionsCtx` from `@milkdown/core` (add to the existing
   import block, lines 3-9).
2. Add `markdownFromHtml` to the `@/lib/markdown` import (lines 39-45).
3. Add a `smartPaste` prop to `InnerProps` and `MilkdownEditorProps`, threaded
   through `MilkdownEditor` → `MilkdownEditorInner` (mirror how `onMeta` is
   threaded). Hold it in a ref updated each render:
   `const smartPasteRef = useRef(smartPaste); smartPasteRef.current = smartPaste;`
   (mirror `onChangeRef`, lines 71, 82).
4. In the first `.config((ctx) => {...})` block (lines 89-107), set the view
   options with a `handlePaste`:
   ```ts
   ctx.set(editorViewOptionsCtx, {
   	editorProps: {
   		handlePaste: (view, event) => {
   			if (!smartPasteRef.current) return false;
   			const html = event.clipboardData?.getData("text/html");
   			if (!html) return false; // no rich content — default paste
   			const md = markdownFromHtml(html);
   			if (!md.trim()) return false;
   			const parser = parserRef.current;
   			if (!parser) return false;
   			const doc = parser(md);
   			if (!doc) return false;
   			// Insert the parsed slice at the current selection through the
   			// canonical parser — NOT through ProseMirror's own HTML DOM parser.
   			const { from, to } = view.state.selection;
   			const tr = view.state.tr.replaceWith(from, to, doc.content);
   			view.dispatch(tr);
   			return true; // we handled it
   		},
   	},
   });
   ```
   `parserRef.current` is the Milkdown parser already captured at line 92
   (`parserCtx`). It maps a Markdown string to a ProseMirror `Node` whose
   `.content` is the fragment to insert. This is the **same canonical path**
   `BridgeSession` uses (`coordinator.ts:40`). Because the dispatched
   transaction is a normal user edit (no `programmaticRef`, no `BRIDGE_META`),
   the existing `markdownUpdated` listener (lines 113-124) forwards the new
   canonical Markdown to `bridgeSession.handleRichUpdate` + `onChange`.

   **Why `handlePaste` and not `transformPastedHTML`**: `transformPastedHTML`
   returns HTML that ProseMirror then parses with its OWN DOM parser — that
   bypasses Recto's canonical Markdown pipeline and can yield non-canonical
   nodes. `handlePaste` lets us run the unified pipeline and re-enter through the
   Milkdown parser, preserving the lossless invariant. Both are available in
   this version (verified: `prosemirror-view@1.41.8` d.ts lines 700, 736).

5. When `smartPaste` is off, `handlePaste` returns `false` and Milkdown's
   default paste runs (its commonmark/gfm clipboard parser). That is the
   "paste as plain" branch for the rich editor — acceptable and no extra code.

**Verify**: `bun run typecheck` → exit 0. `bun run biome` → exit 0.

### Step 8: Pass `smartPaste` from the pane editor

In `components/workspace/pane-editor.tsx`:

1. Destructure `smartPaste` from `useStudioSettingsContext()` alongside
   `spellcheck` (line 60): `const { spellcheck, smartPaste } = useStudioSettingsContext();`.
2. Pass `smartPaste={smartPaste}` to both `<MilkdownEditor ...>` (lines 464-470)
   and `<CodeMirrorEditor ...>` (lines 474-482).

**Verify**: `bun run typecheck` → exit 0.

### Step 9: Add the command-palette toggle

1. In `lib/keyboard/actions.ts`:
   - Add `"toggle-smart-paste"` to the `ActionId` union (near
     `toggle-spellcheck`, line 45).
   - Add an `ACTIONS` entry (model after `toggle-spellcheck`, lines 247-253):
     ```ts
     {
     	id: "toggle-smart-paste",
     	label: "Toggle smart paste (HTML → Markdown)",
     	section: "View",
     	aliases: ["paste", "clean paste", "word", "google docs"],
     	shortcut: { mac: "", other: "" },
     },
     ```
     (Empty shortcut = palette-only, no chord — matches the other View toggles.)
2. In `components/studio-shell.tsx` `runAction` switch (near line 351), add:
   ```ts
   case "toggle-smart-paste":
   	settings.toggleSmartPaste();
   	return;
   ```
   If there is a second action map in that file (the drift check noted a
   `toggleSpellcheck` reference at line ~622 in a settings sheet/menu), and it
   exposes spellcheck as a visible toggle control, add a parallel smart-paste
   control there for parity. If it is unrelated, leave it.

**Verify**: `bun run typecheck` → exit 0. `bun run biome` → exit 0.

### Step 10: Full gate + manual smoke

Run the full suite and build.

**Verify**:
- `bun run test` → all pass (including the new `from-html.test.ts` and the
  unchanged `corpus.test.ts`).
- `bun run biome` → exit 0.
- `bun run build` → exit 0.
- Manual (`bun run dev`): copy a few formatted paragraphs (bold, a heading, a
  bullet list, a link) from a Google Doc or a web page; paste into the rich
  (Milkdown) pane → clean structure, no style spans. Switch the same pane to raw
  mode → the Markdown is canonical (`-` bullets, `*`/`_` emphasis). Paste the
  same clipboard into a raw pane → same canonical Markdown. Toggle "smart paste"
  off in the command palette → paste now inserts plain text (CM) / commonmark
  default (Milkdown).

## Test plan

- **New file** `lib/markdown/from-html.test.ts` — cases listed in Step 4
  (Word bold/italic, headings, nested + ordered lists, links, GFM table, smart
  quotes/em-dash round-trip, junk/script stripped, plain paragraph). Every case
  asserts both the exact canonical output AND `normalizeMarkdown(out) === out`.
- **Structural model**: `lib/markdown/frontmatter.test.ts` (describe/it,
  `@/lib/...` imports, round-trip/idempotence assertions).
- **Guard unchanged**: `lib/markdown/corpus.test.ts` must still pass with zero
  edits — proof the canonical core was not disturbed.
- **Verification**: `bun run test` → all pass, including the N new
  `from-html` cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run biome` exits 0
- [ ] `bun run test` exits 0; `lib/markdown/from-html.test.ts` exists and its
      cases (bold/italic, headings, nested+ordered lists, link, table, smart
      quotes, junk-stripped, plain) all pass
- [ ] `bun run build` exits 0
- [ ] `bunx vitest run lib/markdown/corpus.test.ts` passes with no edits to
      `lib/markdown/corpus*`
- [ ] `grep -rn "markdownFromHtml" lib/markdown/index.ts lib/editor/codemirror/index.tsx lib/editor/milkdown/index.tsx` → at least one match each (converter is wired into both editors)
- [ ] `grep -rn "smartPaste" lib/studio/use-studio-settings.ts components/workspace/pane-editor.tsx` → matches in both
- [ ] `grep -rn "toggle-smart-paste" lib/keyboard/actions.ts components/studio-shell.tsx` → matches in both
- [ ] `grep -rn "Turndown\|turndown" lib components` → no matches (we did NOT add Turndown)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (if the index exists)

## STOP conditions

Stop and report back (do not improvise) if:

- The code at any "Current state" excerpt location does not match the live file
  (drift since `a25c506`).
- `rehype-remark` (or `rehype-parse`/`rehype-sanitize`) **silently drops a
  construct that Recto's dialect supports** — e.g. a GFM table, task list,
  strikethrough, or nested list comes out empty or as raw text after conversion.
  Do NOT ship a converter that loses a supported construct. Narrow the cause
  (missing `remarkGfm`, sanitize schema stripping the tag, a `rehype-remark`
  handler gap) and document it; if it cannot be fixed without a custom handler,
  STOP and report with the failing input.
- `editorViewOptionsCtx` is not exported by the installed `@milkdown/core`, or
  `handlePaste`/`transformPastedHTML` is not present on this `prosemirror-view`
  version (re-verify against `node_modules` d.ts files). Report — do not fall
  back to a global `document` paste listener.
- The Milkdown parser (`parserRef.current`) is null at paste time in normal use
  (not just during mount), or `parser(md)` throws / returns a node whose
  `.content` cannot be inserted with `replaceWith`. Report the symptom.
- A `from-html` test reveals a **round-trip failure** that cannot be fixed by a
  narrow, documented normalization inside `markdownFromHtml` (e.g. it would
  require editing `CANONICAL_STRINGIFY` or the canonical core). Report it —
  never relax the corpus guard to make it pass.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this after it lands:

- **PR reviewer should scrutinize**: that paste in BOTH editors goes through
  `markdownFromHtml` (not ProseMirror's `transformPastedHTML` DOM path), and
  that the converted insertion is a normal (non-programmatic) edit so the
  existing bridge/sync listeners forward it. Confirm the corpus test is
  untouched.
- **Future interaction**: if the Markdown dialect changes (any edit to
  `CANONICAL_STRINGIFY`), `from-html.ts` automatically follows since it imports
  the same object — but the `from-html.test.ts` expected strings will need
  re-baselining. Note this in the test file header.
- **Deferred out of scope (by design)**: image paste (binary clipboard items),
  pasting a file, and transliterating smart quotes to ASCII. Smart quotes are
  kept as valid UTF-8 content; revisit only if a writer reports wanting ASCII
  normalization — that would be a new opt-in setting, not a silent transform.
- The one-shot "paste as plain text" was specified in intent; this plan delivers
  the persistent toggle (the primary fork) and treats the toggle-off state as
  the plain branch. If a per-paste chord is still wanted, add a future
  `Ctrl+Shift+V` capture in `app-shortcuts.ts` that sets a transient
  "next paste plain" flag read by both paste handlers — flagged here as a small
  follow-up, intentionally not bundled to keep this plan's blast radius small.
```
