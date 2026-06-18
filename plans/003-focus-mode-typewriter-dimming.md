# Plan 003: Deep-focus writing mode — typewriter scroll + sentence/paragraph dimming

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist yet, create it
> using the schema at the bottom of this file, listing plans 001, 002, 003.)
>
> **Drift check (run first)**:
> ```
> git diff --stat a25c506..HEAD -- lib/editor/codemirror/index.tsx lib/editor/milkdown/index.tsx components/workspace/pane-editor.tsx components/status-bar.tsx components/studio-shell.tsx lib/keyboard/app-shortcuts.ts lib/keyboard/actions.ts lib/studio/use-studio-settings.ts lib/studio/settings-context.tsx app/globals.css
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: feature (direction)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

Recto already has **zen mode** (`StudioWorkspace`'s `zen` state hides chrome and
goes fullscreen), but it lacks the in-text focus features that most make "the
tool disappear": **typewriter scrolling** (keep the caret line vertically
centered) and **focus dimming** (dim everything except the current sentence or
paragraph). iA Writer and Typora set the bar here, and they are the single
biggest reason writers describe those tools as "calm". This plan adds both, in
**both** editable surfaces (CodeMirror 6 for raw/vim, Milkdown/ProseMirror for
rich), exposed as **remembered user toggles** (per the project's standing
preference for knobs over fixed picks): typewriter on/off, dimming on/off, and a
sentence-vs-paragraph dim scope. The preview pane is read-only and out of scope.

What "done" looks like: with focus mode on, typing keeps the active line pinned
to the vertical middle of the viewport, and all text except the current sentence
(or paragraph) fades to a dimmer ink colour, both transitioning smoothly. The
caveat iA itself documents — **typewriter centering must be suppressed while a
selection is being made/extended**, or it janks as the user drags — is honored.

## Background you need (the executor has not seen the codebase)

Recto is a single-user, dark-only, keyboard-first Markdown writing studio.
One canonical Markdown document is edited through four "lenses": **rich**
(Milkdown / ProseMirror), **raw** and **vim** (both the same CodeMirror 6
instance, vim toggled via a Compartment), and **preview** (read-only). Stack:
Next.js 16 on Bun, React 19, Convex (only the write path), Clerk, Tailwind v4
with dark OKLCH design tokens in `app/globals.css`, Biome, Vitest (happy-dom).

Key architectural facts that constrain this work:

1. **The live editor mount is `components/workspace/pane-editor.tsx`**, rendered
   recursively by `components/workspace/render-pane-node.tsx`. There is ALSO a
   file `components/editor-pane.tsx` that looks like the editor mount but is
   **dead code with zero importers** — do NOT edit it (see Scope).
2. Each pane reads studio settings via `useStudioSettingsContext()`
   (`lib/studio/settings-context.tsx`). Add the new focus settings there and
   they reach both editors for free, the same way `spellcheck` already does.
3. The editor owns live state. Settings are remembered in `localStorage`, NOT
   in Convex. Never bind an editor's value to a reactive query.
4. UI is composed from existing patterns/tokens — no raw one-off colours.
   Reuse the OKLCH `--color-ink-*` tokens and the `--motion-*` / `--ease-*`
   tokens already in `globals.css`.

## Current state

### Files and their roles

- `components/workspace/pane-editor.tsx` — **the live per-pane editor mount.**
  Renders `MilkdownEditor` (rich), `CodeMirrorEditor` (raw/vim), and
  `PreviewPane`. Already consumes settings via `useStudioSettingsContext()`
  (line 60: `const { spellcheck } = useStudioSettingsContext();`) and threads
  `spellcheck` into `CodeMirrorEditor` (line 480). You will thread the new focus
  settings the same way.
- `lib/editor/codemirror/index.tsx` — the CodeMirror 6 editor. Builds the
  `extensions` array and reconfigures `vim`/`spellcheck` via `Compartment`s.
  You add a focus `Compartment` (typewriter ViewPlugin + dim decoration plugin).
- `lib/editor/milkdown/index.tsx` — the Milkdown editor. Builds a ProseMirror
  editor via `Editor.make().config(...).use(...)`. You add a ProseMirror
  `Plugin` (decorations for dimming + scroll-to-center on selection change).
- `lib/editor/milkdown/selection-toolbar-view.tsx` — **exemplar** of a
  ProseMirror `PluginView` already in this repo; mirror its style for any
  view-side logic.
- `lib/editor/focus-range.ts` — **NEW**, pure module. Given plain text + a caret
  offset, returns the `[from, to)` char range of the active sentence or
  paragraph. Tested in isolation (this is the only unit-testable piece).
- `lib/editor/focus-range.test.ts` — **NEW**, Vitest tests for the above.
- `components/status-bar.tsx` — the bottom toolbar with the existing toggles
  (theme, font, zoom, spellcheck, zen). You add focus-mode toggles here.
- `components/studio-shell.tsx` — wires `useStudioSettings()` into the provider
  and into `<StatusBar .../>`; holds the `dispatch(id)` action switch and the
  keyboard handler. You wire the new toggle props + actions here.
- `lib/keyboard/actions.ts` — the action registry (`ActionId` union + `ACTIONS`
  array) feeding both the chord handler and the command palette. Add focus
  actions here.
- `lib/keyboard/app-shortcuts.ts` — the capture-phase chord handler. The zen
  toggle (`Ctrl+⇧+F`) lives here. Add a focus-mode chord following the pattern.
- `lib/studio/use-studio-settings.ts` — the persisted settings hook
  (`StudioSettings` shape, `DEFAULTS`, `loadSettings`, the `*Api` type). Add the
  three focus settings + their setters here.
- `lib/studio/settings-context.tsx` — context wrapper around the hook's return.
  No structural change needed (it passes the whole `StudioSettingsApi` through);
  the new fields flow automatically once added to the hook.
- `app/globals.css` — design tokens + component layer. Add the dim styling here.

### Excerpt: `lib/editor/codemirror/index.tsx` (current extensions + compartments)

Lines 222–283 — the Compartment refs and the `extensions` array. Note the
**existing pattern**: a `Compartment` ref per reconfigurable concern, seeded in
the `of(...)` at create time, and `reconfigure`d in a `useEffect` keyed on the
prop. You will add a `focusCompartmentRef` exactly like this.

```tsx
const vimCompartmentRef = useRef(new Compartment());
const spellcheckCompartmentRef = useRef(new Compartment());
// ...
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

