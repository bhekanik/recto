# Plan 004: Add an offline, client-side prose linter that highlights passive voice, adverbs, long/complex sentences, and weasel/filler words in both editors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat a25c506..HEAD -- lib/markdown/parse.ts lib/markdown/index.ts lib/editor/codemirror/index.tsx lib/editor/milkdown/index.tsx components/status-bar.tsx components/studio-shell.tsx components/workspace/pane-editor.tsx lib/studio/use-studio-settings.ts lib/studio/settings-context.tsx app/globals.css package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH (the markdown-offset → ProseMirror-position mapping in Step 6 is the load-bearing risk; the pure analyzer in Steps 1–4 is LOW risk)
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

Recto is a typography-first writing studio with no writing-mechanics feedback.
A local prose linter — iA Writer / Hemingway style — flags passive voice,
adverbs, overlong sentences, and weasel/filler words so the writer can *self-edit*
without leaving the page. It must fit Recto's philosophy precisely:

- **Opt-in.** Highlighting fights minimalism, so it is off by default and toggled
  from the status bar + command palette, like every other Recto knob.
- **Local and offline.** No cloud, no AI, no network call — the analysis is a
  pure function of the document text, run in a Web Worker off the typing hot path.
- **Highlight-only.** It never rewrites, never offers a quick-fix, never auto-edits.
  It surfaces; the writer judges. (A later, separate plan may add an AI *critique*
  panel — local catches mechanics, AI gives judgment. **Do not build any AI here.**)

This matches the product's stated quality bar (see "Vocabulary & constraints"
below): the tool disappears, chrome is minimal, and safety nets (undo, autosave)
are never sacrificed — a display-only overlay sacrifices none of them.

## Current state

Read each cited file first-hand before editing. Line numbers are from commit
`a25c506`. **If a file's live content differs from the excerpts below, STOP.**

### Vocabulary & constraints this plan must honor

From `docs/blueprint/01-product-overview.md` — quote and obey:

- §6 principle 5 (line 164): "**The tool disappears.** Minimal chrome; the writing
  surface dominates … not persistent toolbars." → the linter is off by default;
  its only permanent UI is one small status-bar toggle. No banners, no side panel.
- §6 principle 7 (line 166): "**Minimalism removes chrome, not safety nets.**" →
  the linter is purely additive display; it must never block typing, sync, or undo.
- §6 quality bar (line 155): "Premium and bespoke … restrained dark OKLCH palette
  … Not a templated default." → highlights use OKLCH tokens (Step 8), calm and
  low-chroma, not loud red/yellow/green Hemingway blocks.

The user's standing preference (project memory `recto-prefer-user-toggles.md`):
for any genuine A/B design fork, **build a switchable setting — do not hard-pick.**
This plan honors that by making **each rule category individually toggleable**
(passive / readability / adverbs / weasel-filler), not a fixed bundle.

The project memory `skip-known-pivots-in-audits.md` is not relevant here.

### The existing unified/remark pipeline — the convention to mirror

Recto already standardizes on the unified ecosystem. `retext` is the same family,
so it fits naturally. The pattern to copy:

`lib/markdown/parse.ts` (whole file, 15 lines):
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
Key conventions to mirror in the new `lib/lint/`:
- A single frozen `unified()` processor built once at module scope, reused per call.
- Tiny pure functions, one job each, with a JSDoc one-liner.
- A barrel `index.ts` that re-exports the public surface.
- Tests as siblings (`*.test.ts`) using `vitest` — see `lib/markdown/*.test.ts`.

`lib/markdown/index.ts` barrel (whole file):
```ts
export { countWords } from "./count-words";
export { deriveTitleFromMarkdown, deriveTitleFromMdast } from "./derive-title";
export {
	composeFrontmatter,
	type DocumentMeta,
	EMPTY_META,
	splitFrontmatter,
} from "./frontmatter";
export { normalizeMarkdown } from "./normalize";
export { parseMarkdown } from "./parse";
export { stringifyMdast } from "./serialize";
export { CANONICAL_STRINGIFY } from "./stringify-options";
```

### How retext reports issues (the offset model — read this carefully)

`retext-english` parses **plain text** into an nlcst tree; the rule plugins
(`retext-passive`, `retext-readability`, `retext-indefinite-article`) attach
`VFileMessage`s to the file. `write-good` is a separate plain-text linter that
returns `{ index, offset, reason }` objects. The unifying fact this plan relies on:

- **Every issue carries a 0-indexed character range into the exact string you
  fed the analyzer.** retext `VFileMessage` exposes `place` (modern) with
  `{ start: { line, column, offset }, end: { line, column, offset } }`; older
  versions expose the same under `.position`. `write-good` returns `index`
  (start offset) and `offset` (length).
- The analyzer in this plan **feeds retext the canonical Markdown string itself**
  (after stripping the YAML frontmatter block), NOT a flattened plain-text
  rendering. This is deliberate: CodeMirror's document string *is* that canonical
  Markdown, so retext's offsets map 1:1 onto CM positions with zero translation
  (Step 5). For Milkdown/ProseMirror, those source offsets must be translated to
  PM positions (Step 6 — the hard part).
