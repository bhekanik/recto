# Plan 001: Word-level version diff with a compare-two-versions UX

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat a25c506..HEAD -- lib/history/diff.ts components/history/history-panel.tsx lib/studio/use-studio-settings.ts lib/studio/settings-context.tsx components/studio-shell.tsx
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: feature (direction)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

The branching undo tree, named versions, and per-node materialization are all
built and working. The one weak spot is comparison: today the only diff is a
**line-level LCS** (`lib/history/diff.ts` → `diffLines`). Because the editor's
canonical Markdown reflows paragraphs, a one-word edit re-wraps the line and the
LCS reports the **entire paragraph** as deleted-then-added. That makes "what
actually changed between these two points" unreadable — the opposite of what a
typography-first writing studio should offer. Word/clause-level diff is the prose
standard (Scrivener Compare, Google Docs version history, Word Blackline). This
plan replaces the line diff with a word-level diff from a battle-tested library,
adds an explicit compare-two-versions flow, and exposes the inline-vs-side-by-side
and word-vs-line choices as remembered user toggles (the user prefers knobs over
fixed picks — see "Design constraints"). Restore semantics are untouched.

## Current state

Files and their roles:

- `lib/history/diff.ts` — the diff core. Exports `diffLines(a, b): DiffLine[]`
  (line-level LCS) and `nodeLabel(...)`. **This is the file you change/augment.**
- `components/history/history-panel.tsx` — the history UI. Renders the undo tree
  and versions list, and at the bottom shows either a compare diff or a hover
  preview. Holds `compare`/`compareSel` state and calls `diffLines`. **This is
  where the new diff UI renders.**
- `lib/history/use-document-history.ts` — `HistoryController`. Exposes
  `materializeAt(nodeId): string | null` (client-side materialize of any node).
  The panel uses this to get the two texts to compare. No change needed.
- `lib/history/materialize.ts` — pure helpers (`materialize`, `indexNodes`,
  `childrenByParent`, `depthOf`). No change needed.
- `convex/docNodes.ts` — `getSnapshotAt` (server materialize). Available as a
  fallback but **not required**: the panel already has client-side
  `materializeAt`, which is what the existing compare uses. Do NOT switch to the
  server query (it adds a round-trip and a loading state for no benefit here).
- `convex/versions.ts` — `list`, `restore`. Read-only context. Do NOT change.
- `lib/history/history.test.ts` — the test patterns to model new tests on
  (plain `vitest` `describe`/`it`/`expect`, pure functions, table-driven cases).
- `lib/studio/use-studio-settings.ts` — the persisted-settings pattern (one
  `StudioSettings` object in `localStorage`, typed toggles). You ADD two fields.
- `lib/studio/settings-context.tsx` — `useStudioSettingsContext()` lets any
  component under the provider read settings. The history panel renders inside
  the provider (`components/studio-shell.tsx:672` closes `</StudioSettingsProvider>`,
  `HistoryPanel` is rendered at line 656, inside it), so the panel CAN call
  `useStudioSettingsContext()` directly — no prop drilling.

### `lib/history/diff.ts` — the diff to replace (current, full file)

```ts
export type DiffLine = { type: "add" | "del" | "same"; text: string };

/**
 * A minimal LCS line diff of two canonical-Markdown strings (blueprint 08 §5 —
 * compare diffs the source, not rendered HTML). Read-only.
 */
export function diffLines(a: string, b: string): DiffLine[] {
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	// ... LCS dp table, backtrack into add/del/same DiffLine[] ...
}

/** A short human label for an undo node, derived from its patch (blueprint 07 §4 B4). */
export function nodeLabel(
	patch: string,
	parentNodeId: string | null,
	origin?: string,
): string {
	// ... unchanged; keep as-is ...
}
```

`diffLines` is at `lib/history/diff.ts:7-54`; `nodeLabel` at `:57-81`.
**Keep `diffLines` and `DiffLine` exported** (do not delete — they remain the
"line" granularity option). Add new exports alongside.

### `components/history/history-panel.tsx` — where the diff renders (current)

The compare state and computation (`:84-138`):

```tsx
const [preview, setPreview] = useState<string | null>(null);
const [compare, setCompare] = useState<[string, string] | null>(null);
// ...
const compareDiff = useMemo(() => {
	if (!compare || !history) return null;
	const a = history.materializeAt(compare[0]);
	const b = history.materializeAt(compare[1]);
	if (a == null || b == null) return null;
	return diffLines(a, b);
}, [compare, history]);
```

