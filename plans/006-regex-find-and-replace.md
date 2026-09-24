# Plan 006: Add keyboard-driven find & replace (with regex) to the raw/vim editor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a25c506..HEAD -- lib/editor/codemirror/index.tsx lib/keyboard/app-shortcuts.ts lib/keyboard/actions.ts components/studio-shell.tsx components/workspace/pane-editor.tsx components/command-palette.tsx app/globals.css package.json`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: feature (direction)
- **Planned at**: commit `a25c506`, 2026-06-17
- **Issue**: —

## Why this matters

Recto is a serious writing studio (single-user, keyboard-driven). Revision
passes need find & replace, including regex, for chores like renaming a
character, fixing a repeated phrase, or normalizing quotes. CodeMirror 6 ships
exactly this via `@codemirror/search` (a search panel with a regexp toggle and
replace fields), so adding it to the raw + vim lenses is low-risk and high-value.
ProseMirror (the rich lens) has no built-in search and a custom implementation
is non-trivial; because Recto's lenses are lossless and switching is instant,
the lowest-risk approach is to scope find/replace to raw+vim and make rich's
`⌘F` _offer to switch to raw_ rather than build a parallel search engine. After
this lands, the writer can press `⌘F` anywhere and get a real regex find/replace
without leaving the keyboard.

## Decision: where find/replace lives (READ THIS — it shapes every step)

Three options were considered for the rich (Milkdown/ProseMirror) lens:

- **(a) Custom ProseMirror search plugin with decorations** — most work, highest
  risk, duplicates an engine CM already gives us for free. Rejected.
- **(b) Scope find/replace to raw+vim; in rich, `⌘F` switches to raw first** —
  lowest risk, fits the lossless philosophy (switching lens is instant and
  loses nothing), reuses the battle-tested `@codemirror/search` engine. **CHOSEN.**
- **(c) Shared app-level find UI over canonical markdown** — would need its own
  highlight/replace plumbing per lens; effectively (a)'s cost. Rejected.

**This plan implements (b).** Concretely:

- **raw + vim lenses**: wire `@codemirror/search` (`search`, `openSearchPanel`,
  `searchKeymap`) into the existing CodeMirror editor, themed to dark OKLCH
  tokens. The panel itself has a regexp toggle and replace fields; that is the
  whole feature for these lenses.
- **rich lens**: `⌘F` switches to the raw lens and opens the search panel there.
  (Switching is lossless and instant, see `lib/modes/types.ts` MODE_RING.)
- **preview lens**: read-only — `⌘F` falls through to the browser's native page
  find. We do NOT preventDefault for `⌘F` while preview is active. Documented
  only; no code needed beyond the active-lens check.

This is not a genuine A/B UX fork (there is one correct, lower-risk behavior),
so no user toggle is introduced.

## Current state

Files involved, each with its role:

- `lib/editor/codemirror/index.tsx` — the raw+vim editor. Its `extensions`
  array (lines 254–264) is where search extensions + the search keymap go. The
  editor exposes a handle via `useImperativeHandle` (lines 306–372) and
  `getCmView()` returns the live `EditorView` (lines 369–371).
- `lib/keyboard/app-shortcuts.ts` — capture-phase chord handler
  (`createAppShortcutHandler`, lines 110–316) and the `AppShortcutAction` union
  (lines 4–23). This is where a new `⌘F`/`⌘⌥F` matcher and a new action variant go.
- `lib/keyboard/actions.ts` — the action registry (`ActionId` union lines 17–50,
  `ACTIONS` array lines 64–296). The command palette reads labels + shortcut
  hints from here. A new "Find & replace" action def goes here.
- `components/studio-shell.tsx` — wires the chord handler at window/capture
  (lines 385–459) and routes palette `ActionId`s in `dispatch` (lines ~250–380).
  Both call the same effects. This is where the new action gets handled and
  where the active-lens decision (rich → switch to raw) is made.
- `components/workspace/pane-editor.tsx` — each pane owns its own
  `cmRef`/`richRef` (lines 61–62) and listens for `recto:*` window events only
  when `isActive` (e.g. `recto:switch-mode` lines 346–360, `recto:format` lines
  364–374). The "open search" action must route to the active pane's editor via
  this same window-event pattern.