- Feeding markdown to a plain-text linter does mean markdown syntax characters
  (`**`, `#`, `-`) sit inside the analyzed string. retext-english's tokenizer
  treats them as punctuation/symbols, so they do not create false passive/adverb
  hits in practice, but a sentence-readability span may include a leading `## `.
  That is acceptable for a highlight (the squiggle just starts one or two chars
  early). **Do not attempt to strip markdown and re-map offsets** — that
  re-introduces exactly the mapping problem we are avoiding, in reverse.

### Editor 1 — CodeMirror (raw + vim). Where the decoration layer goes

`lib/editor/codemirror/index.tsx`. This file has **no `index.ts` barrel**; the
import `@/lib/editor/codemirror` resolves directly to `index.tsx`. Current
extension assembly (lines 254–264) — you will add one extension to this array:
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
The view is created at lines 266–270 and exposed via the handle's `getCmView()`
(lines 369–371) returning `EditorView | null`. The component already uses
`Compartment` for `vim` and `spellcheck` (lines 222–223, 237–239, 287–304) — the
**Compartment + reconfigure** pattern is how you push live data into a running
CM view; you will add a third compartment for lint decorations.

CodeMirror packages already installed (from `package.json`): `@codemirror/state`,
`@codemirror/view`, `@codemirror/commands`, `@codemirror/lang-markdown`,
`codemirror`. The decoration API (`Decoration.mark`, `EditorView.decorations`,
`StateField`/`StateEffect`) lives in `@codemirror/view` + `@codemirror/state`,
both present — **no new CodeMirror dependency is needed.**

### Editor 2 — Milkdown / ProseMirror (rich). Where the decoration plugin goes

`lib/editor/milkdown/index.tsx`. Plugins are registered in the `useEditor`
callback via `.use(...)` (lines 108–112):
```ts
.use(commonmark)
.use(gfm)
.use(rectoSlash)
.use(rectoSelectionTooltip)
.use(listener)
```
`rectoSlash` and `rectoSelectionTooltip` are created with Milkdown factories at
module scope (lines 58–59):
```ts
const rectoSlash = slashFactory("RECTO_SLASH");
const rectoSelectionTooltip = tooltipFactory("RECTO_SELECTION");
```
The live ProseMirror view is reachable via the handle's `getPmView()` (lines
280–288) returning `PMEditorView | null`, and the parser via `getParser()`.
ProseMirror itself is a dependency (`prosemirror-state`, `prosemirror-view`,
`prosemirror-model`, `prosemirror-transform`); Milkdown re-exports prose under
`@milkdown/prose/*` (see `selection-toolbar-view.tsx` line 4:
`import type { EditorState, PluginView } from "@milkdown/prose/state";`). Use
`@milkdown/prose/state` and `@milkdown/prose/view` for `Plugin`, `PluginKey`,
`Decoration`, `DecorationSet` — **no new ProseMirror dependency is needed.**

The existing `SelectionToolbarView` (`lib/editor/milkdown/selection-toolbar-view.tsx`)
is the in-repo exemplar of a Milkdown `PluginView` — read it for the shape, but
note: a **decoration** plugin is simpler than a view plugin (it uses
`props.decorations` on a plain `Plugin`, not a `PluginView` class).

### Where the status-bar toggle goes

`components/status-bar.tsx`. The spellcheck toggle (lines 255–264) is the exact
pattern to copy for a lint toggle — an `iconBtn` with `aria-pressed` and an
accent tint when on:
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
`StatusBarProps` is defined at lines 36–56; icons import from `lucide-react` at
lines 3–13. The optional issue-count slot mirrors the word-count span (lines
282–284): `{formatWordCount(wordCount)}`.

### Settings persistence — the toggle store to extend

`lib/studio/use-studio-settings.ts`. The `StudioSettings` type (lines 21–32),
`DEFAULTS` (lines 38–44), `loadSettings` validation (lines 57–85), the
`StudioSettingsApi` type (lines 87–97), and the `useStudioSettings` hook
(lines 103–177) form one cohesive localStorage-backed store under
`STORAGE_KEY = "recto:studio-settings"` (line 46). The `toggleSpellcheck`
callback (lines 157–159) is the exact pattern to copy:
```ts
const toggleSpellcheck = useCallback(() => {
	setSettings((s) => ({ ...s, spellcheck: !s.spellcheck }));
}, []);
```
Settings reach deep panes via `lib/studio/settings-context.tsx`
(`useStudioSettingsContext()`), already consumed in
`components/workspace/pane-editor.tsx:60` (`const { spellcheck } = useStudioSettingsContext();`).

### Where editors get their data, and how lint state must flow