The compare-selection toggle, currently only wired in the **versions** list
(`:150-163`):

```tsx
const [compareSel, setCompareSel] = useState<string[]>([]);
const setCompareSelection = useCallback((nodeId: string) => {
	setCompareSel((prev) => {
		const next = prev.includes(nodeId)
			? prev.filter((id) => id !== nodeId)
			: [...prev, nodeId].slice(-2);
		if (next.length === 2) {
			setCompare([next[0] as string, next[1] as string]);
		} else {
			setCompare(null);
		}
		return next;
	});
}, []);
```

The "Compare" button per version row (`:328-337`) calls `setCompareSelection(v.nodeId)`
and shows `selected ? "Comparing" : "Compare"`.

The bottom render — the part you replace with word-level / side-by-side
rendering (`:385-412`):

```tsx
{compareDiff ? (
	<div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-[var(--color-line)] bg-[var(--color-bg-app)] px-[var(--space-3)] py-[var(--space-2)] font-[family-name:var(--font-mono)] text-[0.75rem] leading-relaxed">
		{compareDiff.map((line, i) => (
			<div
				key={i}
				className={cn(
					"whitespace-pre-wrap",
					line.type === "add" && "bg-[oklch(0.8_0.09_150/0.12)] text-[var(--color-success)]",
					line.type === "del" && "bg-[oklch(0.7_0.14_25/0.12)] text-[var(--color-danger)]",
					line.type === "same" && "text-[var(--color-ink-tertiary)]",
				)}
			>
				{line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
				{line.text || " "}
			</div>
		))}
	</div>
) : preview != null ? (
	<div className="max-h-[28%] ... text-[var(--color-ink-tertiary)]">
		<div className="whitespace-pre-wrap">
			{preview.slice(0, 500) || "(empty)"}
			{preview.length > 500 ? "…" : ""}
		</div>
	</div>
) : null}
```

### Design constraints (honor these — quoted from the repo)

- **User toggles over fixed picks.** `lib/studio/use-studio-settings.ts:99-102`:
  "Persisted, user-tunable writing-surface settings. The user prefers knobs over
  fixed picks (font, zoom, spellcheck, chrome) — each is a remembered toggle."
  → The inline-vs-side-by-side and word-vs-line choices MUST be remembered
  settings, not hard-coded.
- **Restore is additive — never rewinds.** `convex/versions.ts:65-68` and the
  panel copy at `components/history/history-panel.tsx:285-287`: "Restore is
  additive — it never erases later edits." → Do NOT touch restore.
- **Diff the source, not rendered HTML.** `lib/history/diff.ts:4` (blueprint 08
  §5): compare canonical Markdown strings. → Keep feeding materialized Markdown
  into the diff; never diff rendered HTML.
- **OKLCH semantic tokens, dark-only.** Added runs use `--color-success`
  (`app/globals.css:31` → `oklch(0.8 0.095 155)`); deleted runs use
  `--color-danger` (`app/globals.css:33` → `oklch(0.7 0.16 20)`); structural
  chrome uses `--color-line`, `--color-bg-app`, `--font-mono`. Reuse these
  tokens; do not introduce new raw colors beyond the existing wash literals.

### Library choice (battle-tested, not custom)

Use **`diff`** (a.k.a. jsdiff, npm package name `diff`). Rationale:

- Maintained, ubiquitous (it is the diff engine many tools use), ships its own
  TypeScript types — no `@types/diff` needed.
- Provides exactly the granularities we need as drop-in functions:
  `diffWordsWithSpace(oldStr, newStr)` (word-level, whitespace/newlines as
  distinct tokens — best for prose because it preserves spacing) and `diffLines`
  for the line option.
- Returns an array of **Change** objects: `{ value: string; added?: boolean;
  removed?: boolean; count?: number }`. `added && removed` both false ⇒ common
  text. This maps cleanly onto inline ins/del runs.
- It is currently only a **transitive** dependency (pulled in by
  `@manuscripts/prosemirror-recreate-steps` and `shadcn`), NOT a direct one.
  You must add it as a direct dependency so the import is stable:
  `bun add diff`.

Do NOT write a custom word-LCS — the global convention is to prefer
battle-tested libraries over rolling your own diff. `diff-match-patch` is the
only credible alternative; it is rejected here because its output is char-level
ops that you would have to re-tokenize into words yourself, and it has no first-
party word mode — more custom glue for no gain.