And the existing reconfigure pattern (lines 296–304) you will copy for focus:

```tsx
useEffect(() => {
	const view = viewRef.current;
	if (!view) return;
	view.dispatch({
		effects: spellcheckCompartmentRef.current.reconfigure(
			spellcheckAttrs(spellcheck),
		),
	});
}, [spellcheck]);
```

CM imports already present (line 10): `import { drawSelection, EditorView } from "@codemirror/view";`
You will extend this to also import `Decoration`, `type DecorationSet`,
`ViewPlugin`, `type ViewUpdate`. (Verified available in `@codemirror/view@^6.43.0`.)

### Excerpt: `lib/editor/milkdown/index.tsx` (how plugins are added)

Lines 86–131 — the editor is built with `.config(...)` (sets ctx, slash,
tooltip) chained with `.use(commonmark).use(gfm).use(rectoSlash)...`. ProseMirror
plugins are NOT added here directly; Milkdown wraps them via `$prose` from
`@milkdown/utils`, or you add a raw ProseMirror plugin through the
`prosePluginsCtx`. The **simplest, lowest-risk** path that matches this repo:
use `$prose` (it returns a Milkdown plugin you `.use(...)` like the others).

```tsx
const editor = Editor.make()
	.config((ctx) => {
		ctx.set(rootCtx, root);
		ctx.set(defaultValueCtx, "");
		parserRef.current = ctx.get(parserCtx);
		ctx.set(rectoSlash.key, { /* ... */ });
		ctx.set(rectoSelectionTooltip.key, { /* ... */ });
	})
	.use(commonmark)
	.use(gfm)
	.use(rectoSlash)
	.use(rectoSelectionTooltip)
	.use(listener)
	.config((ctx) => {
		ctx.get(listenerCtx).markdownUpdated((_ctx, md, prevMd) => { /* ... */ });
	});
```

Existing PM imports (line 27): `import { TextSelection } from "@milkdown/prose/state";`
You will import `Plugin`, `PluginKey` from `@milkdown/prose/state` and
`Decoration`, `DecorationSet` from `@milkdown/prose/view`. (Verified:
`@milkdown/prose/state` re-exports `prosemirror-state`; `@milkdown/prose/view`
re-exports `prosemirror-view`. `$prose` is exported from `@milkdown/utils`,
which is already a dependency.)

### Excerpt: `components/status-bar.tsx` (toggle pattern)

The spellcheck toggle (lines 255–264) and zen toggle (lines 269–278) are the
exact pattern to copy — an `iconBtn` button with `aria-pressed`, `title`, and
the accent colour when active. `iconBtn` is defined at line 109.

```tsx
<button
	type="button"
	className={cn(iconBtn, spellcheck && "text-[var(--color-accent)]")}
	onClick={onToggleSpellcheck}
	aria-pressed={spellcheck}
	title={`Spellcheck: ${spellcheck ? "On" : "Off"}`}
	aria-label="Toggle spellcheck"
>
	<SpellCheck aria-hidden className="size-[15px]" />
</button>
```

Icons come from `lucide-react` (import at top, lines 3–13). The props arrive via
`StatusBarProps` (lines 36–56) and are destructured in the `StatusBar(...)`
signature (lines 147–166). The secondary controls live inside the
`hidden ... sm:flex` cluster (line 196) — desktop only; everything stays
reachable from the command palette on mobile.

### Excerpt: `lib/studio/use-studio-settings.ts` (settings shape)