`components/workspace/pane-editor.tsx` mounts both editors (Milkdown at lines
464–470, CodeMirror at lines 473–483) and already reads settings via context
(line 60). The live document text the writer sees is `markdown` (line 93:
`const markdown = paneMarkdown ?? sync?.markdown ?? "";`). **Critical Recto rule
(from `CLAUDE.md` / blueprint 05): the editor owns live state; you must NOT bind
the editor value to a reactive query.** The linter is read-only of the editor's
*current* text, so:
- Source the text to analyze from the editor handle's `getCanonicalMarkdown()`
  (CM: line 327; Milkdown: lines 152–156), debounced after edits — NOT from a
  Convex `useQuery`. The `onChange` callbacks already fire on every keystroke
  (`sync?.handleEditorChange`, passed at lines 467 & 478) — reuse that signal to
  schedule a debounced re-analyze.

### app/globals.css — token & editor-CSS conventions

OKLCH tokens are declared in `@theme` (lines 8–119) and overridden per theme
under `:root[data-theme="…"]` (lines 125–192). Tokens you will reuse / add
(Step 8). Existing relevant tokens (line refs):
- `--color-warning: oklch(0.84 0.1 85)` (line 32) — amber.
- `--color-accent` / `--color-accent-2` / `--color-accent-muted` (lines 27–29).
- `--color-ink-tertiary` (line 21) — muted ink.

Editor surfaces are styled by class: `.codemirror .cm-editor` (line 325),
`.milkdown .ProseMirror` (line 311). Decoration CSS hangs off these. The squiggle
should be a `text-decoration` underline so it never shifts layout (no borders/
backgrounds that change box size).

## Commands you will need

| Purpose      | Command                                            | Expected on success            |
|--------------|----------------------------------------------------|--------------------------------|
| Install dep  | `bun add <pkg>`                                     | exit 0, added to `package.json`|
| Typecheck    | `bun run typecheck`                                 | exit 0, no errors              |
| Lint/format  | `bun run biome`                                     | exit 0 (or `bunx biome check --write .` to auto-fix) |
| Unit tests   | `bunx vitest run lib/lint/analyze.test.ts`          | all pass                       |
| Full tests   | `bun run test`                                      | all pass                       |
| Build        | `bun run build`                                     | exit 0, compiles               |
| Dev (manual) | `bun run dev`                                       | studio at localhost            |

(Use `bun` / `bunx`, never `npm`/`npx` — see `CLAUDE.md`.)

## Suggested executor toolkit

- Use context7 / the unified docs for `retext-passive`, `retext-readability`,
  `write-good`, and `unist-util-position` (`pointStart`/`pointEnd`) if any API
  shape below does not match the installed version — pin behavior to the
  installed code, not memory.
- ProseMirror decoration reference: <https://prosemirror.net/docs/ref/#view.Decoration>
  (`Decoration.inline(from, to, attrs)`, `DecorationSet.create(doc, decos)`).
- CodeMirror decoration reference: <https://codemirror.net/docs/ref/#view.Decoration>
  (`Decoration.mark({ class })`, `EditorView.decorations` via a `StateField`).

## Scope

**In scope** (the only files you should modify or create):
- `lib/lint/analyze.ts` (create) — the pure analyzer.
- `lib/lint/types.ts` (create) — `LintIssue`, `LintCategory`, `LintOptions`.
- `lib/lint/index.ts` (create) — barrel.
- `lib/lint/analyze.test.ts` (create) — analyzer tests.
- `lib/lint/worker.ts` (create) — Web Worker entry that runs `analyze`.
- `lib/lint/use-prose-lint.ts` (create) — React hook: debounce + worker + state.
- `lib/editor/codemirror/lint-extension.ts` (create) — CM decoration field/effect.
- `lib/editor/milkdown/lint-plugin.ts` (create) — PM decoration plugin.
- `lib/editor/codemirror/index.tsx` (edit) — wire the CM lint compartment + handle method.
- `lib/editor/milkdown/index.tsx` (edit) — register the PM lint plugin + handle method.
- `components/workspace/pane-editor.tsx` (edit) — run the hook, push issues to handles.
- `components/status-bar.tsx` (edit) — add the lint toggle (+ optional count).
- `components/studio-shell.tsx` (edit) — pass lint props/dispatch to StatusBar.
- `lib/studio/use-studio-settings.ts` (edit) — persist lint on/off + per-category flags.
- `app/globals.css` (edit) — squiggle tokens + per-category decoration CSS.
- `package.json` / `bun.lock` (edit, via `bun add`) — new deps.

**Out of scope** (do NOT touch):
- Convex (`convex/**`) — the linter is purely client-side; **no schema, no
  mutation, no query.** Lint preferences live in localStorage like other settings.
- Any AI / critique feature — explicitly deferred to a future plan.
- The lossless bridge (`lib/bridge/**`), undo tree (`lib/history/**`), sync
  (`lib/sync/**`) — the linter reads editor text; it never participates in
  edits, history, or persistence.