## Commands you will need

| Purpose      | Command                                          | Expected on success            |
|--------------|--------------------------------------------------|--------------------------------|
| Install dep  | `bun add diff`                                   | exit 0; `diff` in package.json `dependencies` |
| Install      | `bun install`                                    | exit 0                         |
| Typecheck    | `bun run typecheck`                              | exit 0, no errors              |
| Lint/format  | `bun run biome`                                  | exit 0, no errors              |
| Tests        | `bun run test`                                   | all pass (vitest run + bun spike test) |
| Targeted test| `bunx vitest run lib/history/diff.test.ts`       | all pass                       |
| Build        | `bun run build`                                  | exit 0                         |
| Dev (manual) | `bun run dev`                                    | studio loads; history panel opens |

Note: `bun run biome` runs `biome check .` — it reports lint AND format issues.
If it flags formatting, run `bunx biome check --write <files>` then re-run.

## Suggested executor toolkit

- After editing the React panel, if a `vercel-react-best-practices` skill is
  available, use it to sanity-check the new `useMemo` deps and render branches.
- jsdiff docs (Change object shape, `diffWordsWithSpace`):
  https://github.com/kpdecker/jsdiff/blob/master/README.md

## Scope

**In scope** (the only files you should modify):

- `lib/history/diff.ts` — add word-level diff functions; keep `diffLines`/`nodeLabel`.
- `lib/history/diff.test.ts` — **create**; new tests for the new functions.
- `lib/studio/use-studio-settings.ts` — add `diffGranularity` + `diffLayout`
  settings + their setters/togglers.
- `components/history/history-panel.tsx` — fetch both texts, render word/line
  inline/side-by-side honoring the settings; let undo-tree rows be compare-selectable.

**Out of scope** (do NOT touch, even though they look related):

- `convex/versions.ts`, `convex/docNodes.ts` — restore + materialize are server
  write/read paths; this feature is read-only client UI. Changing them risks the
  additive-restore guarantee.
- `lib/history/use-document-history.ts` — `materializeAt` already gives you both
  texts. No change.
- `lib/history/materialize.ts` — pure helpers, unaffected.
- Any change to restore behavior or to the docNodes/versions data model.

## Git workflow

- Branch: `advisor/001-word-level-version-diff` (create from `main`).
- Commit per logical unit; conventional-commit style, NO AI attribution / no
  Co-Authored-By lines, author = the repo user only. Example from `git log`:
  `feat: add switchable calm color themes`. Suggested commits:
  1. `chore: add diff (jsdiff) as a direct dependency`
  2. `feat: add word-level diff to history compare`
  3. `feat: add diff granularity + layout toggles to studio settings`
  4. `feat: compare two versions with word-level inline/side-by-side diff`
  5. `test: cover word-level diff`
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add the `diff` library as a direct dependency

```
bun add diff
```

Confirm `"diff"` now appears under `dependencies` in `package.json` (it was only
transitive before). No `@types/diff` needed — `diff` ships its own types.

**Verify**: `bun pm ls 2>/dev/null | grep -i '^.*diff@' ; grep '"diff"' package.json`
→ `diff` listed under `dependencies`. Also `bun run typecheck` → exit 0.

### Step 2: Add word-level diff to `lib/history/diff.ts`

Keep everything currently in the file. ADD a token-diff API that the panel
renders as inline ins/del runs. Target shape:

```ts
import { diffLines as jsDiffLines, diffWordsWithSpace } from "diff";

/** One inline run in a token diff: added / deleted / unchanged text. */
export type DiffRun = { type: "add" | "del" | "same"; text: string };

/** Diff granularity the user can choose (mirrors a studio setting). */
export type DiffGranularity = "word" | "line";

/**
 * Token-level diff of two canonical-Markdown strings, producing inline
 * ins/del/same runs (blueprint 08 §5 — diff the source, not rendered HTML).
 * "word" uses jsdiff diffWordsWithSpace (whitespace preserved → prose-friendly);
 * "line" uses jsdiff diffLines. Read-only, pure.
 */
export function diffRuns(
	a: string,
	b: string,
	granularity: DiffGranularity = "word",
): DiffRun[] {
	const changes =
		granularity === "word"
			? diffWordsWithSpace(a, b)
			: jsDiffLines(a, b);
	return changes.map((c) => ({
		type: c.added ? "add" : c.removed ? "del" : "same",
		text: c.value,
	}));
}
```