- `app/globals.css` — dark OKLCH design tokens (lines 13–44) and existing
  CodeMirror CSS (`.codemirror .cm-editor` lines 325–329; CM selection/cursor
  theming lines 622–654). The CM search panel is themed here.
- `lib/modes/types.ts` — `Mode = "rich" | "raw" | "vim" | "preview"` (line 1),
  `MODE_RING` (line 3). Used for the "switch to raw" routing.
- `lib/editor/format.ts` — the exemplar for the editor-agnostic window-event
  pattern: `FORMAT_EVENT = "recto:format"` (line 22) and `dispatchFormat()`
  (lines 30–40). **Model the new search-open dispatcher after this.**

### Dependency status — IMPORTANT, already verified

`@codemirror/search@6.7.0` is **already installed** (present in `bun.lock` line
235 as a transitive dep of both the `codemirror` meta package and the
`@replit/codemirror-vim` peer requirement, and present in
`node_modules/@codemirror/search`). It is **NOT yet listed as a direct
dependency** in `package.json`. Step 1 adds it as a direct dependency for
correctness (you import from it directly). Do not be surprised that imports
already resolve before you add it — they resolve via the transitive copy.

### Excerpt — the CodeMirror extensions array (`lib/editor/codemirror/index.tsx:254-264`)

```ts
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
```

Imports at the top of the file (`lib/editor/codemirror/index.tsx:3-11`):

```ts
import { markdown } from "@codemirror/lang-markdown";
import {
	Compartment,
	EditorState,
	type Extension,
	Transaction,
} from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
```

The handle already exposes the live view (`lib/editor/codemirror/index.tsx:369-371`):

```ts
		getCmView() {
			return viewRef.current;
		},
```

### Excerpt — the chord handler & action union (`lib/keyboard/app-shortcuts.ts`)

The action union (lines 4–23) currently ends:

```ts
	| { type: "toggle-status" }
	| { type: "toggle-focus" };
```

The handler matches chords with helpers like `matchCtrlShift` (lines 51–59) and
guards native behavior in inputs/overlays with `inOverlayOrInput()` (lines
71–79). For example, `Ctrl+Shift+F` (toggle-focus / zen) is matched at lines
177–182:

```ts
		if (matchCtrlShift(event, "f")) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "toggle-focus" });
			return;
		}
```

Note: `⌘F` (Cmd+F, no shift) is **currently unhandled** — it falls through to
the browser's native page find. `Ctrl+Shift+F` is taken by zen mode. So `⌘F`
(mac) / `Ctrl+F` (other) is free for "open find". The handler is attached at
window capture phase in `studio-shell.tsx:458`:

```ts
		window.addEventListener("keydown", handler, true);
```

### Excerpt — palette action wiring

`command-palette.tsx` renders each action and calls `onRunAction(def.id)`
(line 168); `studio-shell.tsx:639` wires `onRunAction={(id) => dispatchRef.current(id)}`.
So adding an `ActionId` + a `case` in `dispatch` makes it appear in the palette
AND be runnable from there. Shortcut hint comes from `shortcutHint(def)`
(`actions.ts:312-314`).

### Excerpt — active-pane window-event pattern (`pane-editor.tsx:346-360`)

```ts
	useEffect(() => {
		if (!isActive) return;
		const onModeShortcut = (event: CustomEvent<{ mode: Mode }>) => {
			switchMode(event.detail.mode);
		};
		window.addEventListener(
			"recto:switch-mode",
			onModeShortcut as EventListener,
		);
		return () =>
			window.removeEventListener(
				"recto:switch-mode",
				onModeShortcut as EventListener,
			);
	}, [isActive, switchMode]);
```

`cmRef`/`richRef` are declared at `pane-editor.tsx:61-62`. `leaf.mode` tells the
pane which lens is live. The "open search" handler will follow this exact shape.

### Conventions that apply

- **Bun** for all commands (see `AGENTS.md`). Gates: `bun run typecheck`,
  `bun run biome`, `bun run test`, `bun run build`, `bun run dev`.
- **TS strict, ESM.** Prefer built-ins + battle-tested libs — here that means
  `@codemirror/search` (do NOT hand-roll search/replace).