- `lib/markdown/*` — reuse `splitFrontmatter` (already exported from the barrel)
  to drop the YAML block; do not modify the markdown pipeline.
- The preview pane and command-palette action wiring beyond adding the toggle
  action (optional; see Step 9) — keep the diff minimal.

## Git workflow

- Branch: `advisor/004-local-prose-linter` (create from `main`).
- Commit per logical step (or per few steps), conventional-commit style matching
  the repo log, e.g. `feat: add offline prose linter analyzer` /
  `feat: highlight prose-lint issues in both editors`. **No AI attribution, no
  Co-Authored-By lines, author = the user** (see `CLAUDE.md`).
- Do NOT push or open a PR unless the operator instructs it.

## Steps

Build the pure, testable core first (Steps 1–4), verify it in isolation, then
wire UI (Steps 5–10). The codebase stays green between steps.

### Step 1: Install dependencies

```
bun add retext-english retext-passive retext-readability retext-indefinite-article write-good unified vfile unist-util-position
```
`unified` is already a dep; re-adding is a no-op. `write-good` has no published
types — if `bun run typecheck` later complains, add a one-line ambient
declaration `declare module "write-good";` in a new `lib/lint/write-good.d.ts`
(this file is then in-scope) rather than `// @ts-expect-error`.

**Verify**: `grep -E "retext-passive|retext-readability|write-good|retext-english" package.json` → all four present. `bun run typecheck` → exit 0 (no consumers yet).

### Step 2: Define the lint types — `lib/lint/types.ts`

```ts
/** A rule family the writer can toggle independently (A/B/granular fork). */
export type LintCategory = "passive" | "readability" | "adverb" | "weasel";

/** One highlightable issue, as a char range into the canonical-markdown BODY. */
export type LintIssue = {
	/** 0-indexed start offset into the analyzed text (= canonical markdown body). */
	from: number;
	/** 0-indexed end offset (exclusive). */
	to: number;
	category: LintCategory;
	/** Short human reason, e.g. "passive voice" / "hard to read" / "weasel word". */
	message: string;
};

/** Which categories are active. All true = analyze everything. */
export type LintOptions = Record<LintCategory, boolean>;

export const ALL_CATEGORIES: readonly LintCategory[] = [
	"passive",
	"readability",
	"adverb",
	"weasel",
];
```

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Write the pure analyzer — `lib/lint/analyze.ts`

Contract: `analyze(markdown: string, options: LintOptions): LintIssue[]`.

Required behavior:
1. Strip the YAML frontmatter block with `splitFrontmatter` from
   `@/lib/markdown` and analyze **only `body`** — but return offsets relative to
   the **body string**, since that is what both editors hold (Milkdown renders
   body only; CM's doc is the full canonical, so the consumer adjusts — see Step 5
   note). To keep the analyzer single-meaning, it operates on whatever string it
   is given; the caller decides whether to pass full canonical or body. **Make
   `analyze` take the exact string to scan and return offsets into that string.**
   Do the frontmatter split in the *hook* (Step 7), not here. (This keeps
   `analyze` a pure text→issues function, trivially testable.)