```ts
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

`loadSettings()` (lines 57–85) validates each field out of `localStorage` under
key `recto:studio-settings`; the `StudioSettingsApi` type (lines 87–97) is
`StudioSettings & { ...setters }`; the hook (lines 103–177) defines each setter
with `useCallback` and returns `{ ...settings, ...setters }`. The `toggleSpellcheck`
setter (lines 157–159) is the exemplar for a boolean toggle:

```ts
const toggleSpellcheck = useCallback(() => {
	setSettings((s) => ({ ...s, spellcheck: !s.spellcheck }));
}, []);
```

### Design tokens to reuse (`app/globals.css`)

- Ink colours (per-theme, defined under `:root` and each `[data-theme=...]`):
  `--color-ink-primary` (brightest, ~oklch 0.94), `--color-ink-secondary`
  (~0.79), `--color-ink-tertiary` (~0.665, dimmest). For dimming, the
  non-active text should land near `--color-ink-tertiary`.
- Motion (lines 111–117): `--motion-fast: 140ms`, `--motion-base: 200ms`,
  `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`. Use `--motion-base`/`--ease-out`
  for the dim fade. Always pair with a `@media (prefers-reduced-motion)` /
  `motion-reduce` escape (the repo does this throughout, e.g. studio-shell
  `motion-reduce:transition-none`).
- The editable surfaces:
  - CM content lines are `.cm-editor .cm-line` (CodeMirror wraps each visual
    line in `.cm-line`); the editable region is `.cm-content`.
  - Rich content is `.milkdown .ProseMirror` (block children are the paragraphs).

### Repo conventions that apply

- TypeScript strict, ESM, Bun. Prefer built-ins + battle-tested libs.
  `Intl.Segmenter('en', { granularity: 'sentence' })` is the sentence
  tokenizer (verified available in Bun and Node; happy-dom inherits host Intl).
- UI = compose existing patterns + OKLCH tokens; dark-only. No new colour
  literals.
- Commits: conventional, **no AI attribution**, author = the user. Example from
  `git log`: `feat: add switchable calm color themes`.
- Settings are user-tunable knobs persisted in `localStorage`, validated on load.
- Tests: Vitest, files `lib/**/*.test.ts`, `describe`/`it`/`expect` from
  `vitest`. Pure-logic tests model after `lib/markdown/count-words.test.ts`.

## Commands you will need

| Purpose   | Command                              | Expected on success            |
|-----------|--------------------------------------|--------------------------------|
| Install   | `bun install`                        | exit 0                         |
| Typecheck | `bun run typecheck`                  | exit 0, no errors              |
| Lint      | `bun run biome`                      | exit 0 (no errors)             |
| Test all  | `bun run test`                       | all pass                       |
| Test one  | `bunx vitest run lib/editor/focus-range.test.ts` | new tests pass     |
| Build     | `bun run build`                      | exit 0                         |
| Dev (manual check) | `bun run dev`               | studio loads at localhost      |

## Suggested executor toolkit

- If a `vercel-react-best-practices` skill is available, consult it when adding
  the React effects in `pane-editor.tsx` and the CM/PM mount effects (avoid
  re-creating the editor; reconfigure via Compartment / dispatch a meta instead).
- If a CodeMirror or ProseMirror docs lookup tool (e.g. context7) is available,
  confirm the current signatures for `ViewPlugin.fromClass`, `Decoration.mark`,
  `EditorView.scrollIntoView`, and ProseMirror `Decoration.inline` /
  `DecorationSet.create` before writing those calls — do not guess.

## Scope

**In scope** (the only files you may create or modify):

- `lib/editor/focus-range.ts` (create)
- `lib/editor/focus-range.test.ts` (create)
- `lib/studio/use-studio-settings.ts` (modify)
- `lib/keyboard/actions.ts` (modify)
- `lib/keyboard/app-shortcuts.ts` (modify)
- `components/status-bar.tsx` (modify)
- `components/studio-shell.tsx` (modify)
- `components/workspace/pane-editor.tsx` (modify)
- `lib/editor/codemirror/index.tsx` (modify)
- `lib/editor/milkdown/index.tsx` (modify)
- `app/globals.css` (modify — append a focus-mode block in the components layer)
- `plans/README.md` (create or update the status row only)

**Out of scope** (do NOT touch, even though they look related):

- `components/editor-pane.tsx` — **dead code, zero importers.** It mirrors
  `pane-editor.tsx` but is not rendered anywhere. Editing it does nothing and
  risks confusing a reviewer. Verified unused via grep at plan time.
- `lib/editor/preview/*` — preview is read-only; focus mode does not apply.
  (You MAY note in a comment that preview is intentionally skipped.)
- The Convex layer (`convex/**`) — settings are `localStorage`-only.
- `lib/sync/**`, `lib/workspace/**`, the bridge — do not change sync, scroll
  persistence, or pane wiring. Typewriter scroll must coexist with the existing
  scroll-fraction persistence in `pane-editor.tsx` (lines 264–284) — see
  Step 6's note. Do not modify that effect.

## Git workflow

- Branch: `advisor/003-focus-mode-typewriter-dimming`
- Commit per logical unit (suggested: one for the pure module + tests, one for
  settings, one for keyboard + status bar wiring, one per editor, one for CSS).
- Conventional commits, no AI attribution, author = user. Example message:
  `feat: deep-focus mode — typewriter scroll and current-sentence dimming`
- Do NOT push or open a PR unless the operator instructed it.

## Decisions (made — implement as written)

1. **Dimming = a class on the active range + CSS opacity/colour transition, NOT
   a per-character opacity on every other character.** In both editors, mark the
   ACTIVE range with a decoration class (`recto-focus-active`) and dim the
   container; non-active text falls back to the dimmed colour. Rationale:
   decorating only the (small) active range is far cheaper than decorating the
   entire rest of the document on every keystroke, and a single CSS transition
   on the container gives the smooth fade for free.
   - CM: `EditorView.editorAttributes` / a container class + a `Decoration.mark`
     over `[from, to)` with class `recto-focus-active`.
   - PM: an inline `Decoration.inline(from, to, { class: "recto-focus-active" })`
     in a `DecorationSet`, plus a class on the editor DOM via the plugin's
     `props.attributes` (or a class on `.milkdown` toggled from the React side).
   - The dim colour is applied to the editable container; the active class
     restores `--color-ink-primary`. Use `--color-ink-tertiary` for dimmed text
     and transition `color` over `--motion-base --ease-out` with a
     `motion-reduce` escape.
2. **Active range computation.** Compute on plain text via a shared pure module
   `lib/editor/focus-range.ts`:
   - Paragraph scope: split the document text on blank lines (`/\n\s*\n/`) — the
     range is the paragraph block containing the caret offset.
   - Sentence scope: within the containing paragraph, run
     `new Intl.Segmenter(undefined, { granularity: "sentence" })` and pick the
     segment whose `[index, index+segment.length)` contains the caret; return
     that range trimmed of trailing whitespace, offset back to document
     coordinates.
   - The module works in **character offsets over a flat string**. CM gives you
     `view.state.doc.toString()` + `view.state.selection.main.head` directly. PM
     gives you `view.state.doc.textBetween(0, size, "\n", "\n")` for the flat
     text and you map the caret via `view.state.selection.head` → text offset
     (see Step 5 for the PM offset note). For sentence/paragraph dimming the PM
     mapping does not need to be exact to the character at block boundaries; a
     best-effort that's stable per-block is acceptable — STOP only if PM ranges
     are visibly wrong by more than a block.
3. **Typewriter scroll.**
   - CM: a `ViewPlugin` whose `update(u)` checks `u.selectionSet && !u.docChanged
     ? skip-when-range : center` — specifically: only call
     `view.scrollIntoView(head, { y: "center" })` when the selection is **empty**
     (`main.empty`) and (`u.docChanged || u.selectionSet`). When the selection is
     a non-empty range (a selection being made/extended), do NOT center.
   - PM: in the plugin's `view().update(view, prevState)`, when
     `view.state.selection.empty` and the head moved, scroll the caret to center
     via `view.dispatch(view.state.tr.scrollIntoView())` is NOT centering — use a
     DOM scroll: get the caret coords via `view.coordsAtPos(head)` and scroll the
     scroll container so the caret sits at its vertical midpoint. Suppress when
     the selection is non-empty.
4. **Typewriter + existing scroll persistence.** `pane-editor.tsx` persists a
   scroll FRACTION on `focusout` and restores it on first seed. Typewriter
   centering only fires on caret movement while the editor is focused and the
   selection is empty; it never runs on `focusout` or seed. So the two do not
   fight. **Do not modify the persistence effect.** If you find they conflict in
   manual testing, that is a STOP condition — report it, don't hack around it.
5. **Mobile.** Disable typewriter centering on mobile (the soft keyboard already
   manages the viewport, and centering fights it). Thread `useIsMobile()` from
   `studio-shell.tsx` into an effective `typewriter && !isMobile` value passed to
   the panes. Dimming stays on for all viewports.
6. **A/B fork → switchable settings.** Per the project rule, do not hard-pick
   sentence vs paragraph: ship a `focusDimScope: "sentence" | "paragraph"`
   setting, plus independent `typewriter: boolean` and `focusDim: boolean`.

## Steps

### Step 1: Pure active-range module + tests (TDD)

Create `lib/editor/focus-range.ts`:

```ts
export type FocusScope = "sentence" | "paragraph";
export type FocusRange = { from: number; to: number };

/**
 * Char range [from, to) of the active unit (sentence or paragraph) that
 * contains `caret` within the flat document `text`. Returns null when text is
 * empty. Offsets are clamped into [0, text.length].
 */