- **Window-CustomEvent action bus**: app-level actions reach the active pane's
  editor through `window.dispatchEvent(new CustomEvent("recto:*", ...))` and a
  pane-level `if (!isActive) return;` listener. Exemplars: `recto:switch-mode`
  (`pane-editor.tsx:346`), `recto:format` (`lib/editor/format.ts:30`),
  `recto:focus-editor` (`app-shortcuts.ts:338`). Match this — do NOT reach into
  refs across components.
- **Dark-only, OKLCH tokens**: theme the CM search panel with the `--color-*`
  tokens in `app/globals.css` (e.g. `--color-bg-overlay`, `--color-line`,
  `--color-ink-primary`, `--color-accent`, `--color-focus-ring`). No raw hex,
  no one-off colors.
- **Dual-surface actions**: every new action is registered in
  `lib/keyboard/actions.ts` (so it appears in the palette) AND handled in
  `studio-shell.tsx`'s `dispatch`/chord callbacks. One effect, two surfaces.

## Commands you will need

| Purpose   | Command              | Expected on success            |
|-----------|----------------------|--------------------------------|
| Install   | `bun install`        | exit 0; `package.json` updated |
| Typecheck | `bun run typecheck`  | exit 0, no errors              |
| Lint      | `bun run biome`      | exit 0, no errors              |
| Tests     | `bun run test`       | all pass (incl. any new tests) |
| Build     | `bun run build`      | exit 0                         |
| Dev (manual) | `bun run dev`     | app boots; do the manual checklist |

## Suggested executor toolkit

- If a `convex` skill is offered, you do NOT need it — this plan touches no
  Convex code (search/replace is pure editor state, not a write path).
- For CodeMirror 6 search API specifics, the authoritative source is the
  installed package: read `node_modules/@codemirror/search/dist/index.d.ts` for
  the exact exported names (`search`, `openSearchPanel`, `closeSearchPanel`,
  `searchKeymap`, `SearchQuery`). Do not guess names from memory.

## Scope

**In scope** (the only files you should modify):

- `package.json` (add `@codemirror/search` as a direct dependency)
- `lib/editor/codemirror/index.tsx` (add search extensions + keymap + an
  `openSearch()` handle method)
- `lib/keyboard/app-shortcuts.ts` (add `⌘F`/`⌘⌥F` matchers + action variants)
- `lib/keyboard/actions.ts` (register the "Find & replace" palette action)
- `components/studio-shell.tsx` (handle the new action in both the chord
  callback and the `dispatch` palette callback; route rich → switch-to-raw)
- `components/workspace/pane-editor.tsx` (active-pane listener that opens the
  search panel on the live CodeMirror view)
- `app/globals.css` (theme the `.cm-panel.cm-search` search panel)
- `plans/README.md` (status row — index file)
- One new test file IF you add a pure helper (see Test plan)

**Out of scope** (do NOT touch, even though they look related):

- `lib/editor/milkdown/**` — do NOT build a ProseMirror search plugin. The rich
  lens routes to raw; that's the decision.
- `lib/editor/preview/**` — preview uses native browser find; no code.
- Convex (`convex/**`) — search/replace is editor-local, never a write path.
- The existing `Ctrl+Shift+F` zen toggle and any other existing chord — do not
  repurpose them.
- Do NOT change the editor's value binding or sync — replace operations dispatch
  normal CM transactions, which the existing `updateListener`
  (`index.tsx:241-252`) already forwards to the bridge. No sync change needed.

## Git workflow

- Branch: `advisor/006-regex-find-and-replace`
- Conventional commits, author = the repo user. **NO AI attribution, NO
  Co-Authored-By lines.** Example from `git log`: `feat: add switchable calm color themes`.
- Suggested commit: `feat: add regex find & replace to the raw/vim editor`
- Do NOT push or open a PR unless the operator explicitly instructs it.

## Steps

### Step 1: Add `@codemirror/search` as a direct dependency

It is already resolvable transitively, but you import from it directly, so it
must be a direct dependency. Pin to the version already in `bun.lock` (6.7.0
range).

In `package.json`, add to `"dependencies"` (keep the alphabetical-ish grouping
near the other `@codemirror/*` entries on lines 33–36):

```json
"@codemirror/search": "^6.7.0",
```

Then run install (idempotent — the package is already present):