2. Build one frozen retext processor at module scope:
   ```ts
   const retextProcessor = unified()
   	.use(retextEnglish)
   	.use(retextPassive)
   	.use(retextReadability, { age: 18 })
   	.use(retextIndefiniteArticle);
   ```
   Use `.parse()` then `.runSync(tree, file)` (synchronous — required because this
   runs inside the worker's message handler), or `await .process(text)`. Prefer
   the sync path; if the installed retext only exposes async `process`, the worker
   handler may be async — that is fine.
3. Map each retext `VFileMessage` to a `LintIssue`:
   - Read the range from `message.place ?? message.position`. Use
     `start.offset` and `end.offset`. If either offset is missing/null, **skip
     that message** (do not guess a range).
   - Category: `message.source === "retext-passive"` → `"passive"`;
     `message.source === "retext-readability"` → `"readability"`;
     `retext-indefinite-article` → fold into `"readability"` (it is a
     grammar/readability nicety) OR drop it if `readability` is off.
4. Adverbs + weasel/filler/cliché come from `write-good`:
   ```ts
   import writeGood from "write-good";
   const suggestions = writeGood(text); // [{ index, offset, reason }, ...]
   ```
   `write-good` flags adverbs ("-ly"), weasel words, passive (overlaps retext —
   prefer retext for passive and **disable write-good's passive check** to avoid
   double-flags) and clichés. Configure it:
   ```ts
   writeGood(text, { passive: false }); // retext owns passive
   ```
   Classify each suggestion by `reason`: if `/adverb/i.test(reason)` →
   `"adverb"`; else → `"weasel"`. Range: `from = index`, `to = index + offset`.
5. Filter the combined list by `options[category] === true`. Merge & sort by
   `from`. **De-dupe exact `[from,to,category]` triples.** Return the array.
6. Guard: if `text.trim() === ""`, return `[]` immediately.

Justification for libraries (per `CLAUDE.md` "prefer battle-tested libraries"):
retext is the unified-family standard for prose analysis and gives precise
offset ranges; write-good is the de-facto adverb/weasel/cliché detector. Rolling
custom regex linters would be inferior and is explicitly disallowed.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Write the analyzer tests — `lib/lint/analyze.test.ts`

Model structure on `lib/markdown/count-words.test.ts` (vitest `describe`/`it`,
import from sibling). Cover, at minimum, one fixture per category with an exact
known issue, asserting the issue exists AND its range lands on the right substring:

```ts
import { describe, expect, it } from "vitest";
import { analyze } from "./analyze";
import { ALL_CATEGORIES } from "./types";

const ALL = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true])) as Record<
	(typeof ALL_CATEGORIES)[number],
	boolean
>;

describe("analyze", () => {
	it("returns nothing for empty text", () => {
		expect(analyze("", ALL)).toEqual([]);
	});

	it("flags passive voice", () => {
		const text = "The ball was thrown by the boy.";
		const issues = analyze(text, ALL).filter((i) => i.category === "passive");
		expect(issues.length).toBeGreaterThan(0);
		// the flagged span sits inside the sentence
		const it0 = issues[0]!;
		expect(text.slice(it0.from, it0.to)).toMatch(/thrown|was thrown/);
	});

	it("flags an adverb", () => {
		const text = "She quickly ran home.";
		const issues = analyze(text, ALL).filter((i) => i.category === "adverb");
		expect(issues.length).toBeGreaterThan(0);
		expect(text.slice(issues[0]!.from, issues[0]!.to)).toContain("quickly");
	});

	it("flags a long / hard-to-read sentence", () => {
		const text =
			"This is an extraordinarily long and convoluted sentence that keeps " +
			"going and going with many clauses and qualifications and asides so " +
			"that the reader struggles to hold the whole thought in mind at once.";
		const issues = analyze(text, ALL).filter(
			(i) => i.category === "readability",
		);
		expect(issues.length).toBeGreaterThan(0);
	});

	it("flags a weasel / filler word", () => {
		const text = "This is very important and clearly obvious.";
		const issues = analyze(text, ALL).filter((i) => i.category === "weasel");
		expect(issues.length).toBeGreaterThan(0);
	});

	it("respects category toggles", () => {
		const text = "She quickly ran home.";
		const off = { ...ALL, adverb: false };
		expect(analyze(text, off).some((i) => i.category === "adverb")).toBe(false);
	});

	it("returns ranges within bounds and from < to", () => {
		const text = "The cake was eaten very quickly by the dog.";
		for (const i of analyze(text, ALL)) {
			expect(i.from).toBeGreaterThanOrEqual(0);
			expect(i.to).toBeLessThanOrEqual(text.length);
			expect(i.from).toBeLessThan(i.to);
		}
	});
});
```
If a specific fixture does not trip its rule with the installed version, adjust
the fixture sentence (keep it canonical for that rule — e.g. a clearer passive
"The report was written by Jane") until the rule fires; **do not weaken the
assertion to `.toBeGreaterThanOrEqual(0)`** — that asserts nothing.

Also create `lib/lint/index.ts`:
```ts
export { analyze } from "./analyze";
export { ALL_CATEGORIES, type LintCategory, type LintIssue, type LintOptions } from "./types";
```

**Verify**: `bunx vitest run lib/lint/analyze.test.ts` → all tests pass.
This is the **STOP gate** for the whole plan: if you cannot make all four
category fixtures + the bounds test pass with real ranges, STOP and report —
the offset model is unreliable and the highlighting cannot land correctly.

### Step 5: CodeMirror decoration extension — `lib/editor/codemirror/lint-extension.ts`

CM's document string is the **full canonical markdown** (frontmatter included).
The analyzer ran on the **body**. So issue offsets are relative to the body, and
the body begins at `frontmatterLength` within the CM doc. The extension takes
issues already shifted to **full-doc offsets** — do the shift in the hook (Step 7)
where the frontmatter length is known, so this extension is dumb: it maps
`{from,to}` directly to CM positions.

Implement a `StateEffect` + `StateField` + `EditorView.decorations`:
```ts
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { LintIssue } from "@/lib/lint";

export const setLintIssues = StateEffect.define<LintIssue[]>();

const lintField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes); // keep marks aligned through edits
		for (const e of tr.effects) {
			if (e.is(setLintIssues)) {
				const docLen = tr.state.doc.length;
				const marks = e.value
					.filter((i) => i.from < i.to && i.to <= docLen)
					.sort((a, b) => a.from - b.from)
					.map((i) =>
						Decoration.mark({
							class: `recto-lint recto-lint--${i.category}`,
							attributes: { title: i.message },
						}).range(i.from, i.to),
					);
				deco = Decoration.set(marks, true);
			}
		}
		return deco;
	},
	provide: (f) => EditorView.decorations.from(f),
});

export function lintExtension(): Extension {
	return lintField;
}
```
Push issues with `view.dispatch({ effects: setLintIssues.of(issues) })`.

**Verify**: `bun run typecheck` → exit 0.

### Step 6: ProseMirror (Milkdown) decoration plugin — `lib/editor/milkdown/lint-plugin.ts`

**This is the hard, load-bearing step.** Milkdown renders only the markdown
**body**, parsed into a ProseMirror document. retext gave offsets into the body
*source markdown string*. ProseMirror positions are NOT source offsets — they are
positions in the PM document tree (each node boundary counts). You must translate
**source-text offset → PM position**.

Recommended approach — walk the PM doc's text nodes and accumulate the plain text,
building a map from cumulative source-ish text offset to PM position:

```ts
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { LintIssue } from "@/lib/lint";

export const lintPluginKey = new PluginKey<DecorationSet>("RECTO_LINT");
export const setLintMeta = "recto-set-lint";

/** Build inline decorations by matching issue text spans against PM text. */
function buildDecorations(doc: PMNode, issues: LintIssue[]): DecorationSet {
	// Collect text leaves with their PM positions.
	const segments: { text: string; pos: number }[] = [];
	doc.descendants((node, pos) => {
		if (node.isText && node.text) segments.push({ text: node.text, pos });
		return true;
	});
	// ...map issue [from,to] (source offsets) onto these segments (see note).
}
```

**The mapping problem and the chosen mitigation.** The body source markdown and
the PM document's concatenated text differ: markdown syntax (`**`, `_`, `#`,
list markers) is in the source but not in PM text leaves, and PM inserts position
gaps at node boundaries. A naive cumulative-offset equality will drift.