export function activeFocusRange(
	text: string,
	caret: number,
	scope: FocusScope,
): FocusRange | null { /* ... */ }
```

Behavior:
- Empty / whitespace-only `text` → `null`.
- Clamp `caret` to `[0, text.length]`.
- Paragraph: find the paragraph block (split on `/\n[ \t]*\n/`, tracking block
  offsets) containing `caret`; return its `[start, end)` (end excludes trailing
  blank-line whitespace).
- Sentence: locate the containing paragraph first (so sentence segmentation
  never crosses a blank line), run `Intl.Segmenter` over that paragraph
  substring, pick the segment containing the caret, trim trailing whitespace
  from the segment, map back to document offsets.
- Caret exactly at a boundary (between two sentences / end of a paragraph):
  prefer the sentence/paragraph the caret is at the START of; if at the very end
  of the text, use the last unit.

Create `lib/editor/focus-range.test.ts`, modeled structurally on
`lib/markdown/count-words.test.ts` (import `{ describe, expect, it } from
"vitest"`). Cover at minimum:
- empty string and whitespace-only → `null`
- single sentence, caret in middle → full range
- `"Hello world. How are you? I am fine."` with caret in 2nd sentence →
  returns the `"How are you?"` range (start index 13, end before the trailing
  space) for `scope: "sentence"`
- same text, `scope: "paragraph"`, caret anywhere → whole string range
- multi-paragraph text (`"Para one.\n\nPara two here."`): caret in 2nd
  paragraph → paragraph range is just the 2nd paragraph; sentence range stays
  within that paragraph
- caret clamped when `> text.length`
- abbreviation edge ("e.g." / "Dr. Smith") — assert it does NOT crash and
  returns a contiguous range (Intl.Segmenter's locale rules decide the split;
  the test asserts a valid non-empty range, not a specific split)

**Verify**: `bunx vitest run lib/editor/focus-range.test.ts` → all tests pass.
Then `bun run typecheck` → exit 0.

### Step 2: Add focus settings to the studio settings hook

In `lib/studio/use-studio-settings.ts`:
- Import/define `export type FocusScope = "sentence" | "paragraph";` (or import
  it from `lib/editor/focus-range.ts` to keep one source of truth — prefer
  importing).
- Extend `StudioSettings` with: `typewriter: boolean`, `focusDim: boolean`,
  `focusDimScope: FocusScope`.
- Extend `DEFAULTS`: `typewriter: false, focusDim: false, focusDimScope:
  "sentence"`. (Off by default — focus mode is opt-in.)
- Extend `loadSettings()` validation for the three new fields (boolean checks
  like the existing `spellcheck` check; for scope validate against
  `["sentence","paragraph"]` falling back to default).
- Extend `StudioSettingsApi` with setters: `toggleTypewriter()`,
  `toggleFocusDim()`, `setFocusDimScope(scope)`, `cycleFocusDimScope()` (flip
  sentence↔paragraph — used by a single status-bar control).
- Implement each setter with `useCallback`, modeled on `toggleSpellcheck`, and
  add them to the returned object.

`settings-context.tsx` needs **no change** — it passes the whole API through.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Register keyboard actions

In `lib/keyboard/actions.ts`:
- Add to the `ActionId` union: `"toggle-typewriter"`, `"toggle-focus-dim"`,
  `"cycle-dim-scope"`.
- Add three `ActionDef`s in the `"View"` section of `ACTIONS`, with clear
  labels/aliases, e.g.:
  - `toggle-typewriter` → "Toggle typewriter scrolling", aliases
    `["typewriter","center line","scroll"]`, shortcut `{ mac: "", other: "" }`
    (no chord) UNLESS you assign one in Step 4.
  - `toggle-focus-dim` → "Toggle focus dimming", aliases
    `["dim","focus text","highlight current"]`.
  - `cycle-dim-scope` → "Focus scope: sentence / paragraph", aliases
    `["sentence","paragraph","scope"]`.
- For any chord you assign in Step 4, set the matching `shortcut` strings so the
  palette hint matches the real chord.

**Note on chord choice**: `Ctrl+⇧+F` is taken (zen). Free, consistent chords:
assign typewriter to `Ctrl+⇧+T` and focus-dim to `Ctrl+⇧+D` (verify in
`app-shortcuts.ts` that `t` and `d` are not already matched — at plan time they
are not). Leave `cycle-dim-scope` palette-only (no chord) to limit surface area.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Wire chords in the app shortcut handler

In `lib/keyboard/app-shortcuts.ts`:
- Add to the `AppShortcutAction` union: `{ type: "toggle-typewriter" }` and
  `{ type: "toggle-focus-dim" }`.
- In `createAppShortcutHandler`, add (next to the existing
  `matchCtrlShift(event, "f")` zen block, lines 177–182):

```ts
if (matchCtrlShift(event, "t")) {
	event.preventDefault();
	event.stopPropagation();
	onAction({ type: "toggle-typewriter" });
	return;
}
if (matchCtrlShift(event, "d")) {
	event.preventDefault();
	event.stopPropagation();
	onAction({ type: "toggle-focus-dim" });
	return;
}
```

(`matchCtrlShift` is already defined at lines 51–59.)

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Step 5: Implement dimming + typewriter in the Milkdown (rich) editor

In `lib/editor/milkdown/index.tsx`:
- Imports: add `Plugin`, `PluginKey` from `@milkdown/prose/state`; `Decoration`,
  `DecorationSet` from `@milkdown/prose/view`; `$prose` from `@milkdown/utils`
  (already a dep); `activeFocusRange`, `type FocusScope` from
  `@/lib/editor/focus-range`.
- Add props to `InnerProps` and `MilkdownEditorProps`: `typewriter?: boolean`,
  `focusDim?: boolean`, `focusDimScope?: FocusScope`. Thread them through
  `MilkdownEditor` → `MilkdownEditorInner`.
- Hold the live values in refs (`typewriterRef`, `focusDimRef`,
  `focusScopeRef`), updated each render (mirror how `onChangeRef` etc. are kept
  current at lines 82–84), so the single long-lived ProseMirror plugin reads
  current settings without rebuilding the editor.
- Create a `$prose((ctx) => new Plugin({ key: new PluginKey("recto-focus"),
  props: { decorations(state) { ... } }, view(view) { return { update(v,
  prev) { ... } } } }))` and `.use(...)` it in the chain after `listener`.
  - `decorations(state)`: if `!focusDimRef.current` return `DecorationSet.empty`.
    Otherwise compute the flat text `state.doc.textBetween(0, state.doc.content.size,
    "\n", "\n")` and the caret text-offset, call `activeFocusRange(text, caret,
    focusScopeRef.current)`. Map the returned text `[from,to)` back to PM
    positions and return `DecorationSet.create(state.doc, [Decoration.inline(pmFrom,
    pmTo, { class: "recto-focus-active" })])`. Also add a node/widget-free class
    on the whole editor via the plugin `props.attributes = { class:
    focusDimRef.current ? "recto-focus-dim" : "" }` so CSS can dim the container.
  - `view().update`: if `typewriterRef.current` and the selection is **empty**
    and the head changed, center the caret: read `view.coordsAtPos(head)` and the
    nearest scrollable ancestor of `view.dom`, then set that scroller's
    `scrollTop += caretMidY - viewportMidY`. Skip entirely when selection is
    non-empty. (See Decision 3.)
- **PM offset mapping note**: ProseMirror positions are not equal to plain-text
  offsets (each node boundary counts). For dimming you need text↔pos mapping.
  The robust approach: walk the doc with `state.doc.descendants` accumulating a
  text offset, or use `state.doc.nodesBetween`. If exact mapping proves fiddly,
  a pragmatic acceptable fallback for v1 is **block-level dimming in rich mode**:
  decorate the textblock node containing the selection (use
  `state.selection.$head.blockRange()` or the parent block's start/end) with
  `recto-focus-active`, and treat "sentence" scope in rich mode as "paragraph"
  (note this in a code comment). This keeps rich-mode dimming correct at the
  block granularity even if sub-paragraph sentence ranges are hard. **Decide
  which you ship; if you cannot get sentence-accurate PM ranges in a reasonable
  attempt, ship block-level and note it — do NOT block the plan.**

**Verify**: `bun run typecheck` → exit 0; `bun run build` → exit 0. Then manual:
`bun run dev`, switch to rich mode, enable focus dim — the current paragraph
stays bright, the rest dims; typing keeps the line centered.

### Step 6: Implement dimming + typewriter in the CodeMirror (raw/vim) editor

In `lib/editor/codemirror/index.tsx`:
- Imports: extend the `@codemirror/view` import to add `Decoration`,
  `type DecorationSet`, `ViewPlugin`, `type ViewUpdate`; import `activeFocusRange`,
  `type FocusScope` from `@/lib/editor/focus-range`; `StateEffect` from
  `@codemirror/state` if you choose effect-based reconfig (or just reuse the
  Compartment pattern).
- Add props `typewriter?: boolean`, `focusDim?: boolean`, `focusDimScope?:
  FocusScope` to `CodeMirrorEditorProps`. Keep live values in refs updated each
  render (mirror `spellcheckRef`/`vimEnabledRef` at lines 224–227).
- Add a `focusCompartmentRef = useRef(new Compartment())`. Seed it in the
  `extensions` array (`focusCompartmentRef.current.of(buildFocusExtension(...))`)
  and `reconfigure` it in a `useEffect` keyed on `[typewriter, focusDim,
  focusDimScope]` exactly like the spellcheck effect (lines 296–304).
- `buildFocusExtension(typewriter, focusDim, scope)` returns an `Extension[]`:
  - **Dim decoration**: a `ViewPlugin.fromClass` that maintains a
    `DecorationSet` (provided via the static `{ decorations: v => v.deco }`). On
    `update(u)` if `u.docChanged || u.selectionSet`, recompute: if `!focusDim`,
    empty set; else `activeFocusRange(u.view.state.doc.toString(),
    u.view.state.selection.main.head, scope)` → `Decoration.mark({ class:
    "recto-focus-active" }).range(from, to)` in a `Decoration.set([...])`. Also
    add `EditorView.editorAttributes.of({ class: focusDim ? "recto-focus-dim" :
    "" })` to the extension array so the container dims.
  - **Typewriter**: a `ViewPlugin` whose `update(u)`: if `typewriter` and
    `u.view.state.selection.main.empty` and (`u.docChanged || u.selectionSet`),
    `u.view.dispatch({ effects: EditorView.scrollIntoView(
    u.view.state.selection.main.head, { y: "center" }) });`. Skip when the
    selection is non-empty (a range being dragged). NB: dispatching a
    scroll effect inside `update` must be deferred — do it in a
    `requestAnimationFrame` or via the plugin's `view`-level method to avoid
    "dispatch during update" errors; verify against current CM docs.
- **Scroll persistence coexistence** (Decision 4): do NOT touch
  `pane-editor.tsx` lines 264–284. Typewriter only fires on focused caret moves
  with an empty selection.

**Verify**: `bun run typecheck` → exit 0; `bun run build` → exit 0. Manual:
raw mode + vim mode, focus dim dims non-active line range, typewriter centers.
In vim, dragging visual selection must NOT recenter.

### Step 7: Thread settings into the panes

In `components/workspace/pane-editor.tsx`:
- Extend the destructure at line 60 to also pull `typewriter`, `focusDim`,
  `focusDimScope` from `useStudioSettingsContext()`.
- Pass an **effective typewriter** that respects mobile. The pane does not have
  `useIsMobile` today; either (a) call `useIsMobile()` here too (it's a cheap
  media-query hook, SSR-safe), or (b) pass an already-computed effective value
  down from `studio-shell.tsx`. Prefer (a) for locality: `const isMobile =
  useIsMobile();` then `const typewriterEffective = typewriter && !isMobile;`.
- Pass `typewriter={typewriterEffective}`, `focusDim={focusDim}`,
  `focusDimScope={focusDimScope}` to BOTH `<MilkdownEditor .../>` (line ~464)
  and `<CodeMirrorEditor .../>` (line ~474). Preview gets nothing.

**Verify**: `bun run typecheck` → exit 0.

### Step 8: Status-bar toggles

In `components/status-bar.tsx`:
- Add to `StatusBarProps`: `typewriter`, `focusDim` (booleans), `focusDimScope`
  (`FocusScope` — import the type from `use-studio-settings`), and handlers
  `onToggleTypewriter`, `onToggleFocusDim`, `onCycleDimScope`.
- Import two more `lucide-react` icons (e.g. `AlignCenter` for typewriter and
  `Spotlight`/`Sun`/`Highlighter` for dim — pick existing lucide names; verify
  they exist in the installed lucide version).
- In the desktop `sm:flex` cluster (after the spellcheck button, ~line 264, with
  a `<span ... bg-[var(--color-line)] />` divider), add:
  - a typewriter toggle button (copy the spellcheck button pattern;
    `aria-pressed={typewriter}`, accent when on).
  - a focus-dim toggle button (`aria-pressed={focusDim}`).
  - when `focusDim` is on, a small scope control showing "Sentence"/"Paragraph"
    that calls `onCycleDimScope` (model after the font toggle button text
    pattern, lines 200–216). It may render only when `focusDim` is true.

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Step 9: Wire status bar + actions in the shell

In `components/studio-shell.tsx`:
- In the `dispatch(id)` switch (lines 247–369, in the `"View"` cases near
  `toggle-spellcheck`), add:
  - `case "toggle-typewriter": settings.toggleTypewriter(); return;`
  - `case "toggle-focus-dim": settings.toggleFocusDim(); return;`
  - `case "cycle-dim-scope": settings.cycleFocusDimScope(); return;`
- In the keyboard handler `switch (action.type)` (lines 389–453, near
  `toggle-focus`), add:
  - `case "toggle-typewriter": settings.toggleTypewriter(); return;`
  - `case "toggle-focus-dim": settings.toggleFocusDim(); return;`
  (These read `settings` from the enclosing scope; ensure `settings` is in the
  handler effect's dependency array — it currently is NOT listed at lines
  460–466, so add `settings` there, OR route through `dispatchRef.current(...)`
  like `copy-rich` does to avoid stale closure. Prefer the `dispatchRef` route
  for consistency and to avoid re-subscribing the global keydown listener.)
- Pass the new props to `<StatusBar .../>` (lines 590–630), each handler also
  calling `dispatchFocusEditor()` like the sibling toggles do:
  `onToggleTypewriter={() => { settings.toggleTypewriter(); dispatchFocusEditor(); }}`,
  same for `onToggleFocusDim` and `onCycleDimScope`, plus
  `typewriter={settings.typewriter}`, `focusDim={settings.focusDim}`,
  `focusDimScope={settings.focusDimScope}`.

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Step 10: Dim styling in globals.css

Append to the `@layer components` block in `app/globals.css` (near the other
editor rules, after the cm-cursor section ~line 654). Use the OKLCH ink tokens
and motion tokens; include a reduced-motion escape.

```css
/* Focus dimming — when on, the editable surface dims to tertiary ink and the
   active sentence/paragraph (decorated with .recto-focus-active) stays primary.
   Single container transition gives the smooth fade for free. */