**Verify**: `bun install` → exit 0. Then
`grep -n "@codemirror/search" package.json` → shows the new line.

### Step 2: Wire `@codemirror/search` into the CodeMirror editor + expose `openSearch()`

In `lib/editor/codemirror/index.tsx`:

1. Add imports (top of file, with the other `@codemirror/*` imports):

```ts
import { keymap } from "@codemirror/view";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
```

(Confirm the exact export names against
`node_modules/@codemirror/search/dist/index.d.ts` first. `keymap` is exported
from `@codemirror/view` — the file already imports `drawSelection, EditorView`
from there, so extend that import rather than adding a duplicate line.)

2. Add the search extension + keymap to the `extensions` array
   (`index.tsx:254-264`). Add `search({ top: true })` and
   `keymap.of(searchKeymap)`. **Order matters for vim**: put the
   `keymap.of(searchKeymap)` AFTER `vimExt` so vim's keymap takes precedence in
   normal mode (vim's own `/` search keeps working; the search panel keymap only
   binds chords like Mod-F / Mod-Alt-F / Enter inside the panel). Resulting array:

```ts
const extensions: Extension[] = [
	vimExt,
	spellcheckCompartmentRef.current.of(
		spellcheckAttrs(spellcheckRef.current),
	),
	drawSelection(),
	markdown(),
	search({ top: true }),
	keymap.of(searchKeymap),
	updateListener,
	EditorView.lineWrapping,
	EditorState.tabSize.of(2),
];
```

3. Add an `openSearch()` method to the imperative handle (the object returned by
   `useImperativeHandle`, `index.tsx:306-372`), next to `getCmView()`:

```ts
		openSearch() {
			const view = viewRef.current;
			if (!view) return;
			view.focus();
			openSearchPanel(view);
		},
```

4. Add `openSearch` to the exported `CodeMirrorEditorHandle` type
   (`index.tsx:21-24`):

```ts
export type CodeMirrorEditorHandle = EditorHandle & {
	setVimEnabled: (enabled: boolean) => void;
	getCmView: () => EditorView | null;
	openSearch: () => void;
};
```

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Define the "open search" window event + dispatcher

Add a small editor-agnostic dispatcher, modeled exactly on
`lib/editor/format.ts:30-40` (`dispatchFormat`). Put it in
`lib/editor/codemirror/index.tsx` near the bottom OR (preferred, matches
`format.ts`) export it from a colocated spot. Simplest, lowest-blast-radius:
add to `lib/editor/codemirror/index.tsx`:

```ts
/** Window event name for "open the find/replace panel in the active editor". */
export const SEARCH_EVENT = "recto:open-search";

/** Ask the active pane's CodeMirror editor to open its search panel. */
export function dispatchOpenSearch(): void {
	window.dispatchEvent(new CustomEvent(SEARCH_EVENT));
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Active pane listens for the search event (raw/vim only)

In `components/workspace/pane-editor.tsx`, add an effect modeled on the
`recto:switch-mode` listener (`pane-editor.tsx:346-360`). Import `SEARCH_EVENT`
from the codemirror module (extend the existing import from
`@/lib/editor/codemirror`). The effect only acts when the pane is active AND the
live lens is `raw` or `vim` (those are the CodeMirror-backed lenses):

```ts
	useEffect(() => {
		if (!isActive) return;
		const onSearch = () => {
			if (leaf.mode !== "raw" && leaf.mode !== "vim") return;
			cmRef.current?.openSearch();
		};
		window.addEventListener(SEARCH_EVENT, onSearch as EventListener);
		return () =>
			window.removeEventListener(SEARCH_EVENT, onSearch as EventListener);
	}, [isActive, leaf.mode]);
```

**Verify**: `bun run typecheck` → exit 0.

### Step 5: Add the chord matcher + action variants in `app-shortcuts.ts`

In `lib/keyboard/app-shortcuts.ts`:

1. Extend the `AppShortcutAction` union (lines 4–23) with one variant:

```ts
	| { type: "find-replace" }