Notes:
- `diffWordsWithSpace` and `diffLines` are both named exports of `diff`. Alias
  the imported `diffLines` to `jsDiffLines` so it does not collide with this
  file's existing `diffLines` export (which stays).
- A jsdiff Change has `value: string`, `added?: boolean`, `removed?: boolean`.
  When both `added` and `removed` are false/undefined it is common text → `"same"`.
- Do NOT delete the existing `diffLines`/`DiffLine` (the panel may still offer a
  legacy line view, and other callers/tests reference them). `diffRuns` with
  `granularity: "line"` is the new line path the panel uses.

**Verify**: `bun run typecheck` → exit 0. `bun run biome` → exit 0.

### Step 3: Add `diffGranularity` and `diffLayout` settings

In `lib/studio/use-studio-settings.ts`, extend the settings to remember the two
A/B choices (per the "user toggles over fixed picks" constraint). Make all four
edits consistent — the type, the defaults, the `loadSettings` validation, the
`StudioSettingsApi` type, the setters in the hook, and the returned object.

1. Add types near the top:

```ts
/** How the history compare diff splits text. */
export type DiffGranularity = "word" | "line";
/** How the history compare diff is laid out. */
export type DiffLayout = "inline" | "side-by-side";
```

2. Add fields to `StudioSettings`:

```ts
	/** Granularity of the history compare diff (word = prose standard). */
	diffGranularity: DiffGranularity;
	/** Layout of the history compare diff. */
	diffLayout: DiffLayout;
```

3. Add defaults to `DEFAULTS`:

```ts
	diffGranularity: "word",
	diffLayout: "inline",
```

4. In `loadSettings()`, validate them like the existing fields (mirror the
   `readingFont` ternary pattern at `:68`):

```ts
	diffGranularity: parsed.diffGranularity === "line" ? "line" : "word",
	diffLayout: parsed.diffLayout === "side-by-side" ? "side-by-side" : "inline",
```

5. Add to `StudioSettingsApi`:

```ts
	setDiffGranularity: (g: DiffGranularity) => void;
	toggleDiffGranularity: () => void;
	setDiffLayout: (l: DiffLayout) => void;
	toggleDiffLayout: () => void;
```

6. In the hook body, add `useCallback` setters mirroring `toggleReadingFont`
   (`:132-137`):

```ts
	const setDiffGranularity = useCallback((diffGranularity: DiffGranularity) => {
		setSettings((s) => ({ ...s, diffGranularity }));
	}, []);
	const toggleDiffGranularity = useCallback(() => {
		setSettings((s) => ({
			...s,
			diffGranularity: s.diffGranularity === "word" ? "line" : "word",
		}));
	}, []);
	const setDiffLayout = useCallback((diffLayout: DiffLayout) => {
		setSettings((s) => ({ ...s, diffLayout }));
	}, []);
	const toggleDiffLayout = useCallback(() => {
		setSettings((s) => ({
			...s,
			diffLayout: s.diffLayout === "inline" ? "side-by-side" : "inline",
		}));
	}, []);
```

7. Add all four to the returned object at the bottom of the hook (next to
   `toggleReadingFont`, etc.).

**Verify**: `bun run typecheck` → exit 0. `bun run biome` → exit 0.

### Step 4: Render the word-level diff in the history panel

Edit `components/history/history-panel.tsx`:

1. Imports: replace `import { diffLines, nodeLabel } from "@/lib/history/diff";`
   with `import { diffRuns, nodeLabel } from "@/lib/history/diff";` and add
   `import { useStudioSettingsContext } from "@/lib/studio/settings-context";`.
   (Confirm `HistoryPanel` is rendered inside `<StudioSettingsProvider>` — it is,
   `components/studio-shell.tsx:656` is inside the provider that closes at
   `:672`. If that is no longer true, see STOP conditions.)

2. Inside the component, read settings:
   `const { diffGranularity, diffLayout } = useStudioSettingsContext();`

3. Replace `compareDiff` (`:132-138`). For inline, compute runs once; for
   side-by-side, you need the two raw materialized texts too. Keep both:

```tsx
const compareTexts = useMemo(() => {
	if (!compare || !history) return null;
	const a = history.materializeAt(compare[0]);
	const b = history.materializeAt(compare[1]);
	if (a == null || b == null) return null;
	return { a, b };
}, [compare, history]);

const compareDiff = useMemo(() => {
	if (!compareTexts) return null;
	return diffRuns(compareTexts.a, compareTexts.b, diffGranularity);
}, [compareTexts, diffGranularity]);
```

4. Make undo-tree rows compare-selectable too (the feature is "compare two
   versions/nodes"). The tree row button at `:229-271` currently only navigates
   on click. Do NOT break navigation. Add a small "Compare" affordance per tree
   row that calls the existing `setCompareSelection(node.nodeId)` (the same
   handler used by the versions list at `:330`). Simplest: append a tiny inline
   button after the time span inside the row's `<li>`, OUTSIDE the navigate
   `<button>` (nested interactive buttons are invalid). Example:

```tsx
<li key={node.nodeId} className="flex items-center">
	<button type="button" /* existing navigate button, unchanged */>
		{/* ...dot, label, tags, time... */}
	</button>
	<button
		type="button"
		onClick={() => setCompareSelection(node.nodeId)}
		className={cn(
			"shrink-0 px-1.5 py-1 text-[0.625rem] uppercase tracking-wide transition-colors",
			compareSel.includes(node.nodeId)
				? "text-[var(--color-accent)]"
				: "text-[var(--color-ink-tertiary)] hover:text-[var(--color-ink-primary)]",
		)}
		aria-label="Select for compare"
	>
		{compareSel.includes(node.nodeId) ? "✓" : "⇄"}
	</button>
</li>
```

   Keep the existing per-version "Compare" button in the versions list as-is.

5. Add small toggle controls for granularity + layout, shown only while a
   compare is active (so they sit next to the diff). Place them in a thin bar
   just above the diff render. Use plain buttons styled like the existing
   view-switch buttons (`:185-210` pattern) and the toggle handlers from Step 3:

```tsx
{compareDiff ? (
	<div className="shrink-0 border-t border-[var(--color-line)]">
		<div className="flex items-center gap-[var(--space-2)] px-[var(--space-3)] py-1.5 text-[0.6875rem] text-[var(--color-ink-tertiary)]">
			<button type="button" onClick={toggleDiffGranularity}
				className="hover:text-[var(--color-ink-primary)]">
				{diffGranularity === "word" ? "Word" : "Line"} diff
			</button>
			<span aria-hidden>·</span>
			<button type="button" onClick={toggleDiffLayout}
				className="hover:text-[var(--color-ink-primary)]">
				{diffLayout === "inline" ? "Inline" : "Side by side"}
			</button>
		</div>
		{/* diff body — see 6 */}
	</div>
) : preview != null ? ( /* unchanged preview branch */ ) : null}
```

   (Pull `toggleDiffGranularity`, `toggleDiffLayout` from
   `useStudioSettingsContext()` in step 2's destructure.)

6. The diff body. INLINE layout — render runs as flowing inline spans (added =
   success token, deleted = danger token + strikethrough, same = muted),
   wrapping in one container. Use `whitespace-pre-wrap` so jsdiff's preserved
   spaces/newlines render correctly:

```tsx
<div className="max-h-[40%] overflow-y-auto bg-[var(--color-bg-app)] px-[var(--space-3)] py-[var(--space-2)] font-[family-name:var(--font-mono)] text-[0.75rem] leading-relaxed">
	{diffLayout === "inline" ? (
		<p className="whitespace-pre-wrap">
			{compareDiff.map((run, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: diff is positional
					key={i}
					className={cn(
						run.type === "add" &&
							"bg-[oklch(0.8_0.09_150/0.12)] text-[var(--color-success)]",
						run.type === "del" &&
							"bg-[oklch(0.7_0.14_25/0.12)] text-[var(--color-danger)] line-through",
						run.type === "same" && "text-[var(--color-ink-tertiary)]",
					)}
				>
					{run.text}
				</span>
			))}
		</p>
	) : (
		<div className="grid grid-cols-2 gap-[var(--space-3)]">
			<div className="whitespace-pre-wrap">
				{compareDiff
					.filter((r) => r.type !== "add")
					.map((run, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: diff is positional
							key={i}
							className={cn(
								run.type === "del" &&
									"bg-[oklch(0.7_0.14_25/0.12)] text-[var(--color-danger)]",
								run.type === "same" && "text-[var(--color-ink-tertiary)]",
							)}
						>
							{run.text}
						</span>
					))}
			</div>
			<div className="whitespace-pre-wrap">
				{compareDiff
					.filter((r) => r.type !== "del")
					.map((run, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: diff is positional
							key={i}
							className={cn(
								run.type === "add" &&
									"bg-[oklch(0.8_0.09_150/0.12)] text-[var(--color-success)]",
								run.type === "same" && "text-[var(--color-ink-tertiary)]",
							)}
						>
							{run.text}
						</span>
					))}
			</div>
		</div>
	)}
</div>
```

   The side-by-side columns reconstruct the old text (same + del) and the new
   text (same + add) from the same run list — no second diff call needed. The
   inline `+ `/`- ` prefixes from the old line view are dropped; color +
   strikethrough now carry the meaning, which is the prose-diff convention.

7. Remove the now-unused old inline-prefix line render (the `compareDiff.map`
   block at `:387-403`) — it is replaced by the above. Ensure `diffLines` is no
   longer imported here (you import `diffRuns` instead). `diffLines` REMAINS
   exported from `lib/history/diff.ts` for tests/legacy; just not used by the panel.

**Verify**: `bun run typecheck` → exit 0. `bun run biome` → exit 0.
`bun run build` → exit 0.

### Step 5: Write tests for the word-level diff

Create `lib/history/diff.test.ts` (see Test plan). Model structure on
`lib/history/history.test.ts` (plain vitest, pure-function, table-driven).

**Verify**: `bunx vitest run lib/history/diff.test.ts` → all pass.

### Step 6: Full gate

Run the whole gate.

**Verify**: `bun run typecheck` → 0; `bun run biome` → 0; `bun run test` → all
pass; `bun run build` → 0.

## Test plan

Create `lib/history/diff.test.ts`. Import from `./diff`. Cover:

- **Word diff isolates a single changed word** (the core bug this fixes):
  `diffRuns("the quick brown fox", "the slow brown fox", "word")` →
  the runs contain exactly one `del` whose text includes `quick` and one `add`
  whose text includes `slow`, and the runs for `the `/` brown fox` are `same`.
  Assert no `same` run was wrongly reported as add/del. Concretely:
  ```ts
  const runs = diffRuns("the quick brown fox", "the slow brown fox", "word");
  expect(runs.some((r) => r.type === "del" && r.text.includes("quick"))).toBe(true);
  expect(runs.some((r) => r.type === "add" && r.text.includes("slow"))).toBe(true);
  expect(runs.filter((r) => r.type === "del").length).toBe(1);
  expect(runs.filter((r) => r.type === "add").length).toBe(1);
  ```
- **Reflow regression** (the line diff's failure, now fixed): a paragraph that
  re-wraps after a one-word insertion. Build `a` and `b` as multi-word strings
  differing by one inserted word; assert the word diff yields a single `add` run
  (not a whole-paragraph del+add). Contrast: optionally assert that
  `diffRuns(a, b, "line")` (or the legacy `diffLines(a, b)`) reports far more
  changed text, to document why word granularity is better.
- **Reconstruction invariant** (load-bearing for side-by-side correctness):
  for several `(a, b)` pairs, concatenating the non-`add` run texts rebuilds `a`,
  and concatenating the non-`del` run texts rebuilds `b`:
  ```ts
  const rebuildA = runs.filter((r) => r.type !== "add").map((r) => r.text).join("");
  const rebuildB = runs.filter((r) => r.type !== "del").map((r) => r.text).join("");
  expect(rebuildA).toBe(a);
  expect(rebuildB).toBe(b);
  ```
  Use cases: `["", "hello"]`, `["hello world", "hello brave world"]`,
  `["# Title\n\nBody.\n", "# Title\n\nBody edited.\n"]`, `["keep this", "keep"]`
  (these mirror the patch-codec cases at `history.test.ts:16-21`).
- **Identical inputs** → every run is `same` and there are no `add`/`del` runs:
  `diffRuns("same text", "same text", "word")`.
- **Empty inputs** → `diffRuns("", "", "word")` returns `[]` or all-`same` with
  no add/del; `diffRuns("", "new", "word")` has only `add` (+ possibly `same`
  empty); assert `rebuildB === "new"`, `rebuildA === ""`.
- **Line granularity still works**: `diffRuns(a, b, "line")` returns runs whose
  reconstruction invariant also holds, proving the line path is intact.
- (Optional) **Legacy `diffLines` unchanged**: one assertion that the original
  `diffLines("a\nb", "a\nc")` still returns `DiffLine[]` with a `same` "a" — to
  guard against accidental deletion.

Verification: `bunx vitest run lib/history/diff.test.ts` → all pass (≥6 new
tests). Then `bun run test` → whole suite green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep '"diff"' package.json` shows `diff` under `dependencies`.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run biome` exits 0.
- [ ] `bunx vitest run lib/history/diff.test.ts` passes; `lib/history/diff.test.ts`
      exists with ≥6 tests including the single-word-change and reconstruction cases.
- [ ] `bun run test` exits 0 (vitest + bun spike test).
- [ ] `bun run build` exits 0.
- [ ] `grep -n "diffLines" components/history/history-panel.tsx` returns NO
      matches (panel now uses `diffRuns`).
- [ ] `grep -n "export function diffRuns" lib/history/diff.ts` returns a match;
      `grep -n "export function diffLines" lib/history/diff.ts` STILL returns a
      match (legacy kept).
- [ ] `grep -n "diffGranularity\|diffLayout" lib/studio/use-studio-settings.ts`
      shows both fields, both defaults, both validators, both togglers.
- [ ] `git status` shows ONLY these modified/created: `package.json`, `bun.lock`,
      `lib/history/diff.ts`, `lib/history/diff.test.ts` (new),
      `lib/studio/use-studio-settings.ts`, `components/history/history-panel.tsx`.
      No other source files changed.
- [ ] `plans/README.md` status row for plan 001 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- **The diff is no longer line-based.** If `lib/history/diff.ts` no longer
  contains a `diffLines` LCS over `a.split("\n")` (the excerpt in "Current
  state" doesn't match) — someone already changed the granularity. Re-evaluate
  before editing.
- **The panel's compare rendering moved.** If
  `components/history/history-panel.tsx` no longer computes `compareDiff` via
  `history.materializeAt(...)` / `diffLines(...)` near the documented lines, or
  the bottom `compareDiff ? ... : preview != null ? ...` render block is gone —
  the UI was refactored; the line numbers in this plan are stale.
- **HistoryPanel is no longer inside `StudioSettingsProvider`.** If
  `useStudioSettingsContext()` throws at runtime ("must be used within a
  StudioSettingsProvider"), the panel is rendered outside the provider. Do NOT
  hoist the provider; instead fall back to local `useState` for the two toggles
  (ephemeral, not persisted) and report this so the operator can decide on
  persistence.
- **`bun add diff` changes a lockfile in an unexpected way** (e.g. it would
  bump major versions of unrelated packages) — stop and report the lockfile diff.
- Any verification command fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (e.g. `convex/*`,
  `use-document-history.ts`).

## Maintenance notes

For the human/agent who owns this after it lands:

- **Why a remembered setting, not a prop:** the two toggles live in
  `useStudioSettings` (localStorage) so the choice persists across sessions,
  matching every other studio knob. If a future redesign moves diff to a
  separate "Compare" modal, the settings stay valid — just read them there.
- **Side-by-side reconstruction depends on the run invariant.** The columns are
  built by filtering runs (old = non-add, new = non-del). The test
  "reconstruction invariant" guards this. If the diff library is ever swapped,
  re-run that test first — a library whose `value` doesn't concatenate back to
  the inputs would silently corrupt the side-by-side view.
- **`diffWordsWithSpace` vs `diffWords`:** we chose `diffWordsWithSpace` because
  it keeps whitespace/newlines as tokens, so `whitespace-pre-wrap` renders prose
  faithfully and the reconstruction invariant holds exactly. `diffWords`
  collapses whitespace and would break exact reconstruction. Do not switch
  without updating the tests.
- **Reviewer should scrutinize:** (1) the tree-row compare button is a SIBLING
  of the navigate button, not nested (nested `<button>` is invalid HTML and
  breaks click handling); (2) navigation on tree rows still works after the
  change; (3) `diffLines`/`DiffLine` remain exported (legacy/tests).
- **Deferred out of scope:** exposing the two toggles in the command palette /
  settings sheet (only the in-panel toggle bar is built here). Add later if the
  user wants palette access. Also deferred: clause/sentence granularity — jsdiff
  has `diffSentences` if a third granularity is ever wanted; the `DiffGranularity`
  union and `diffRuns` switch are structured to extend.
```