.recto-focus-dim .cm-content,
.recto-focus-dim.ProseMirror,
.recto-focus-dim .ProseMirror {
	color: var(--color-ink-tertiary);
	transition: color var(--motion-base) var(--ease-out);
}
.recto-focus-dim .recto-focus-active,
.recto-focus-dim .recto-focus-active * {
	color: var(--color-ink-primary);
}
@media (prefers-reduced-motion: reduce) {
	.recto-focus-dim .cm-content,
	.recto-focus-dim.ProseMirror,
	.recto-focus-dim .ProseMirror {
		transition: none;
	}
}
```

Adjust the exact selectors to match where you actually applied the
`recto-focus-dim` class (editor container vs `.cm-content` vs `.ProseMirror`) in
Steps 5–6. The active-range decoration class MUST win specificity over the
dimmed container colour.

**Verify**: `bun run build` → exit 0. Manual: toggle dim in each editable mode;
non-active text is visibly dimmer, active unit is bright, fade is smooth.

### Step 11: Full gate run + index

- Run all gates (see Done criteria).
- Create/update `plans/README.md` status row for 003 → DONE (schema below).

## Test plan

- **New unit tests**: `lib/editor/focus-range.test.ts`, modeled on
  `lib/markdown/count-words.test.ts`. Cases listed in Step 1 (empty/whitespace,
  single sentence, multi-sentence sentence-scope, paragraph-scope, multi-
  paragraph, caret clamp, abbreviation non-crash). These are the only
  unit-testable pieces — the CM/PM integration is verified manually (the repo
  has no editor-interaction test harness; `milkdown/seed.test.ts` is a smoke
  test, not interaction).
- **Manual verification matrix** (run `bun run dev`):
  | Mode | Typewriter on | Dim on (sentence) | Dim on (paragraph) | Selection drag |
  |------|---------------|-------------------|--------------------|----------------|
  | rich | line centers  | active sentence bright | active para bright | no recenter   |
  | raw  | line centers  | active sentence bright | active para bright | no recenter   |
  | vim  | line centers (insert + normal caret moves) | as above | as above | visual select no recenter |
  | preview | n/a (skipped) | n/a | n/a | n/a |
  | mobile (≤767px) | NO centering | dim still works | dim still works | — |
- **Regression check**: open two panes on the same doc, type in one — the other
  pane and the scroll-fraction persistence still behave (no centering jump on
  blur/seed).
- Verification command: `bun run test` → all pass, including the new
  `focus-range` tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run biome` exits 0 (no errors)
