# Plan 017: Silent failures get toasts; blocking alerts become toasts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- lib/history/use-document-history.ts lib/studio/use-ai-features.ts lib/studio/use-comment-highlights.ts lib/ui/toast.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

Two feedback defects, one fix surface:

1. **Silent data-write failure.** "Save version" (`Cmd/Ctrl+S`, the explicit
   checkpoint action) swallows errors: `createVersion(...).catch(() => {})`.
   A writer who names a version gets success-looking UI while the version may
   simply not exist — discovered only when they need to restore it. The
   undo/redo pointer write has the same swallow (lower severity — it self-heals
   on the next edit — but same pattern).
2. **Blocking native dialogs in a polished app.** The AI and comments flows use
   `window.alert` seven times for routine guidance ("Select some text first…",
   "Indexed N passages") while the rest of the studio (export, clipboard, image
   upload) uses the toast system. Alerts block the main thread, steal focus
   from the editor, and look foreign to the design system.

The toast infrastructure already exists and is exactly fit for both.

## Current state

- Toast system: `lib/ui/toast.ts` (14 lines) —
  `toast(message, kind: "info" | "success" | "error")`, rendered by `<Toaster/>`
  mounted at `components/studio-shell.tsx:905`, announced via a live region.
  Exemplar usage: `lib/export/file.ts:33` `toast("Exported Markdown", "success")`.
- Silent catches, `lib/history/use-document-history.ts`:
  - line 325-327 (inside `tagVersion`):
    ```ts
    await createVersion({ documentId, nodeId: id, label, kind }).catch(
        () => {},
    );
    ```
  - line 289-295 (inside `navigateTo`): `void updatePointer({...}).catch(() => {});`
- Alerts to convert (all seven):
  - `lib/studio/use-ai-features.ts:109` (AI unavailable/guard message — read it),
    `:127` and `:142` ("Select some text first, then summon the AI transform."),
    `:208` (`Indexed ${count} passage(s).`), `:210` (`Re-index failed: …`)
  - `lib/studio/use-comment-highlights.ts:162` (comment guidance — read it),
    `:199` ("Select some text first, then add a comment.")
- **Deliberately NOT in scope**: the `window.prompt` call sites (version label
  at `components/studio-shell.tsx:270`, `components/history/history-panel.tsx:158,376`;
  link URL at `lib/editor/codemirror/index.tsx:219`,
  `lib/editor/milkdown/index.tsx:549`). Replacing a prompt needs a real inline
  input affordance — separate design work, recorded as a direction option in
  `plans/README.md`. Do not convert prompts to toasts (a toast can't collect input).

## Commands you will need

| Purpose   | Command              | Expected on success |
|-----------|----------------------|---------------------|
| Typecheck | `bun run typecheck`  | exit 0              |
| Lint      | `bun run biome`      | exit 0              |
| Tests     | `bun run test`       | all pass            |
| Dev run   | `bun run dev`        | app on :3000        |

## Scope

**In scope**:
- `lib/history/use-document-history.ts` (the two catch blocks only)
- `lib/studio/use-ai-features.ts` (the five `window.alert` sites only)
- `lib/studio/use-comment-highlights.ts` (the two `window.alert` sites only)
- Corresponding test updates if any test asserts on `window.alert`
  (check: `grep -rn "window.alert" --include="*.test.ts" lib components`)

**Out of scope**:
- All `window.prompt` sites (see Current state — direction option, not this plan).
- `lib/ui/toast.ts` and `<Toaster/>` — no API changes; consume as-is.
- Any retry logic for the failed writes — surfacing is this plan; retries are not.

## Git workflow

- Work on `main`. Conventional commit, e.g.
  `fix: surface version-save failures and replace AI/comment alerts with toasts`.
- No AI attribution. Don't push unless asked.

## Steps

### Step 1: Version-save failure surfaces

In `lib/history/use-document-history.ts`:

- `tagVersion`: replace `.catch(() => {})` with a catch that calls
  `toast("Couldn't save version — it may not be synced", "error")` (import
  `toast` from `@/lib/ui/toast`; check the file's existing import style).
- `navigateTo`'s `updatePointer` catch: same pattern, quieter message
  (`toast("Couldn't sync undo position", "error")`). Keep the `void` semantics —
  navigation must not block on the write.

**Verify**: `bun run typecheck` → exit 0, and
`grep -n "catch(() => {})" lib/history/use-document-history.ts` → no matches.

### Step 2: Alerts → toasts

Convert the seven `window.alert` sites:

- Guidance messages ("Select some text first…") → `toast(message, "info")`.
- `Indexed N passages.` → `toast(…, "success")`.
- `Re-index failed: …` → `toast(…, "error")`.

Keep messages verbatim unless they read wrong as a one-line toast; if you
shorten, preserve the instruction ("Select some text first").

**Verify**: `grep -rn "window.alert" lib components app --include="*.ts" --include="*.tsx"` → zero matches.

### Step 3: Manual dev pass

In `bun run dev`: trigger each converted path — AI transform with no selection,
add-comment with no selection, re-index (success path), and a version save with
the network offline (devtools offline mode) to see the error toast.

**Verify**: each shows a toast, none shows a native dialog, the editor keeps focus.

## Test plan

- If existing tests stub/assert `window.alert`, update them to assert a toast
  event instead (the toast dispatches a `recto:toast` CustomEvent on `window` —
  tests can listen for it; see `lib/ui/toast.ts:8-12`).
- Add one test for the `tagVersion` failure path if the hook has an existing
  test harness (check `lib/history/*.test.ts`); if the hook is untested today,
  a manual check is acceptable — note it in the report rather than building a
  new React-hook harness for this plan.
- `bun run test` → all pass.

## Done criteria

- [ ] Zero `window.alert` in product code (`grep` proof)
- [ ] Zero `.catch(() => {})` in `lib/history/use-document-history.ts`
- [ ] Version-save failure demonstrably shows an error toast (offline dev check)
- [ ] `window.prompt` sites untouched (`git diff` does not include them)
- [ ] `bun run typecheck && bun run biome && bun run test` exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- A `window.alert` turns out to be load-bearing for flow control (code after it
  assumes the blocking pause) — a toast is non-blocking; report the site.
- The offline version-save check reveals the failure is swallowed somewhere
  ABOVE the catch you fixed (i.e. the toast never fires) — deeper issue, report.

## Maintenance notes

- Direction option recorded in `plans/README.md`: replace the five
  `window.prompt` sites with inline inputs (version-label rename affordance in
  the history panel; link-URL popover in both editors). That work should reuse
  the comments-panel inline-composition pattern.
- If retries are ever added for failed version saves, the toast should gain an
  action ("Retry") — the current toast API is message-only; that would be the
  moment to extend it, not before.