```

2. Add a matcher for `⌘F` (mac) / `Ctrl+F` (other), bare (no shift/alt). Mirror
   `isCheckpointKey` (lines 82–89) for the modifier-guard style:

```ts
/** Cmd/Ctrl+F — open find & replace in the active editor. */
function isFindKey(event: KeyboardEvent): boolean {
	return (
		event.key.toLowerCase() === "f" &&
		(event.metaKey || event.ctrlKey) &&
		!event.shiftKey &&
		!event.altKey
	);
}
```

3. In `createAppShortcutHandler` (the returned function), add the match. **Place
   it carefully**: it must come BEFORE any handler that could swallow it, and it
   must NOT fire when focus is in an overlay/plain input (the search panel's own
   inputs, dialogs) — use the existing `inOverlayOrInput()` guard (lines 71–79).
   Put it right after the `isCheckpointKey` block (~line 120), before the
   undo/redo block:

```ts
		if (isFindKey(event) && !inOverlayOrInput()) {
			event.preventDefault();
			event.stopPropagation();
			onAction({ type: "find-replace" });
			return;
		}
```

   Rationale: when the CM search panel is open and focused, its `<input>` is the
   active element, so `inOverlayOrInput()` returns true and `⌘F` is NOT
   re-intercepted — it falls through to the panel/native behavior. When focus is
   in the editor body (CM content is a `contenteditable` div, not INPUT/TEXTAREA,
   and not inside `[role="dialog"]`), `inOverlayOrInput()` returns false, so the
   chord fires and we open search. Confirm this assumption in the manual test.

**Verify**: `bun run typecheck` → exit 0 and `bun run biome` → exit 0.

### Step 6: Register the palette action in `actions.ts`

In `lib/keyboard/actions.ts`:

1. Add `"find-replace"` to the `ActionId` union (lines 17–50).
2. Decide the section: add it to the existing `"View"` section (no new section
   needed — keeps `SECTION_ORDER` untouched). Add an `ActionDef` to the
   `ACTIONS` array. Shortcut hint: mac `⌘F`, other `Ctrl+F` (use the `M`
   constant on line 60):

```ts
	{
		id: "find-replace",
		label: "Find & replace",
		section: "View",
		aliases: ["search", "replace", "regex", "find"],
		shortcut: { mac: `${M}F`, other: "Ctrl+F" },
	},
```

**Verify**: `bun run typecheck` → exit 0.

### Step 7: Handle the action in `studio-shell.tsx` (both surfaces, rich→raw routing)

`studio-shell.tsx` has TWO callbacks that must handle the action:

- the palette `dispatch` callback (handles `ActionId`s, lines ~250–380)
- the chord `createAppShortcutHandler` callback (handles `AppShortcutAction`s,
  lines ~388–454)

Add a shared helper inside the component, then call it from both. The helper
opens search if the active lens is raw/vim; if the active lens is rich, it
switches to raw first, then opens search after the lens has mounted/seeded. Use
the existing `dispatchModeSwitch` (already imported, used at line 401) and the
new `dispatchOpenSearch`. Determine the active lens from
`findLeaf(workspace.paneTree, workspace.activePaneId)?.mode` (the pattern used
at lines 404 and 267).

```ts
	const openFindReplace = useCallback(() => {
		if (!workspace) return;
		const leaf = findLeaf(workspace.paneTree, workspace.activePaneId);
		const mode = leaf?.mode ?? "rich";
		if (mode === "preview") return; // native browser find handles preview
		if (mode === "rich") {
			// Lossless + instant lens switch, then open search once raw mounts.
			dispatchModeSwitch("raw");
			requestAnimationFrame(() => {
				requestAnimationFrame(() => dispatchOpenSearch());
			});
			return;
		}
		dispatchOpenSearch();
	}, [workspace]);