- [ ] `bun run test` exits 0; `lib/editor/focus-range.test.ts` exists and its
      tests pass
- [ ] `bun run build` exits 0
- [ ] `grep -rn "typewriter" lib/studio/use-studio-settings.ts` shows the field,
      default, loader validation, and a setter
- [ ] `grep -rn "recto-focus-active" app/globals.css lib/editor/codemirror/index.tsx lib/editor/milkdown/index.tsx` shows the class defined in CSS and applied in both editors
- [ ] `grep -rn "toggle-typewriter\|toggle-focus-dim" lib/keyboard/actions.ts components/studio-shell.tsx` shows the action registered and dispatched
- [ ] `git status` shows NO modifications outside the in-scope list (in
      particular `components/editor-pane.tsx` is untouched)
- [ ] `plans/README.md` status row for 003 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed since `a25c506` and its live
  code no longer matches the excerpts in "Current state".
- **CM extensions array shape changed**: `lib/editor/codemirror/index.tsx` no
  longer builds a single `extensions: Extension[]` with `Compartment.of(...)`
  entries, or `Compartment`/`drawSelection`/`EditorView` imports moved — the
  Compartment-reconfigure pattern is the foundation of Step 6.
- **Milkdown plugin registration moved**: the editor is no longer built with
  `Editor.make().config(...).use(...)`, or `@milkdown/utils` no longer exports
  `$prose`, or `@milkdown/prose/state` / `@milkdown/prose/view` no longer
  re-export `prosemirror-state` / `prosemirror-view` — Step 5 depends on these.
