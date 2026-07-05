# Plan 018: Surface the two shipped-but-unreachable settings (AI transform mode, lint categories)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- lib/studio/use-studio-settings.ts lib/studio/action-map.ts lib/keyboard/actions.ts components/status-bar.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (additive palette actions; setters already exist and persist)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

Two fully-implemented, persisted settings have **zero UI or palette path** to
change them — the code paths are shipped and dead:

1. `aiTransformMode` — the plan-009 A/B fork for how an accepted AI transform
   lands (`"pending"` confirm-UX vs `"replace"` immediate). The repo's standing
   convention (see `plans/README.md` cross-cutting conventions) is that genuine
   A/B UX forks ship as *switchable user settings* — this one shipped the
   switch but no way to flip it. Every user is locked to `"pending"` forever.
2. `lintCategories` — per-category prose-lint toggles (passive / readability /
   adverb / weasel). The settings comment promises "each individually
   toggleable"; only the master lint on/off is surfaced
   (`components/status-bar.tsx:388`). The four stored booleans can never
   diverge from all-on.

The fix is small because everything exists: the setters, persistence, and the
single action registry that feeds both the chord handler and the command
palette ("one registry, two surfaces").

## Current state

- Settings definition, `lib/studio/use-studio-settings.ts`:
  - `:107-108` — `aiTransformMode: AiTransformMode` ("switchable A/B fork");
    default `"pending"` at `:153`; setters `setAiTransformMode` /
    `toggleAiTransformMode` around `:480-489`.
  - `:99-100` — `lintCategories: LintOptions`; defaults all-true at `:138-143`;
    `toggleLintCategory` around `:443-451`; loader `loadLintCategories`
    `:159-171`.
  - **Verified 2026-07-05: neither `toggleAiTransformMode`, `setAiTransformMode`,
    nor `toggleLintCategory` has any caller outside the definition file.**
- Consumers (prove the settings are live once flipped):
  - `lib/ai/use-ai-transform.ts:83` consumes `aiTransformMode`.
  - `components/workspace/pane-editor.tsx:86,181` consumes `lintCategories`.
- Action registry: `lib/keyboard/actions.ts` — action ids + labels + sections +
  chords (see the export rows at `:309-320` for the shape). Dispatch:
  `lib/studio/action-map.ts` — e.g. `"toggle-ai": () => settings.toggleAiEnabled()`
  at `:142`. The palette and chord handler both read this registry (plan/phase-5
  "one registry, two surfaces" — do NOT wire the palette separately).
- Existing exemplar of a settings-toggle action pair: `toggle-ai` (registry row
  in `actions.ts`, dispatch in `action-map.ts`, tested in
  `lib/studio/action-map.test.ts`).
- Repo conventions: palette rows show platform-correct chords; actions without
  chords are allowed (palette-only rows) — check how chord-less actions render
  in `components/command-palette.tsx` before inventing anything.

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass            |
| Dev run   | `bun run dev`        | app on :3000        |

## Scope

**In scope**:
- `lib/keyboard/actions.ts` (new action ids + rows)
- `lib/studio/action-map.ts` (dispatch entries)
- `lib/studio/action-map.test.ts` (extend, following its existing stub pattern)
- `components/command-palette.tsx` ONLY if chord-less rows need a rendering fix
  (they likely don't — verify first)

**Out of scope**:
- New keyboard chords — palette-only actions; the keymap is a curated canon
  (blueprint 13) and these are low-frequency toggles.
- A settings/preferences dialog — deliberately not building new chrome; the
  palette IS the settings surface for toggles in this app.
- Changing defaults or persistence semantics in `use-studio-settings.ts`.

## Git workflow

- Work on `main`. Conventional commit, e.g.
  `feat: palette actions for AI transform mode and lint category toggles`.
- No AI attribution. Don't push unless asked.

## Steps

### Step 1: Registry rows

In `lib/keyboard/actions.ts`, add five actions (match the existing naming
style — inspect nearby ids first):

- `toggle-transform-mode` — label like "AI: transform lands as pending / replace"
  (make the CURRENT mode visible in the label if the registry supports dynamic
  labels; if labels are static strings, use "Toggle AI transform mode
  (pending/replace)"). Section: wherever `toggle-ai` lives (View/AI section).
- `toggle-lint-passive`, `toggle-lint-readability`, `toggle-lint-adverb`,
  `toggle-lint-weasel` — labels "Lint: toggle passive voice" etc. Same section
  as the master lint toggle. Include fuzzy aliases ("passive", "adverb",
  "weasel", "readability") matching the aliases pattern used elsewhere in the
  file.

No chords for any of the five.

**Verify**: `bun run typecheck` → exit 0 (the ActionId union forces dispatch
handling next).

### Step 2: Dispatch entries

In `lib/studio/action-map.ts` add:

```ts
"toggle-transform-mode": () => settings.toggleAiTransformMode(),
"toggle-lint-passive": () => settings.toggleLintCategory("passive"),
// …readability, adverb, weasel
```

Match the exact category-key strings from `LintOptions` in
`lib/studio/use-studio-settings.ts` / `lib/lint` (read the type first).

**Verify**: `bun run typecheck && bun run biome` → exit 0.

### Step 3: Tests

Extend `lib/studio/action-map.test.ts` using its existing partial-stub pattern
(see the `biome-ignore … partial settings stub` comments at `:33,41`): assert
each new action id calls the corresponding settings method with the right
argument.

**Verify**: `bun run test -- action-map` → all pass.

### Step 4: Manual dev pass

`bun run dev` → ⌘K palette:
- "transform mode" surfaces the toggle; flipping it then running an AI transform
  (AI enabled, text selected) lands per the flipped mode; the setting survives
  reload (localStorage persistence).
- "weasel" surfaces its toggle; with lint ON, toggling a category off removes
  only that category's highlights (make a doc with "very clearly was being
  done" to light up multiple categories).

**Verify**: both behaviors observed; settings persist across reload.

## Test plan

- `lib/studio/action-map.test.ts`: five new assertions (Step 3).
- Manual: the two dev-pass behaviors (Step 4) recorded in the report.
- `bun run test` → all green.

## Done criteria

- [ ] `grep -rn "toggleAiTransformMode\|toggleLintCategory" lib components --include="*.ts" --include="*.tsx" | grep -v use-studio-settings` → at least 5 caller matches (was 0)
- [ ] All five actions reachable and labeled in the ⌘K palette
- [ ] `bun run typecheck && bun run biome && bun run test` exit 0
- [ ] No new chords added (`git diff lib/keyboard` shows no chord strings)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The action registry requires a chord for every action (i.e. chord-less rows
  break the palette or the cheat-sheet rendering) — that's a registry-shape
  question the operator should weigh in on.
- `AiTransformMode` has more than the two values this plan assumes (read the
  type) — a toggle would silently skip states; report and propose a cycle
  action instead.

## Maintenance notes

- If a real preferences surface ever ships, these palette actions should
  remain (palette-first is the app's philosophy); the dialog would be a third
  reader of the same settings hooks.
- The dynamic-label question (showing the current mode in the row) is worth a
  follow-up if the registry gains computed labels; don't force it now.