Use this robust strategy instead — **re-derive ranges from the issue's text, not
its numeric offset**:
1. In `analyze` (Step 3), additionally store `text: string` on each `LintIssue`
   (the exact substring `source.slice(from, to)`). Add `text` to the `LintIssue`
   type in Step 2. (CM still uses numeric offsets; Milkdown uses the text.)
2. In `buildDecorations`, for each issue, search the PM text leaves for the
   issue's `text`. For a text leaf containing it at local index `k`, the PM range
   is `[leafPos + k, leafPos + k + text.length]`. Wrap with
   `Decoration.inline(from, to, { class: "recto-lint recto-lint--" + category, title: message })`.
3. Skip issues whose `text` contains markdown syntax chars that won't appear in
   PM text (e.g. spans starting with `## ` or containing `**`) — those are
   readability spans that crossed a syntax boundary; dropping them in rich mode is
   acceptable (they still show in raw/vim where offsets are exact). Track how many
   were skipped; if **>40% of readability issues are unmappable in rich mode**,
   that is a STOP condition (the rich-mode highlight is too lossy to ship).

The plugin:
```ts
export function lintPlugin(): Plugin {
	return new Plugin<DecorationSet>({
		key: lintPluginKey,
		state: {
			init: () => DecorationSet.empty,
			apply(tr, old) {
				const issues = tr.getMeta(setLintMeta) as LintIssue[] | undefined;
				if (issues) return buildDecorations(tr.doc, issues);
				return old.map(tr.mapping, tr.doc);
			},
		},
		props: {
			decorations(state) {
				return this.getState(state);
			},
		},
	});
}
```
Push with `view.dispatch(view.state.tr.setMeta(setLintMeta, issues))`.

Register it in `lib/editor/milkdown/index.tsx`. Milkdown wraps raw ProseMirror
plugins via `prosePluginsCtx` or `$prose` from `@milkdown/utils`. Use the
`$prose` helper:
```ts
import { $prose } from "@milkdown/utils";
const rectoLint = $prose(() => lintPlugin());
// ...then in the .use chain:
.use(rectoLint)
```
If `$prose` is unavailable in the installed `@milkdown/utils`, fall back to
configuring `ctx` with `prosePluginsCtx` inside `.config(...)`. Verify the helper
exists first: `grep -r "\\\$prose\|prosePluginsCtx" node_modules/@milkdown/utils/lib 2>/dev/null | head`.

**Verify**: `bun run typecheck` → exit 0. (Visual verification happens in Step 10.)

### Step 7: The lint hook — `lib/lint/use-prose-lint.ts`

A React hook that owns: the worker, debounce, frontmatter split, offset shifting,
and exposing issues + count. Web Worker setup (Turbopack-supported in Next 16):

```ts
const worker = new Worker(new URL("./worker.ts", import.meta.url));
```
`lib/lint/worker.ts`:
```ts
import { analyze } from "./analyze";
import type { LintOptions } from "./types";

self.onmessage = (e: MessageEvent<{ id: number; text: string; options: LintOptions }>) => {
	const { id, text, options } = e.data;
	const issues = analyze(text, options);
	(self as unknown as Worker).postMessage({ id, issues });
};
```
The hook:
- Takes `(getMarkdown: () => string, options: LintOptions, enabled: boolean, changeSignal: unknown)`.
- Debounces 400ms after `changeSignal` changes (use `useDebounce` from
  `use-debounce`, already a dep — see `package.json`). On fire: read
  `getMarkdown()`, `splitFrontmatter` it, post `{ id, body, options }` to the worker.