- **`Intl.Segmenter` is unavailable** in the target runtime (`bun -e 'new
  Intl.Segmenter("en",{granularity:"sentence"})'` throws) — the sentence-scope
  feature has no fallback in this plan; report so a tokenizer decision can be made.
- Typewriter centering visibly fights the existing scroll-fraction persistence
  in `pane-editor.tsx` (Decision 4) and you cannot reconcile without editing
  that out-of-scope effect.
- Sentence-accurate ProseMirror ranges prove infeasible AND block-level dimming
  (the documented fallback in Step 5) also fails — report rather than shipping a
  visibly wrong rich-mode dim.
- Any step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

For the human/agent who owns this after it lands:

- `lib/editor/focus-range.ts` is the single source of truth for active-range
  logic; both editors call it. If sentence segmentation rules need tuning
  (locale, abbreviations), change it there once.
- The PM offset↔position mapping (Step 5) is the fragile part. If rich-mode
  dimming shipped at block granularity (the fallback), upgrading to true
  sentence ranges in rich mode is the natural follow-up — note in the PR which
  was shipped.
- Reviewer should scrutinize: (1) typewriter is suppressed during non-empty
  selections in BOTH editors (the iA jank caveat); (2) the global keydown
  listener in `studio-shell.tsx` is not re-subscribed on every settings change
  (use `dispatchRef`); (3) the dim active class beats the dimmed container in
  CSS specificity; (4) no edits to `components/editor-pane.tsx` (dead) or the
  scroll-persistence effect.
- Deferred out of this plan: per-document focus preferences (settings are
  global), preview-mode dimming (read-only), and animating the dim per-character
  (rejected for cost — see Decision 1).

---

## Index file schema (`plans/README.md`)

If `plans/README.md` does not exist, create it with this structure (the repo
already has plans 001 and 002 — list all three):

```markdown
# Implementation Plans

Execute in the order below unless dependencies say otherwise. Each executor:
read the plan fully before starting, honor its STOP conditions, and update your
row when done.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | Word-level version diff | P2 | M | — | TODO |
| 002  | Writing goals and streaks | P2 | M | — | TODO |
| 003  | Focus mode: typewriter + dimming | P2 | L | — | TODO |
```

Update only the 003 row's Status when you finish (TODO → IN PROGRESS → DONE).
