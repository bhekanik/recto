# Plan 002: Add per-document & daily word goals, session stats, and a cross-device writing streak

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat a25c506..HEAD -- components/status-bar.tsx components/studio-shell.tsx lib/studio/use-studio-settings.ts lib/studio/settings-context.tsx convex/schema.ts convex/documents.ts convex/workspaces.ts lib/markdown/count-words.ts lib/markdown/index.ts lib/keyboard/actions.ts lib/sync/use-document-sync.ts lib/workspace/workspace-context.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

Recto shows a live word count but offers no *target*. The product overview
explicitly promises this: §5a says the newsletter writer keeps "the **word
count** … visible the whole time so you can hit your length target" — yet there
is no goal to hit. Ulysses' goals and Scrivener's targets are those tools' most
loved features. This plan adds a per-document word goal, an optional daily goal,
session stats, and a cross-device writing streak — all opt-in and *quiet*: a
calm ring/bar in the status bar, no modal nags, no break-shaming. The streak
must survive a device switch (Recto's "resume anywhere" promise, §6), so daily
totals persist to Convex; goal *preferences* stay per-device in localStorage.

## Current state

The facts the executor needs, inlined. Read each cited file first-hand before
editing — line numbers are from commit `a25c506`.

### Vocabulary & quality constraints this plan must honor

From `docs/blueprint/01-product-overview.md` — quote and obey:

- §5a (line 122): "The **word count** sits visible the whole time so you can hit
  your length target." → the goal UI lives *with* the word count, in the status bar.
- §6 quality bar (line 155): "Premium and bespoke … The tool disappears: minimal
  chrome, the writing surface dominates. **Not a templated default.**" → no loud
  banners, no progress modals; a single small ring/bar that matches the existing
  status-bar density.
- §6 principle 5 (line 164): "**The tool disappears.** Minimal chrome … not
  persistent toolbars." → goals are off by default and configured via the command
  palette / a quiet popover, not a permanent panel.
- §6 principle 7 (line 166): "Minimalism removes chrome, **not** safety nets." →
  goals never block typing or saving; they are display-only.
- §2.1 / §8: single-user, dark-only, desktop-first (responsive ok). All new
  Convex rows are scoped to the one owner via `userId`. **No light theme, no
  multi-user concepts.**

The user's standing preference (project memory `recto-prefer-user-toggles.md`):
for any genuine A/B design fork, **build a switchable setting — do not hard-pick.**
This plan exposes two such toggles (ring-vs-bar, goal scope) as settings.

### Existing word counter — REUSE, do not reimplement

`lib/markdown/count-words.ts` (whole file, 45 lines). Exports:
- `countWords(markdownOrMdast: string | Root): number` — canonical counter used everywhere.
- `countWordsFromPlainText(text: string): number` — splits on `/\s+/`.

Re-exported from the barrel `lib/markdown/index.ts:1`:
```ts
export { countWords } from "./count-words";
```
`countWordsFromPlainText` is **not** currently exported from the barrel. The
session-words delta (current count minus session-start count) needs only the
already-available `wordCount` numbers, so **you do not need a new counter**. The
`Intl.Segmenter` mention in the feature brief is optional polish — the existing
`countWords` is the canonical source of truth for the document word count and the
goal/session math is pure arithmetic on those integers. **Do not change
`count-words.ts`.** (If you want graphemes-aware counting later, that is a
separate plan; adding it here would diverge the count shown by the goal from the
count shown by the status bar, which must stay identical.)

### Where word count + toggles render today

`components/status-bar.tsx`. The props type (lines 36–56):
```ts
type StatusBarProps = {
	wordCount: number;
	syncStatus: SyncStatus;
	mode: Mode;
	vimSubMode?: VimSubMode;
	onModeChange: (mode: Mode) => void;
	theme: Theme;
	onCycleTheme: () => void;
	readingFont: ReadingFont;
	onToggleFont: () => void;
	readingScale: number;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onZoomReset: () => void;
	canZoomIn: boolean;
	canZoomOut: boolean;
	spellcheck: boolean;
	onToggleSpellcheck: () => void;
	zen: boolean;
	onToggleZen: () => void;
};
```
The word count renders near the end (lines 282–284):
```tsx
<span className="hidden cursor-default text-right tabular-nums text-[var(--color-ink-tertiary)] min-[360px]:inline-block sm:min-w-[4.5rem]">
	{formatWordCount(wordCount)}
</span>
```
`formatWordCount` (lines 58–60) does `${count.toLocaleString()} word(s)`.

The toggle pattern to MATCH (theme cycle button, lines 180–192): a `<button>`
with `title`, `aria-label`, the shared `iconBtn` class string (line 109–110) or
the inline status-bar button class, lucide icon at `size-[14px]`/`size-[15px]`,
and OKLCH CSS-var colors only (`var(--color-ink-tertiary)`, `var(--color-accent)`,
`var(--color-bg-hover)`). **No raw hex, no one-off styles** — every color is a
token from `app/globals.css`. Secondary controls are wrapped in
`<div className="hidden items-center gap-[var(--space-2)] sm:flex">` (line 196) so
they fold away on phones; put the goal control inside the always-visible cluster
(it is a primary, alongside word count) but keep it compact.

### Where the status bar is wired

`components/studio-shell.tsx`, lines 588–632: `<StatusBar … />` is rendered with
props sourced from `settings` (a `useStudioSettings()` api) and `activeSync` (a
`DocumentSyncState`). Key facts:
- `activeSync.wordCount` (line 591) — the live document word count.
- `activeDocId` (line 180) — `Id<"documents"> | null`, the active document.
- `settings` (line 82) — `useStudioSettings()` return; the `StudioSettingsProvider`
  wraps the whole shell (line 491).
- The `dispatch(id: ActionId)` switch (lines 247–380) routes every command-palette
  / chord action; new actions are added as `case` arms here.

### Settings / localStorage pattern (per-device prefs live here)

`lib/studio/use-studio-settings.ts`. The shape (lines 21–32), defaults (38–44),
storage key (46): `"recto:studio-settings"`. `loadSettings()` (57–85) validates
each field defensively. The api type `StudioSettingsApi` (87–97) extends the
state with setter callbacks. **Add new per-device goal-preference fields here**,
following the exact same pattern: a typed field, a default, a defensive load
branch, and a `useCallback` setter returned from the hook.

`lib/studio/settings-context.tsx` exposes `useStudioSettingsContext()` for deep
reads — not needed for the status bar (which gets settings via props) but
available if a goal popover needs them.

### Convex: schema, auth, and the upsert exemplar

`convex/schema.ts` (whole file, 52 lines). Tables use
`defineTable({...}).index("by_user", ["userId"])`. Add the new table here.

`convex/documents.ts` lines 11–33 — copy this auth shape EXACTLY:
```ts
export async function requireUserId(
	ctx: QueryCtx | MutationCtx,
): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error("Unauthenticated");
	}
	return identity.subject;
}
```
`requireUserId` is already `export`ed from `convex/documents.ts:12`, so import it
in the new file rather than redefining it (note: `convex/workspaces.ts:12` keeps
a *private, non-exported* copy — that is the older pattern; prefer importing the
exported one from `documents.ts`, as `convex/versions.ts:4` does).

`convex/workspaces.ts` lines 44–82 — the per-user singleton upsert exemplar to
model the stats mutation on (query existing by `by_user`, `patch` if found else
`insert`):
```ts
const existing = await ctx.db
	.query("workspaces")
	.withIndex("by_user", (q) => q.eq("userId", userId))
	.unique();
if (existing) {
	await ctx.db.patch(existing._id, { ... });
	return { updatedAt };
}
await ctx.db.insert("workspaces", { userId, ... });
```

### Client sync / debounce to piggyback on (do NOT write on every keystroke)

`lib/sync/use-document-sync.ts` debounces document saves at `DEBOUNCE_MS = 500`
(line 18) with a `maxWait: 5000` (line 184). `lib/workspace/workspace-context.tsx`
exposes per-document sync state `DocumentSyncState` (lines 35–46) including
`wordCount` and `markdown`. The streak/daily-total write must be **low-frequency**
— a separate debounce (recommend ~30s) keyed off the same change signal, NOT a
write per save. See Step 5 for the exact mechanism.

### Test patterns

- Pure-logic Vitest: `lib/workspace/operations.test.ts` and
  `lib/history/history.test.ts` — `import { describe, expect, it } from "vitest";`,
  arrange/act/assert, no mocks for pure functions. Vitest config
  (`vitest.config.ts`) includes `lib/**/*.test.ts` and runs under `happy-dom`.
- Convex function tests use `convex-test` + Bun: see
  `spikes/undo-tree/tests/convex.bun.test.ts` (`import { convexTest } from
  "convex-test"`, pass `schema` + a `modules` map, then `t.mutation(...)` /
  `t.query(...)`). The root `test` script (`package.json:12`) runs
  `vitest run && bun test spikes/undo-tree/tests/convex.bun.test.ts`.
  **Note**: the existing convex test lives under `spikes/`, not `convex/`. To keep
  the new Convex test in the default test run without changing `package.json`,
  put the *streak math* in a pure module under `lib/` and unit-test that with
  Vitest (Step 6). A full `convex-test` integration test for the mutation is
  **optional** and, if added, must be wired into the `test` script — which is an
  out-of-scope `package.json` edit, so prefer the pure-module approach.

## Commands you will need

| Purpose       | Command                                   | Expected on success            |
|---------------|-------------------------------------------|--------------------------------|
| Install       | `bun install`                             | exit 0                         |
| Typecheck     | `bun run typecheck`                       | exit 0, no errors              |
| Lint/format   | `bun run biome`                           | exit 0 (no diagnostics)        |
| Tests         | `bun run test`                            | all pass, incl. new tests      |
| Single test   | `bunx vitest run lib/stats/streak.test.ts`| new tests pass                 |
| Build         | `bun run build`                           | exit 0                         |
| Convex codegen| `bun run convex:codegen`                  | regenerates `convex/_generated`|
| Dev (manual)  | `bun run dev`                             | Next + Convex start            |

Run `bun run convex:codegen` after editing `convex/schema.ts` so
`convex/_generated/api` and `dataModel` types pick up the new table/functions
before you typecheck.

## Suggested executor toolkit

- shadcn primitives are added via `bunx shadcn add <name>`. The goal-config UI
  should reuse an existing primitive from `components/ui/` (e.g. a popover or the
  command palette). Run `ls components/ui/` first; only `bunx shadcn add popover`
  if no suitable primitive exists. Do NOT hand-roll a styled `<div>` overlay.
- If `vercel-react-best-practices` skill is available, consult it before adding
  the debounced effect in Step 5 (cleanup, stable refs).
- The progress ring is a small inline SVG (`<circle>` with `stroke-dasharray`);
  this is simpler and lighter than a charting lib for a single ring — justified
  custom code. Color it with `var(--color-accent)` / `var(--color-line)` only.

## Scope

**In scope** (the only files you should modify or create):
- `convex/schema.ts` — add `writingStats` table (modify).
- `convex/writingStats.ts` — new query + mutation file (create).
- `lib/stats/streak.ts` — pure streak/goal math (create).
- `lib/stats/streak.test.ts` — Vitest unit tests (create).
- `lib/studio/use-studio-settings.ts` — add goal-preference fields + setters (modify).
- `components/status-bar.tsx` — render the goal ring/bar + session/streak readout (modify).
- `components/studio-shell.tsx` — wire new props, the daily-total flush, and any goal-config command (modify).
- `lib/keyboard/actions.ts` — add a "Set word goal…" action (modify).
- `components/goal-popover.tsx` — small popover to enter the goal target (create; only if no existing primitive fits — see Step 4).
- `lib/markdown/index.ts` — only if you must export `countWordsFromPlainText` (you should NOT need to; see Current state).

**Out of scope** (do NOT touch, even though they look related):
- `lib/markdown/count-words.ts` — the canonical counter; changing it would diverge
  the goal count from the status-bar count.
- `lib/sync/use-document-sync.ts` — the document save path. Add a *separate* flush;
  do not entangle stats writes with `updateMarkdown`.
- `convex/documents.ts`, `convex/workspaces.ts`, `convex/crons.ts`, `convex/retention.ts`
  — read them for patterns, but do not modify. (Daily goal "reset at local midnight"
  is purely a client-side date comparison; it needs **no cron** — do not add one.)
- `package.json` test script — do not rewire it (keeps the streak test in `lib/`).
- `app/globals.css` — the existing OKLCH tokens (`--color-accent`, `--color-line`,
  `--color-ink-*`, `--color-bg-hover`, `--color-success`, `--color-warning`) are
  sufficient. Do not add new tokens unless a STOP-condition review approves it.

## Git workflow

- Branch: `advisor/002-writing-goals-and-streaks`
- Commit per logical unit (schema+convex; settings; status-bar UI; shell wiring;
  tests). Conventional commits, NO AI attribution, author = the repo user. Example
  from `git log`: `feat: add switchable calm color themes`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add the `writingStats` Convex table

In `convex/schema.ts`, add a table inside the `defineSchema({...})` object
(after `versions`). Store one row per user per local calendar day:

```ts
// Per-user daily writing aggregates (local-date keyed) — powers the streak and
// the optional daily goal. Single-user; scoped by userId. (plan 002)
writingStats: defineTable({
	userId: v.string(),
	date: v.string(), // local calendar date "YYYY-MM-DD", computed client-side
	words: v.number(), // max words-written observed for this day (monotonic; see writingStats.record)
	updatedAt: v.number(),
})
	.index("by_user", ["userId"])
	.index("by_user_date", ["userId", "date"]),
```

Then run `bun run convex:codegen`.

**Verify**: `bun run convex:codegen` → exits 0 and `convex/_generated/dataModel.d.ts`
mentions `writingStats` (`grep -l writingStats convex/_generated/dataModel.d.ts`).

### Step 2: Add Convex query + mutation for daily stats

Create `convex/writingStats.ts`. Import the exported auth helper from
`documents.ts` (do not redefine it). Two functions:

- `record` (mutation): args `{ date: v.string(), words: v.number() }`. Upsert the
  row for `(userId, date)` via the `by_user_date` index (model on
  `workspaces.save` lines 55–78). **Make `words` monotonic per day**: if a row
  exists, only patch when `args.words > existing.words` (a later flush with a
  *lower* count — e.g. user deleted text — must not shrink the day's recorded
  total; "words written" for a streak is a high-water mark, not the live count).
  Always update `updatedAt`.
- `list` (query): args `{}`. Return all rows for the user (`by_user`), each as
  `{ date, words }`. The client computes the streak and "today's words" from this
  list — keep the server dumb (no date math server-side; the server cannot know
  the user's timezone). Cap is not needed (one row/day, single user).

Copy the `requireUserId` usage and the `query`/`mutation` wrappers exactly as in
`convex/documents.ts`. Add a short doc comment on each function.

**Verify**: `bun run convex:codegen && bun run typecheck` → exit 0; `grep -n
"export const record\|export const list" convex/writingStats.ts` shows both.

### Step 3: Add pure streak/goal math in `lib/stats/streak.ts`

Create `lib/stats/streak.ts` with pure, dependency-free functions (no React, no
Convex). These are the *only* place streak/goal logic lives — the UI calls them.

Required exports (signatures are load-bearing — match them so the tests in Step 6
compile):

```ts
export type DailyStat = { date: string; words: number }; // date = "YYYY-MM-DD" local

/** Local "YYYY-MM-DD" for a Date (default: now). Uses local time, not UTC. */
export function localDateKey(d?: Date): string;

/**
 * Current streak length counting back from `today`, counting ONLY days the user
 * wrote (words > 0). Off-days do NOT break the streak ("count only days you
 * write"): the streak is the number of distinct written-days reaching back with
 * no gap longer than... — see semantics below. Returns an integer >= 0.
 */
export function currentStreak(stats: DailyStat[], today: string): number;

export type GoalKind = "at-least" | "about" | "at-most";

export type GoalProgress = {
	ratio: number; // clamped 0..1 for the ring/bar fill
	met: boolean; // goal satisfied?
	remaining: number; // words to go (>=0); 0 once met
};

/** Progress of `words` toward `target` under the given goal kind. */
export function goalProgress(
	words: number,
	target: number,
	kind: GoalKind,
): GoalProgress;
```

**Streak semantics — decide and document in a top-of-file comment, then test it
(Step 6).** The feature brief says "count only days you write — off-days don't
break-shame." The cleanest honest reading, and the one to implement:

- A streak is consecutive *written days with no skipped calendar day between
  them*, counting back from today, **except today itself may be unwritten**
  (you haven't necessarily written yet today — don't reset the streak to 0 at
  midnight before the user opens the app). Concretely:
  - Build a `Set` of dates with `words > 0`.
  - Start cursor at `today`. If today is written, count it and move cursor back
    one day. If today is *not* written, do not count it but still allow the
    streak to continue from yesterday (start cursor at yesterday).
  - Walk backwards: while the cursor date is in the written set, increment and
    step back one calendar day. Stop at the first unwritten day.
- This means: writing yesterday but not yet today → streak includes yesterday
  (no shame for not having written *yet* today). Skipping a full day (an unwritten
  day with written days on both sides in the past) ends the backward walk there.

Use date arithmetic via `Date` + the `localDateKey` helper (construct
`new Date(year, month-1, day)` from the parsed key and subtract one day) — do NOT
pull in a date library; this is a few lines and `Intl`/`Date` suffice (justified:
no library needed). Guard against duplicate dates in input by deduping into the Set.

`goalProgress`:
- `at-least`/`about`: `ratio = clamp(words / target, 0, 1)`; `met = words >= target`
  for `at-least`; for `about` treat met as within ±10% of target (document the
  band). `remaining = max(target - words, 0)`.
- `at-most`: `ratio = clamp(words / target, 0, 1)`; `met = words <= target`;
  `remaining` = `max(target - words, 0)` (room left). Once over target, `met=false`,
  `ratio=1`.
- `target <= 0` → return `{ ratio: 0, met: false, remaining: 0 }` (no goal set).

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Add goal-preference fields to studio settings

In `lib/studio/use-studio-settings.ts`, extend `StudioSettings` (lines 21–32),
`DEFAULTS` (38–44), `loadSettings` (57–85), `StudioSettingsApi` (87–97), and the
hook return (165–176). Add these PER-DEVICE preference fields (goal targets are a
device-local preference, not synced — see Decisions):

- `wordGoalTarget: number` (default `0` = no goal)
- `wordGoalKind: GoalKind` (`"at-least" | "about" | "at-most"`; default `"at-least"`)
  — import `GoalKind` from `lib/stats/streak.ts`.
- `dailyGoalTarget: number` (default `0` = no daily goal)
- **A/B TOGGLE 1** `goalStyle: "ring" | "bar"` (default `"ring"`) — ring vs bar display.
- **A/B TOGGLE 2** `goalScope: "document" | "daily"` (default `"document"`) — which
  goal the status-bar widget tracks.

Add setters following the existing `useCallback` setter pattern (e.g.
`setWordGoalTarget`, `setWordGoalKind`, `setDailyGoalTarget`, `toggleGoalStyle`,
`toggleGoalScope`). Validate each in `loadSettings` defensively (clamp targets to
`>= 0` integers; fall back to defaults on bad types) exactly like the existing
`readingScale`/`theme` branches do.

For entering the numeric target: prefer the lightest UI. **First check
`ls components/ui/`** — if a `popover` primitive exists, build
`components/goal-popover.tsx` reusing it (a small form: target number input +
kind select + scope/style toggles). If no suitable primitive exists, run
`bunx shadcn add popover` then build it. As a minimum-viable fallback that needs
no new component, you may trigger goal entry from a command-palette action using
`window.prompt` (the codebase already uses `window.prompt` for naming versions —
see `components/studio-shell.tsx:196`), but the popover is preferred for a
"premium" feel (§6). Document which you chose.

**Verify**: `bun run typecheck` → exit 0. `grep -n "wordGoalTarget\|goalStyle\|goalScope" lib/studio/use-studio-settings.ts` shows the new fields.

### Step 5: Render the goal widget + session/streak in the status bar

In `components/status-bar.tsx`:

1. Extend `StatusBarProps` (lines 36–56) with:
   - `goalStyle: "ring" | "bar"`, `goalProgress: GoalProgress` (the computed
     progress for whichever goal `goalScope` selects), `goalTarget: number`
     (0 = hide the widget), and the display label e.g. `goalLabel: string`.
   - `sessionWords: number` (words written this session).
   - `streakDays: number` (current streak from `currentStreak`).
   - `onConfigureGoal: () => void` (opens the popover / prompt).
   Import `GoalProgress` from `lib/stats/streak.ts`.
2. Render, near the word count (after line 284, before the sync separator):
   - If `goalTarget > 0`: a compact button (matches the theme-button styling at
     lines 180–192) showing either a **ring** (inline SVG, ~14px, `stroke-dasharray`
     driven by `goalProgress.ratio`, stroke `var(--color-accent)` on a
     `var(--color-line)` track; when `met`, you may use `var(--color-success)`) or
     a **bar** (a thin `<span>` track with an accent fill width = `ratio*100%`),
     per `goalStyle`. `title`/`aria-label` announce e.g. "Goal: 850 / 1000 words".
     Clicking it calls `onConfigureGoal`.
   - If `goalTarget === 0`: render nothing for the ring/bar, but keep a quiet
     "Set goal" affordance reachable from the command palette (Step 7) — do not
     add a permanent empty control (§6 minimal chrome).
   - Session + streak: small `tabular-nums` text, only on `sm:` and up (wrap in
     the `hidden … sm:flex` cluster pattern, line 196), e.g. `+{sessionWords} this
     session · {streakDays}🔥`. Avoid emoji if it clashes with the typographic
     tone — prefer a lucide `Flame` icon at `size-[14px]` colored
     `var(--color-accent)`. **Keep it quiet**: tertiary ink color, no animation,
     no nag when behind.
3. Keep all styling to existing tokens/classes (no hex, no new CSS).

**Verify**: `bun run typecheck && bun run biome` → exit 0. `bun run build` → exit 0.

### Step 6: Wire computation, the session baseline, and the daily-total flush in the shell

In `components/studio-shell.tsx`:

1. **Session baseline**: capture the word count at session start per document.
   Add a `useRef<Map<Id<"documents">, number>>` (or a single value for the active
   doc) seeded when a document first reports a `wordCount`. `sessionWords =
   max(activeSync.wordCount - baseline, 0)`. Reset baseline on a full reload only
   (a new mount = a new session); do not reset on document switch unless you scope
   per-document (per-document is nicer — track baseline per `activeDocId`).
2. **Today's words + streak**: call `useQuery(api.writingStats.list, {})` to get
   `DailyStat[]`. Compute `today = localDateKey()`, `streakDays =
   currentStreak(stats, today)`. Today's persisted words = the row for `today`
   (or 0). For the *daily goal* widget, display words = `max(todayRow,
   activeSync.wordCount-derived today total)` — keep it simple: use the live
   document words as "today's words" only if you are tracking a single document;
   otherwise use the persisted `todayRow.words`. Document the choice. (Single-user,
   typically one active doc — using the persisted daily high-water mark plus the
   current live count is acceptable; do not overengineer multi-doc aggregation.)
3. **Goal progress**: compute `goalProgress(words, target, kind)` for the scope
   selected by `settings.goalScope` (document → `activeSync.wordCount` vs
   `settings.wordGoalTarget`; daily → today's words vs `settings.dailyGoalTarget`).
   Pass the result + `goalStyle` + `goalLabel` to `<StatusBar>`.
4. **Low-frequency daily-total flush** (do NOT write per keystroke or per save):
   add a `const recordStats = useMutation(api.writingStats.record)`. Debounce a
   call to `recordStats({ date: localDateKey(), words: <today's words> })` at
   ~30s using `useDebouncedCallback` (already a dependency, `use-debounce`, see
   `lib/sync/use-document-sync.ts:3`), triggered whenever `activeSync.wordCount`
   changes. Also flush once on `beforeunload`/unmount (mirror the cleanup pattern
   in `use-document-sync.ts:324-339`). Because the mutation is monotonic (Step 2),
   occasional redundant writes are harmless. Justify the 30s: streaks need
   day-granularity, not second-granularity — a coarse flush keeps Convex write
   volume low and off the typing hot path (§6 "Sync is debounced off the hot path").
5. Pass the new props into `<StatusBar … />` (the block at lines 588–632).

**Verify**: `bun run typecheck && bun run biome && bun run build` → exit 0.

### Step 7: Add a "Set word goal…" command-palette action

In `lib/keyboard/actions.ts`:
- Add `"set-goal"` to the `ActionId` union (around line 17–50).
- Add an `ActionDef` to the `ACTIONS` array (model on an existing `View`-section
  entry, lines 207–260): `{ id: "set-goal", label: "Set word goal…", section:
  "View", aliases: ["target", "goal", "words", "ulysses", "scrivener"], shortcut:
  { mac: "", other: "" } }`. (Optionally also `"toggle-goal-style"` and
  `"toggle-goal-scope"` actions for the two A/B toggles, modeled the same way — so
  the switchable settings are reachable without the popover.)

In `components/studio-shell.tsx` `dispatch` switch (lines 247–369), add a
`case "set-goal":` arm that opens the goal popover (or `window.prompt` fallback)
and writes via `settings.setWordGoalTarget` etc. If you added the toggle actions,
add their cases calling `settings.toggleGoalStyle` / `settings.toggleGoalScope`.

**Verify**: `bun run typecheck` → exit 0. `grep -n "set-goal" lib/keyboard/actions.ts components/studio-shell.tsx` shows the wiring. Open `bun run dev`, ⌘K → "Set word goal" appears and runs.

### Step 8: Run the full gate suite

**Verify**: `bun run typecheck && bun run biome && bun run test && bun run build`
→ all exit 0; new tests in `lib/stats/streak.test.ts` pass.

## Test plan

Create `lib/stats/streak.test.ts` (Vitest), modeled structurally on
`lib/workspace/operations.test.ts` (`import { describe, expect, it } from
"vitest";`, no mocks — pure functions). Cover:

- `localDateKey`: returns `"YYYY-MM-DD"` for a known local `Date`; pads month/day.
- `currentStreak` — the core "count only days you write" semantics:
  - empty list → 0.
  - wrote today only → 1.
  - wrote today + yesterday + day-before (3 consecutive) → 3.
  - wrote yesterday but NOT today (haven't written yet today) → still counts
    yesterday's streak (the no-break-shame case): yesterday+before → 2.
  - a gap (wrote 3 days ago and today, but not yesterday) → today=1 (the gap ends
    the backward walk).
  - a day with `words: 0` is treated as not-written (does not extend the streak).
  - duplicate date entries do not double-count.
- `goalProgress`:
  - `at-least`: below target → `met:false`, correct `ratio`/`remaining`; at/over
    target → `met:true`, `ratio:1`, `remaining:0`.
  - `at-most`: under → `met:true`; over → `met:false`, `ratio:1`.
  - `about`: within the ±10% band → `met:true`; outside → `met:false`.
  - `target <= 0` → `{ ratio:0, met:false, remaining:0 }`.

Verification: `bunx vitest run lib/stats/streak.test.ts` → all pass; then
`bun run test` → full suite passes including these.

(The Convex `record`/`list` mutation is exercised indirectly; a `convex-test`
integration test is optional and, if added, must be wired into `package.json`'s
`test` script — which is out of scope here. The monotonic + upsert logic is simple
enough that the pure streak tests plus a manual `bun run dev` check across two
browser profiles cover the risk.)

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run convex:codegen` exits 0; `grep -q writingStats convex/_generated/dataModel.d.ts`
- [ ] `bun run typecheck` exits 0
- [ ] `bun run biome` exits 0 (no diagnostics)
- [ ] `bun run test` exits 0; `lib/stats/streak.test.ts` exists and its cases pass
- [ ] `bun run build` exits 0
- [ ] `grep -q "writingStats" convex/schema.ts` and `convex/writingStats.ts` exports `record` + `list`
- [ ] `grep -q "wordGoalTarget" lib/studio/use-studio-settings.ts` and the two A/B toggles (`goalStyle`, `goalScope`) exist as settings
- [ ] `grep -q "set-goal" lib/keyboard/actions.ts`
- [ ] `lib/markdown/count-words.ts` is unmodified (`git diff --quiet a25c506 -- lib/markdown/count-words.ts`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (if that file exists)

## STOP conditions

Stop and report back (do not improvise) if:

- A `writingStats` table (or any per-user daily-stats table) ALREADY exists in
  `convex/schema.ts` — the feature may be partly built; reconcile before adding.
- `StatusBarProps` in `components/status-bar.tsx` no longer matches the excerpt in
  "Current state" (the prop contract drifted since `a25c506`).
- The `<StatusBar … />` call site in `components/studio-shell.tsx` (lines ~588–632)
  no longer sources `wordCount` from `activeSync` / no longer passes `settings`
  props as shown — the wiring changed and your prop additions may not land where
  expected.
- `lib/markdown/count-words.ts` no longer exports `countWords` with the shown
  signature.
- `convex/documents.ts` no longer exports `requireUserId` (the auth helper you
  import) — find the new auth shape before writing the mutation.
- Any step's verification fails twice after a reasonable fix attempt.
- The work appears to require modifying an out-of-scope file (e.g. you find you
  must change `count-words.ts`, `use-document-sync.ts`, or `package.json`).
- `ls components/ui/` shows no popover-like primitive AND `bunx shadcn add popover`
  fails — fall back to the `window.prompt` goal entry and note it; do not hand-roll
  a styled overlay.

## Maintenance notes

For the human/agent who owns this after it lands:

- **Decisions made & why**:
  - *Storage split*: goal *targets* (`wordGoalTarget`, `dailyGoalTarget`, kind) +
    the two A/B toggles live in localStorage via `use-studio-settings.ts` — they
    are per-device display preferences and don't need to be cloud-synced (a writer
    may want a different daily goal on a different machine; syncing them adds a
    Convex round-trip for a preference). The *streak and daily word totals* live
    in Convex (`writingStats`) because the streak must be identical on every device
    (§6 "resume anywhere") — a streak that resets when you switch laptops is broken.
  - *Table shape*: one row per `(userId, date)` with a `by_user_date` index for the
    upsert and `by_user` for the full-list read; `words` is a daily **high-water
    mark** (monotonic), so deleting text never erases a day's credit.
  - *No cron*: "reset at local midnight" is a pure client-side date comparison
    (`localDateKey()` rolls over at local midnight); the server stores raw daily
    rows and does no timezone math. This is why `convex/crons.ts` is untouched.
  - *Two A/B toggles* (ring vs bar; document-scope vs daily-scope) are exposed as
    switchable settings per the user's standing "build a toggle, don't hard-pick"
    preference — do not collapse them to a single hard choice without asking.
- **What a reviewer should scrutinize**: that the stats flush is genuinely
  low-frequency (~30s debounce, monotonic mutation) and never on the typing hot
  path; that the goal count shown equals the status-bar word count (same
  `countWords` source); that nothing nags (no modal, no color alarm when behind).
- **Future interactions**: if multi-document aggregation of "today's words" is
  ever wanted, the per-document session baseline in Step 6 must be revisited; and
  if `Intl.Segmenter`-based counting is later adopted, it must replace
  `count-words.ts` wholesale so the goal and the status bar stay in agreement.
- **Deferred out of scope**: a `convex-test` integration test for `record`/`list`
  (would require a `package.json` test-script edit); graphemes-aware counting via
  `Intl.Segmenter`; any goal-achievement celebration/animation (kept quiet by §6).