- On worker message with matching latest `id`, store `bodyIssues` and compute
  `docIssues` = same issues shifted by `+frontmatterLength` (for CM's full-doc
  string). Expose `{ bodyIssues, docIssues, count: bodyIssues.length }`.
- When `enabled` is false, post nothing and return empty arrays.
- Clean up: terminate the worker on unmount.

**Worker fallback (STOP-condition mitigation):** if `new Worker(new URL(...))`
fails to build under Turbopack/Bun (Step caught by `bun run build`), replace the
worker call with a direct, `requestIdleCallback`-scheduled call to `analyze` on
the main thread (analysis of a typical document is sub-10ms, so this is
acceptable degradation). Keep the same hook surface so no consumer changes. Do
NOT spend more than two attempts wiring the worker — fall back and note it.

**Verify**: `bun run typecheck` → exit 0.

### Step 8: Decoration CSS + tokens — `app/globals.css`

Add tokens to `@theme` (after the warning token, ~line 33), calm and low-chroma:
```css
	/* Prose-lint squiggles — calm, per-category, OKLCH. Underlines only, so they
	   never shift layout. */
	--color-lint-passive: oklch(0.74 0.1 290);   /* periwinkle, like accent */
	--color-lint-readability: oklch(0.84 0.1 85); /* amber = "slow down" */
	--color-lint-adverb: oklch(0.78 0.08 250);   /* soft blue */
	--color-lint-weasel: oklch(0.7 0.09 330);    /* muted rose */
```
Then a single decoration block (works in both `.codemirror` and `.milkdown`
because both use the same class names):
```css
.recto-lint {
	text-decoration-line: underline;
	text-decoration-style: wavy;
	text-decoration-thickness: 1px;
	text-underline-offset: 3px;
	text-decoration-skip-ink: none;
}
.recto-lint--passive { text-decoration-color: var(--color-lint-passive); }
.recto-lint--readability { text-decoration-color: var(--color-lint-readability); }
.recto-lint--adverb { text-decoration-color: var(--color-lint-adverb); }
.recto-lint--weasel { text-decoration-color: var(--color-lint-weasel); }
```
Place these alongside the other editor CSS (after the `.codemirror`/`.milkdown`
rules, e.g. near line 334). Per-theme overrides are optional — the base tokens
read acceptably on all four themes; add overrides only if a color washes out.

**Verify**: `bun run biome` → exit 0. `bun run build` → exit 0.

### Step 9: Persist settings — `lib/studio/use-studio-settings.ts`

Extend the store (do NOT create a new store):
- Add to `StudioSettings`: `lint: boolean;` and `lintCategories: LintOptions;`
  (import `LintOptions` from `@/lib/lint`).
- `DEFAULTS`: `lint: false` (off — opt-in), `lintCategories: { passive: true,
  readability: true, adverb: true, weasel: true }`.
- `loadSettings`: validate `lint` as boolean (default false); validate
  `lintCategories` by coercing each of the four keys to boolean, defaulting true.
- `StudioSettingsApi`: add `toggleLint: () => void;` and
  `toggleLintCategory: (c: LintCategory) => void;`.
- Implement both with the `useCallback`/`setSettings` pattern of `toggleSpellcheck`.

**Verify**: `bun run typecheck` → exit 0.

### Step 10: Wire UI — status bar, studio-shell, pane-editor

1. `components/status-bar.tsx`: add props `lint: boolean`, `onToggleLint: () => void`,
   and optional `lintCount: number`. Add a toggle button copying the spellcheck
   button (use a lucide icon, e.g. `SpellCheck2` or `ScanText`; pick one that
   exists in the installed `lucide-react`). When `lint && lintCount > 0`, show a
   tiny count next to the word count (reuse the tabular-nums span style).
2. `components/studio-shell.tsx`: pass `lint={settings.lint}`,
   `onToggleLint={() => { settings.toggleLint(); dispatchFocusEditor(); }}`, and
   `lintCount={...}` to `<StatusBar>` (lines 590–630). The count comes from the
   active pane — simplest: lift the active pane's issue count via a small
   context or a window event. **Simplest acceptable wiring:** have `pane-editor`
   dispatch a `recto:lint-count` CustomEvent on change and have studio-shell hold
   it in state. If that feels heavy, omit the count entirely (the brief says
   count is *optional*) and ship just the toggle.
3. `components/workspace/pane-editor.tsx`:
   - Read `lint`, `lintCategories` from `useStudioSettingsContext()`.
   - Call `useProseLint(() => getEditorHandle()?.getCanonicalMarkdown() ?? "",
     lintCategories, lint, changeTick)` where `changeTick` increments in the
     existing `onChange` path. Reuse the `onChange` already passed to both editors.
   - On `{ docIssues, bodyIssues }` change: call `cmRef.current` and
     `richRef.current` new handle methods `setLintIssues(...)` (Step 5/6 wiring),
     passing `docIssues` to CM and `bodyIssues` to Milkdown.