```

Then:

- In the `dispatch` callback (the palette one), add a case:
  `case "find-replace": openFindReplace(); return;`
- In the chord callback, add a case:
  `case "find-replace": openFindReplace(); return;`

Import `dispatchOpenSearch` from `@/lib/editor/codemirror`. Confirm `findLeaf`
is already imported (it is — used at lines 267, 274, 404).

Note on preview: when `mode === "preview"`, `openFindReplace` returns without
preventing default? No — the chord already called `preventDefault()` in
`app-shortcuts.ts`. To let native find work in preview, the cleanest path is to
NOT preventDefault for `⌘F` when preview is active. BUT the chord handler has no
lens knowledge. Accept this tradeoff: in preview, `⌘F` opens nothing and native
find is suppressed. If that is unacceptable, see STOP conditions — report and
ask whether to special-case preview by reading the active lens inside
`app-shortcuts.ts` (it currently has no workspace access, so this would need a
small signature change, which is out of this plan's minimal scope).

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Step 8: Theme the CM search panel with OKLCH tokens

The CM search panel renders as `.cm-panel.cm-search` with `<input>`,
`<button>`, and `<label>` children. Add dark-themed CSS in `app/globals.css`,
placed with the other CodeMirror rules (after the `.cm-fat-cursor` block ends at
line 654). Use existing tokens only — no hex. Confirm class names by inspecting
the live DOM during the manual test (the panel markup is stable in CM6 but
verify). Target shape:

```css
/* CodeMirror search/replace panel — themed to the dark OKLCH surface. */
.cm-panels {
	background: var(--color-bg-overlay);
	color: var(--color-ink-primary);
	border-top: 1px solid var(--color-line);
}
.cm-panel.cm-search {
	padding: var(--space-2) var(--space-3);
	font-family: var(--font-ui, inherit);
	font-size: var(--text-ui);
}
.cm-panel.cm-search input,
.cm-panel.cm-search button,
.cm-panel.cm-search label {
	color: var(--color-ink-primary);
}
.cm-panel.cm-search input[type="text"] {
	background: var(--color-bg-raised);
	border: 1px solid var(--color-line);
	border-radius: var(--radius-sm);
	padding: 2px 6px;
}
.cm-panel.cm-search input[type="text"]:focus-visible {
	outline: 2px solid var(--color-focus-ring);
	outline-offset: 1px;
}
.cm-panel.cm-search button {
	background: var(--color-bg-raised);
	border: 1px solid var(--color-line);
	border-radius: var(--radius-sm);
}
.cm-panel.cm-search button:hover {
	background: var(--color-bg-hover);
}
/* Match highlights from search */
.cm-searchMatch {
	background: var(--color-accent-wash);
}
.cm-searchMatch.cm-searchMatch-selected {
	background: var(--color-selection);
}
```

Verify the token names exist (they're defined in `app/globals.css:13-44` and the
per-theme blocks). If `--font-ui` is not defined, drop that line (use `inherit`).

**Verify**: `bun run build` → exit 0 (CSS compiles).

### Step 9: Manual runtime verification (`bun run dev`)

Pure-logic tests are thin here (the search engine is the library's). The real
gate is a manual runtime check. Run `bun run dev`, open the app, and confirm:

1. **Raw lens**: switch to Raw Markdown (Ctrl+Shift+M). Press `⌘F` (mac) /
   `Ctrl+F`. The search panel appears at the top, themed dark (not bright/white).
2. **Regex**: toggle the `.*` (regexp) button in the panel; type a regex like
   `\bthe\b`; matches highlight using the accent-wash color.
3. **Replace**: enter a replacement, use Replace / Replace All. The document
   text changes. Confirm undo (`⌘Z` / `Ctrl+Z`) reverts the replacement (this
   verifies replace went through normal CM transactions and the history bridge).
4. **Vim lens**: switch to Vim (Ctrl+Shift+V). Confirm vim normal-mode `/`
   search STILL works (type `/word` Enter — vim search, not the panel). Then
   press `⌘F` — the CM search panel opens (separate from vim `/`). Confirm vim
   keys (h/j/k/l, i, Esc) still work after closing the panel with Esc.
5. **Rich lens**: switch to Rich (Ctrl+Shift+R). Press `⌘F` — the app switches
   to the Raw lens and the search panel opens there, focused.
6. **Preview lens**: switch to Preview (Ctrl+Shift+P). Press `⌘F` — confirm
   behavior matches the Step 7 decision (panel does not open; document the
   actual observed native-find behavior in your report).
7. **No collision**: Ctrl+Shift+F still toggles zen mode (it must NOT open
   search). `⌘K` palette still opens; the palette lists "Find & replace" and
   running it from the palette opens search in raw/vim (or routes rich→raw).
8. **Panel `⌘F` re-press**: with the search panel open and its input focused,
   pressing `⌘F` again should NOT re-trigger the app handler (the
   `inOverlayOrInput()` guard) — it should stay in the panel / select-all in the
   field. Verify focus behavior is sane.

**Verify**: all 8 checks pass. Capture anything that fails as a STOP condition.

## Test plan

- The search/replace engine is `@codemirror/search` (battle-tested) — do NOT
  unit-test the library. No new pure helper is strictly required by this plan.
- **Only if** you introduce a pure helper (e.g. a function that builds/validates
  a `RegExp` from a user string with a `try/catch` so an invalid pattern doesn't
  throw), add a unit test for it. Put the helper in
  `lib/editor/codemirror/search.ts` and the test in
  `lib/editor/codemirror/search.test.ts`, modeled structurally on
  `lib/markdown/count-words.test.ts` (`import { describe, expect, it } from
  "vitest"`). Cover: valid pattern → RegExp; invalid pattern (e.g. `[`) → null
  (no throw); empty string → null. NOTE: CM's own `SearchQuery` already handles
  invalid regex gracefully, so this helper is likely unnecessary — skip it
  unless you actually wrote regex-building code of your own.
- Run the full suite to confirm no regressions:

**Verify**: `bun run test` → all pass (existing suite green; plus N new tests
only if a helper was added).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun install` exits 0 and `grep -n "@codemirror/search" package.json` shows the dep
- [ ] `bun run typecheck` exits 0
- [ ] `bun run biome` exits 0
- [ ] `bun run test` exits 0 (no regressions; new tests pass if any were added)
- [ ] `bun run build` exits 0
- [ ] `grep -n "openSearchPanel\|searchKeymap" lib/editor/codemirror/index.tsx` returns matches
- [ ] `grep -n "find-replace" lib/keyboard/actions.ts lib/keyboard/app-shortcuts.ts components/studio-shell.tsx` returns matches in all three
- [ ] `grep -n "recto:open-search\|SEARCH_EVENT" components/workspace/pane-editor.tsx lib/editor/codemirror/index.tsx` returns matches
- [ ] `grep -n "cm-search" app/globals.css` returns matches
- [ ] Manual checklist (Step 9, all 8) passes via `bun run dev`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the
  codebase drifted since `a25c506` — run the drift check at the top).