4. `lib/editor/codemirror/index.tsx`: add `lintExtension()` to the `extensions`
   array (after `markdown()`), and add a `setLintIssues(issues: LintIssue[])`
   method to the handle that dispatches the `setLintIssues` effect. Extend
   `CodeMirrorEditorHandle` type accordingly.
5. `lib/editor/milkdown/index.tsx`: `.use(rectoLint)` and add a
   `setLintIssues(issues: LintIssue[])` handle method that dispatches the
   `setLintMeta` tr on `getPmView()`. Extend `MilkdownEditorHandle` type.

**Verify**:
- `bun run typecheck` → exit 0.
- `bun run biome` → exit 0.
- `bun run build` → exit 0.
- `bun run dev`, open the studio, toggle the lint button on: passive/adverb/long
  sentences/weasel words show calm wavy underlines in **rich**, **raw**, and
  **vim** modes; toggling off removes them; typing does not stutter. Toggling a
  category off removes only that color.

## Test plan

- New file `lib/lint/analyze.test.ts` (Step 4): one fixture per category
  (passive, adverb, readability/long-sentence, weasel) asserting the issue
  exists AND its range lands on the expected substring; an empty-input case; a
  category-toggle case; a range-bounds invariant case. Model on
  `lib/markdown/count-words.test.ts`.
- The analyzer is the only unit under test (it is the pure core). The decoration
  layers (CM/PM) are verified manually in Step 10 (`bun run dev`) — automated
  editor-integration tests are out of scope for this plan.
- Verification: `bunx vitest run lib/lint/analyze.test.ts` → all pass (≥7 tests);
  then `bun run test` → the full suite still passes (nothing regressed).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `bunx vitest run lib/lint/analyze.test.ts` passes with ≥4 category fixtures
      asserting real substrings (not `>= 0`).
- [ ] `bun run test` exits 0 (full suite, no regressions).
- [ ] `bun run biome` exits 0.
- [ ] `bun run build` exits 0.
- [ ] `grep -rn "retext-passive\|retext-readability\|write-good" package.json` → matches.
- [ ] `grep -rn "convex" lib/lint/` → no matches (linter is fully client-side, no write path).
- [ ] `grep -rn "recto-lint" app/globals.css lib/editor/codemirror lib/editor/milkdown` → matches in all three.
- [ ] Lint defaults to OFF: `grep -n "lint:" lib/studio/use-studio-settings.ts` shows `lint: false` in DEFAULTS.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated (if the file exists).

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt does not match the live file (the codebase drifted
  since commit `a25c506`).
- **Step 4 gate:** the analyzer's category fixtures cannot be made to pass with
  real, in-bounds ranges — i.e. retext/write-good offsets do not map reliably
  onto the source string. The whole feature depends on this; do not proceed to
  highlighting with a broken core.
- **Step 6 gate:** more than ~40% of readability issues are unmappable to
  ProseMirror positions in rich mode (the text-search re-derivation fails too
  often). Report; the team may decide to ship lint in raw/vim only.
- **Step 7 gate:** the Web Worker (`new Worker(new URL("./worker.ts", import.meta.url))`)
  cannot be built under Turbopack/Bun after applying the documented main-thread
  fallback, AND the main-thread fallback also fails to typecheck/build.
- Wiring the linter appears to require touching Convex, the bridge, the undo
  tree, or the sync layer — it must not. If you believe it does, STOP: the design
  is being violated.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this after it lands:

- **The two offset paths are intentionally different.** CM uses numeric offsets
  (its doc string == canonical markdown, exact). Milkdown uses text re-search
  (its doc is a parsed tree; numeric source offsets don't line up). If the rich
  highlight ever looks misplaced, suspect the `buildDecorations` text-search in
  `lib/editor/milkdown/lint-plugin.ts`, not the analyzer.
- **Frontmatter shift.** CM analyzes/decorates the full canonical string, so the
  hook shifts body-relative offsets by `frontmatterLength`. If the frontmatter
  serialization changes (see `lib/markdown/frontmatter.ts`), re-verify the shift.
- **A reviewer should scrutinize**: (1) that the linter never calls a Convex
  mutation/query or touches the bridge/history; (2) that analysis is debounced
  and off the main thread (or idle-scheduled) so typing never stutters; (3) that
  it is OFF by default; (4) that highlights are display-only and survive edits
  (decorations re-map through transactions).
- **Deferred (out of this plan, by design):** the AI critique panel that pairs
  with this (local mechanics + AI judgment); per-theme squiggle color overrides
  if any wash out; a command-palette action for the toggle (add to
  `lib/keyboard/actions.ts` if desired — that file is out of scope here);
  surfacing the issue *message* on hover/click beyond the native `title` tooltip.
```