- `@codemirror/search`'s exported names differ from `search` / `openSearchPanel`
  / `searchKeymap` (check `node_modules/@codemirror/search/dist/index.d.ts`).
- The CM search panel keymap collides with the `@replit/codemirror-vim` keymap:
  i.e. after Step 2, vim normal-mode keys stop working, or vim's `/` search
  breaks. Report the specific collision — do NOT try to silently rebind vim.
- `⌘F` cannot be intercepted without breaking an existing app shortcut, or the
  `inOverlayOrInput()` guard does not behave as assumed (e.g. CM content counts
  as an input and the chord never fires, OR the panel input doesn't suppress the
  app handler). Report what you observed.
- Preview-lens `⌘F` suppression of native browser find is judged unacceptable by
  the manual check — report and ask whether to thread active-lens info into
  `app-shortcuts.ts` (out of current minimal scope).
- The rich→raw switch-then-open-search timing (the double `requestAnimationFrame`
  in Step 7) does not reliably open the panel because the raw editor hasn't
  mounted yet. Report; do not add arbitrary `setTimeout` delays — propose a
  proper readiness signal instead.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this code after the change lands:

- **If a ProseMirror search plugin is ever added** to the rich lens (option (a)),
  remove the rich→raw routing in `openFindReplace` (`studio-shell.tsx`) and add a
  `recto:open-search` listener to the Milkdown pane path in `pane-editor.tsx`.
  The window-event bus already makes this a localized change.
- **Reviewer should scrutinize**: (1) the keymap ordering relative to `vimExt`
  in `index.tsx` (vim precedence), (2) that replace operations flow through the
  normal `updateListener` → bridge → undo tree (no special-casing needed, but
  confirm undo reverts a Replace All), (3) that the search panel theming uses
  only OKLCH tokens and reads correctly across all four themes (Twilight,
  Aurora, Dawn, Moonlit — the per-theme token blocks in `globals.css`).
- **Deferred out of this plan** (and why): a custom ProseMirror search engine
  (high cost, redundant with CM); persisting last-used search query across lens
  switches (nice-to-have, not needed for revision passes); native-find parity in
  preview (browser already does this; suppression edge case noted above).
```
