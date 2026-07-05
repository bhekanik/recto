# Plan 011: Make AI editorial feedback act like a human reviewer — real anchored comments + tracked-change suggestions, created through the same review primitives as humans

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This plan REQUIRES plan 010 (review collaboration)
> to be implemented first and **consumes its primitives — it must not reinvent
> them**. Before doing anything, confirm plan 010's comment/anchor/suggestion-branch
> primitives exist (see the STOP condition at the top of "STOP conditions"); if
> they are absent, STOP. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat 31a505c..HEAD -- lib/ai/config.ts lib/ai/server.ts lib/ai/transform-request.ts lib/ai/use-rag.ts lib/ai/summon.ts app/api/ai/critique/route.ts app/api/ai/transform/route.ts components/ai/critique-panel.tsx components/studio-shell.tsx lib/keyboard/actions.ts lib/history/use-document-history.ts convex/review.ts lib/review/anchor.ts convex/schema.ts
> ```
> If any of these files changed since this plan was written (commit `31a505c`),
> compare the "Current state" excerpts against the live code before proceeding;
> on a mismatch, treat it as a STOP condition. Note: `convex/review.ts`,
> `lib/review/anchor.ts`, and the `comments`/`documentShares`/`reviewBranches`
> tables in `convex/schema.ts` are CREATED by plan 010 and are EXPECTED to exist
> when this plan runs — that is the dependency, not drift.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: **plans/010-review-collaboration.md — HARD PREREQUISITE.** 011 consumes 010's `comments` table + comment-creation mutation, the quote+prefix/suffix anchoring util `lib/review/anchor.ts` (`createAnchor`/`locateAnchor`), the reviewer-branch / suggestion-append path (`convex/review.ts` `reviewerAppend` + `reviewBranches`), and the owner review surface. It also depends on 010's **cross-cutting rule "comment + suggestion creation is programmatic — one path for humans and AI"** (010 §"Cross-cutting rule: comment + suggestion creation is programmatic") being honored, including the **author/origin parameterization** described there. If 010 shipped without that parameterization, see STOP conditions. Also (transitively) plan 009 (the AI provider wiring this reuses). Phases run in order: A → B; each is independently shippable; A first.
- **Category**: direction
- **Planned at**: commit `31a505c`, 2026-06-18

## Why this matters

Today Recto's AI "critique" (plan 009, Phase B) returns a read-only list of qualitative notes in a side panel (`components/ai/critique-panel.tsx`). It tells the writer something is weak but never points at the exact words, and the writer can't act on a note in place. Meanwhile plan 010 builds a real human-review surface: anchored **comments** and tracked-change **suggestions** on a reviewer branch, accepted/rejected one path. This plan makes the AI behave like one of those human reviewers: it returns **structured output naming the exact text each comment/edit attaches to**, and we programmatically create real anchored comments and a real AI suggestion branch through 010's primitives, attributed to a synthetic "AI reviewer." The owner then reviews the AI's comments and suggestion branch in the SAME surface as human feedback — accept/reject identically. The win: AI feedback stops being a passive list and becomes actionable, in-place, reversible, and indistinguishable in mechanism from a trusted human reviewer's.

## Relationship to plan 009 (the critique it supersedes)

011 **supersedes** plan 009's read-only critique. The read-only `components/ai/critique-panel.tsx` and its `/api/ai/critique` route produce notes that go nowhere. This plan replaces that surface with real anchored comments created via 010's primitives. Decision (committed): in Phase A, **repurpose the critique entry point** (the `ai-critique` action + its palette item + the `Ctrl+⇧+J` chord) to invoke the new AI review flow, and **stop mounting `CritiquePanel`**. Do NOT delete `critique-panel.tsx`, `/api/ai/critique/route.ts`, `buildCritiqueMessages`, or `parseCritique` in this plan — leave them in the tree (a follow-up cleanup plan removes them once the AI-review flow is proven). This keeps the blast radius small and the change reversible. State this in the PR description.

> **Update 2026-07-05:** the follow-up cleanup happened — `components/ai/critique-panel.tsx` and `app/api/ai/critique/route.ts` are deleted; the last residue (dead `AI_CRITIQUE_MAX_TOKENS` constant + stale comment references) was removed by plan 019. The deferral above is historical.

## Relationship to plan 010's no-AI-on-shared rule

Plan 010 §"Cross-cutting rule: no AI on shared-for-comment notes": while a document is shared out for human review, all AI features are OFF for that document. **This plan does not violate that rule and must preserve it.** The AI reviewer is the **owner running AI on their OWN, un-shared document** — exactly the case 010 carves out (010 §"Cross-cutting rule: comment + suggestion creation is programmatic", last paragraph: "the AI reviewer is the owner running AI on their OWN (un-shared) document; the no-AI-on-shared rule governs docs shared out to human reviewers"). Concretely: the AI-review entry point must be gated OFF whenever the active document is shared (owner side) or was opened as shared-with-me (reviewer side) — the SAME gate 010 wires for the other AI features. Reuse that gate; do not invent a second one.

## Current state

### What exists today (live code — reuse verbatim)

- `lib/ai/config.ts` — single source of truth for the model + caps. `AI_CHAT_MODEL = "z-ai/glm-5.2"` (line 21); `AI_CRITIQUE_MAX_TOKENS = 1500` (line 27). The model is a reasoning model; the routes disable reasoning. **Add `AI_REVIEW_MAX_TOKENS` here** (do not hardcode a cap in the route).
- `lib/ai/server.ts` — `openRouter()` (lines 16-30) builds the OpenAI SDK pointed at OpenRouter (key from `OPENROUTER_API_KEY`, server-only, never shipped to client); `requireUser()` (lines 37-40) returns the Clerk user id or null. **Reuse both verbatim — do NOT add a new provider.**
- `app/api/ai/critique/route.ts` — the route shape to mirror. It is a NON-streaming single JSON response. Key lines, copy this shape:

  ```ts
  // app/api/ai/critique/route.ts:10-11, 19-64 (shape to mirror)
  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";
  // ... requireUser() → 401; parse body → 400; openRouter() → 503 ...
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    reasoning?: { enabled: boolean };
  } = {
    model: AI_CHAT_MODEL,
    max_tokens: AI_CRITIQUE_MAX_TOKENS,
    messages: buildCritiqueMessages(body),
    reasoning: { enabled: false }, // OpenRouter extension; GLM 5.2 reasoning off
  };
  const completion = await client.chat.completions.create(params, { signal: req.signal });
  const raw = completion.choices?.[0]?.message?.content ?? "";
  const notes = parseCritique(raw);
  return Response.json({ notes });
  ```

  The error mapping the new route must reuse: 401 (no user), 400 (invalid/missing body), 503 (`openRouter()` threw — key absent), 499 (`AbortError`), 502 (other failure).
- `lib/ai/transform-request.ts` — `parseCritique(raw)` (lines 71-99) is the **tolerant JSON parser to model the new parser on**: it strips a ```` ```json ```` fence, finds the first `{`…last `}`, `JSON.parse`s, validates each item's field types, and returns `[]` on anything unparseable (never throws). `buildCritiqueMessages` (lines 54-61) is the prompt builder shape to mirror.
- `lib/ai/transform-request.test.ts` — the test pattern to mirror for the new parser (plain vitest `describe`/`it`, cases for clean JSON, fenced JSON, stray-prose-wrapped JSON, malformed-item dropping, and unparseable→empty). **Model `parseReview` tests on this file exactly.**
- `components/ai/critique-panel.tsx` — the read-only panel 011 supersedes. Structurally modeled on `components/outline/outline-panel.tsx` (fixed inset-y-right `aside`, `recto-panel`, `recto-scrim`, Escape-to-close, focus-restore, `AbortController` fetch). 011's progress/result UI reuses this chrome.
- `lib/ai/use-rag.ts` — the client fetch pattern: `fetch("/api/ai/<x>", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(...), signal})`, map `401`→"Sign in to use AI". **Model the new client review fetch on this.**
- `app/api/ai/transform/route.ts` — confirms the `reasoning: { enabled: false }` extension param shape on a typed `ChatCompletionCreateParams...`. The review route is non-streaming, so mirror the critique route (not this one), but the reasoning-param typing is identical.
- `components/studio-shell.tsx` — where AI is summoned/wired and gated by `settings.aiEnabled`:
  - `setAiEnabledMirror(settings.aiEnabled)` (line 311) syncs the out-of-tree mirror.
  - `getActiveMarkdown()` (lines 315-322) reads the live canonical markdown of the active doc from its primary handle — **this is the text to send for review**.
  - The `dispatch(id)` switch routes actions; `case "ai-critique"` (lines 705-707) currently does `if (settings.aiEnabled) setCritiqueOpen(true)`. **011 repoints this to open the AI-review flow.**
  - AI surfaces are mounted only `{settings.aiEnabled && ( … <CritiquePanel … /> … )}` (lines 1193-1230). **011 mounts its review-progress UI here under the same gate, AND additionally the 010 no-AI-on-shared gate.**
  - `activeHistoryRef.current` is the active doc's `HistoryController` (line 300-302).
- `lib/keyboard/actions.ts` — the single `ACTIONS` registry. `ActionSection` union (lines 8-17) includes `"AI"`; plan 010 ADDS a `"Review"` section. `ActionId` union (lines 19-68) includes `ai-critique` (line 40). The palette gates the `"AI"` section with `if (section === "AI" && !aiEnabled)` (per 010's note, mirror that gating). **011 may add at most one new `ActionId` (see Scope) and must not rename existing ones.**
- `lib/history/use-document-history.ts` — `HistoryController` (lines 26-51) exposes `commitProgrammatic(markdown, {origin})` (lines 44-47, impl 359-376), the CLIENT-side seam plan 009's AI transform uses (origin like `"ai:tighten"`). **Note for contrast**: 009's transform commits onto the OWNER's spine via `commitProgrammatic`. 011's suggestions must NOT use this — they go onto an AI suggestion BRANCH via 010's `reviewerAppend` path so the owner can accept/reject (see Phase B).

### What plan 010 provides that 011 consumes (PLANNED primitives — verify they exist before starting)

These are described in `plans/010-review-collaboration.md` and are CREATED there. They are **planned**, not yet in the live tree at commit `31a505c`. 011 must use them and must not duplicate them. Verify each is present (see Phase A Step 0):

- **`comments` table** (010 SPIKE Step 1, schema lines 269-283): `{ documentId, authorUserId, authorName, anchor: { quote, prefix, suffix, offsetHint }, body, threadParentId?, resolved, createdAt }`, index `by_document`.
- **The comment-creation mutation** — 010 names it **`comments.add`** in `convex/review.ts` (010 Phase B scope, line 425; permissions line 458). NOTE the prompt for this plan called it `comments.create`; the canonical name from 010 is **`comments.add`** — use whatever name 010 actually shipped (grep for it; accept either `comments.add` or `comments.create`).
- **The author/origin parameterization** — 010 §"Cross-cutting rule: comment + suggestion creation is programmatic" (b) REQUIRES the comment-creation and reviewer-append paths to accept the **attributed author/origin as parameters** (synthetic AI reviewer: `authorName: "AI · <model>"`, a stable synthetic author id, branch `origin: "ai:review:<model>"`), while still verifying the CALLER. **This is the seam 011 calls through.** ⚠️ 010's drafted `comments.add` (010 line 458) derives `authorName` from `identity.name ?? identity.email ?? "Reviewer"` and `reviewerAppend` (010 lines 299-311) derives `origin = review:<userId>` from the caller — i.e. as literally drafted they do NOT yet take author/origin params. The cross-cutting rule says they MUST. If 010 shipped without the optional author/origin params, this plan is blocked — see STOP conditions ("010 programmatic seam not parameterized").
- **`lib/review/anchor.ts`** (010 Phase B, lines 426, 434-448): pure `createAnchor(markdown, from, to) → { quote, prefix, suffix, offsetHint }` and `locateAnchor(markdown, anchor) → { from, to } | null` with exact-unique → prefix/suffix-disambiguation → fuzzy → null. **011 reuses `locateAnchor` verbatim to resolve AI quotes.** Do not write a second locator.
- **`reviewerAppend` + `reviewBranches`** (010 SPIKE Step 2 lines 299-311; Phase C lines 491-504): the append-only, access-gated, pointer-free path that puts a reviewer's edits on a shadow branch off the owner's `currentNodeId` (origin `review:<reviewerUserId>`, or `ai:review:<model>` for AI), tracked by a `reviewBranches` row with `status`. **011 builds the AI suggestion branch by applying each `quote→replacement` edit through this path.**
- **The owner review surface** — 010 Phase C `components/review/review-surface.tsx` (line 494): lists open branches + comments, per-branch word-level diff (`getBranchDiff` + `diffRuns` + the render block from `history-panel.tsx:415-503`), Accept/Reject. **011 adds NO new review UI** beyond a progress/summary affordance; AI comments and the AI branch render in THIS surface automatically because they live in the same tables.

### Conventions this plan MUST follow

- **Bun** for everything (`bun run …`, `bunx convex …`). Project CLAUDE.md: prefer Bun.
- **Convex is the only write path.** AI comments and the AI suggestion branch are created EXCLUSIVELY through 010's Convex mutations. The Next.js review route only calls the LLM and returns JSON — it performs NO Convex writes.
- **Reuse the OpenRouter wiring** (`openRouter()` + `requireUser()` + `AI_CHAT_MODEL` + `reasoning:{enabled:false}`). Do NOT add a new provider, SDK, or key.
- **AI stays opt-in / keyboard-summoned** — the review flow is reachable only when `settings.aiEnabled` is true AND the doc is the owner's own un-shared doc (the 010 no-AI-on-shared gate). Owner-initiated only; never auto-run.
- **Structured output, not tool-calling** for v1 (see "Design decisions").
- **shadcn primitives, dark-only OKLCH tokens** (`var(--color-…)`, `var(--space-…)`). Compose existing `recto-panel`/`recto-scrim`/`recto-kbd` classes; introduce no new color values. The AI-review progress UI reuses `critique-panel.tsx`'s chrome.
- **TS strict + ESM**, `@/`-aliased imports.
- **Run `bunx convex codegen` after any schema or Convex-function change** (this plan adds NO Convex schema, but if you touch `convex/review.ts` re-run codegen before typecheck).
- **Commits**: conventional `type: description`, NO AI attribution, NO `Co-Authored-By`. One commit per phase (A, B) after its gates pass.
- **A/B forks ship as switchable settings** (project memory). This plan has one optional fork — "auto-place vs preview-then-place AI feedback" — see Phase A; if you build the preview step, make it a setting, do not hardcode it.

## Commands you will need

| Purpose             | Command                                                        | Expected on success |
|---------------------|---------------------------------------------------------------|---------------------|
| Install             | `bun install`                                                 | exit 0              |
| Regen Convex types  | `bunx convex codegen`                                         | exit 0; `convex/_generated/*` updated |
| Typecheck           | `bun run typecheck`                                           | exit 0, no errors   |
| Lint/format         | `bun run biome`                                               | exit 0 (no errors)  |
| Tests (all)         | `bun run test`                                                | all pass            |
| Tests (one file)    | `bunx vitest run lib/ai/review.test.ts`                       | that file passes    |
| Build               | `bun run build`                                               | exit 0              |

Notes (verified during recon):
- `bun run test` = `vitest run && bun test spikes/undo-tree/tests/convex.bun.test.ts`. Vitest `include` is `["spikes/**/*.test.ts", "lib/**/*.test.ts"]` and `exclude` `["**/*.bun.test.ts"]`. **New pure-logic tests MUST live under `lib/**` to be picked up.** `lib/ai/transform-request.test.ts` and `lib/history/diff.test.ts` are existing exemplars.
- Root `tsconfig.json` excludes `spikes` and `**/*.bun.test.ts`; `convex/` is typechecked via `convex codegen`/`convex dev`. **Always run `bunx convex codegen` before `bun run typecheck`** after any Convex-function change.
- The new pure modules (`lib/ai/review.ts`, `lib/ai/review-apply.ts`) are plain TS, picked up by `bun run typecheck` directly.

## Suggested executor toolkit

- Skill `claude-api` — the model is GLM 5.2 via OpenRouter, NOT Claude; do NOT route through this skill for the provider, but it confirms the OpenAI-compatible param shape if you're unsure of `reasoning` typing. (Provider is OpenRouter; never swap it.)
- Skill `convex` — only if Phase B reveals 010's `reviewerAppend`/`comments.add` signatures need adapting for the author/origin params (which is a 010 gap, a STOP condition — do not silently edit 010's mutations beyond what 010 itself specified).
- Read first-hand before starting: `plans/010-review-collaboration.md` IN FULL (especially its two cross-cutting rules and the SPIKE + Phase B + Phase C sections), and the "Current state" excerpts here. You do NOT need to re-read plan 009.

## Design decisions (committed — do not redesign)

1. **Structured output, not tool-calling, for v1.** The model returns a single JSON object describing all feedback; we parse it (tolerantly, like `parseCritique`) and then create comments/suggestions ourselves. This is simpler and deterministic: one round-trip, no tool-loop state, no streaming. **Tool-calling is a documented future option** (Maintenance notes) — a future version could expose `create_comment`/`suggest_edit` tools and let the model call them in a loop; out of scope here.

2. **The exact JSON schema (committed):**

   ```jsonc
   {
     "comments": [
       {
         "quote": "string — EXACT verbatim substring of the provided text the comment attaches to",
         "prefix": "string? — up to ~40 chars immediately BEFORE the quote (disambiguates repeats)",
         "suffix": "string? — up to ~40 chars immediately AFTER the quote",
         "category": "string? — short label e.g. Clarity, Pacing, Structure, Tone, Argument",
         "body": "string — the comment text"
       }
     ],
     "suggestions": [
       {
         "quote": "string — EXACT verbatim substring of the provided text to replace",
         "prefix": "string?",
         "suffix": "string?",
         "replacement": "string — the proposed replacement text",
         "rationale": "string? — why this edit"
       }
     ]
   }
   ```

   - **`quote` is the load-bearing field**: it is the EXACT verbatim substring of the document the comment/edit attaches to. The prompt MUST instruct the model to **copy `quote` verbatim from the provided text** — no paraphrase, no normalization, no added or stripped Markdown — because anchoring depends on `locateAnchor` finding `quote` in the live markdown.
   - `prefix`/`suffix` are short surrounding context (≤ ~40 chars) to disambiguate when `quote` appears more than once. The model should include them when `quote` is short or likely repeated; they map onto 010's `anchor.prefix`/`anchor.suffix`.
   - `category`, `rationale` are optional. `body`/`replacement` are required for their item to count.

3. **A new non-streaming route** `app/api/ai/review/route.ts` — mirror the critique route exactly (reuse `requireUser` + `openRouter` + `AI_CHAT_MODEL` + `reasoning:{enabled:false}`; `max_tokens: AI_REVIEW_MAX_TOKENS`). Single JSON response; no streaming.

4. **`buildReviewMessages` + `parseReview`** live in a NEW module `lib/ai/review.ts` (keeps the new schema/prompt separate from the legacy `transform-request.ts`; do not bloat that file). Both pure and unit-tested in `lib/ai/review.test.ts`.

5. **Anchoring + attribution reuse 010 verbatim** (the whole point):
   - Each comment's `{quote, prefix, suffix}` is resolved against the LIVE canonical markdown via **010's `locateAnchor`** (after building an anchor object from the AI's quote/prefix/suffix — see Phase A Step 4). Resolved → create a real comment via 010's comment-creation mutation, attributed to the synthetic AI reviewer (`authorName: "AI · GLM 5.2"` or derived from `AI_CHAT_MODEL`, plus 010's synthetic author id). Unresolvable → DROP and COUNT (never mis-anchor).
   - Each suggestion's `quote→replacement` is applied onto an **AI suggestion branch** via 010's `reviewerAppend` path (origin `ai:review:<model>`). The owner reviews the branch's word-level diff and accepts/rejects in 010's review surface.

6. **Anchoring robustness (load-bearing risk).** Quotes that cannot be located in the live doc are DROPPED and COUNTED, never mis-anchored. Surface to the owner: "placed N of M comments / K of L edits." Reuse 010's locator (exact-unique → prefix/suffix → fuzzy → null). **Do NOT fall back to LLM-supplied char offsets** — they are unreliable. If, after a real attempt, the model cannot reliably return locatable verbatim quotes, STOP and report (do not ship char-offset anchoring).

7. **Phasing**: **Phase A = AI comments** (structured output → anchored comment creation), the simpler half. **Phase B = AI tracked-change suggestions** (apply `quote→replacement` edits onto an AI suggestion branch via `reviewerAppend`; reviewed via the existing word-level diff). A is a hard prerequisite for B; each is independently shippable.

8. **Optional A/B fork (switchable setting, do not hardcode)**: "auto-place AI feedback" (comments/suggestions appear immediately, owner reviews them in the review surface) vs "preview then place" (a summary listing each proposed comment/edit, owner ticks which to place). v1 default: **auto-place** (matches how human comments arrive — they just appear in the surface). If you build preview-then-place, add it as a `settings` toggle (mirror an existing boolean setting in `lib/studio/use-studio-settings.ts`); otherwise ship auto-place only and note the fork in Maintenance notes.

## Scope

**In scope (whole plan):**
- `lib/ai/config.ts` — add `AI_REVIEW_MAX_TOKENS` (Phase A).
- `lib/ai/review.ts` (create) — `buildReviewMessages`, `parseReview`, the `ReviewRequestBody`/`AiReviewResult`/`AiReviewComment`/`AiReviewSuggestion` types, and the AI reviewer identity constants (`AI_REVIEWER_AUTHOR_NAME`, `AI_REVIEWER_AUTHOR_ID`, `aiReviewOrigin()`).
- `lib/ai/review.test.ts` (create) — pure tests for `parseReview` + `buildReviewMessages`.
- `lib/ai/review-apply.ts` (create, Phase B) — PURE `applyEdit(markdown, anchor, replacement) → string | null` (splice one resolved `quote→replacement` onto a markdown string) and `applyEdits(markdown, edits) → { markdown, placed, dropped }` (apply a batch, resolving each via `locateAnchor`, skipping overlapping/unlocatable).
- `lib/ai/review-apply.test.ts` (create, Phase B) — pure tests for edit application incl. unlocatable-dropped and overlap handling.
- `app/api/ai/review/route.ts` (create) — the non-streaming review route.
- `lib/ai/use-ai-review.ts` (create) — client hook: POST the markdown, parse, resolve anchors, create comments (Phase A) + build the suggestion branch (Phase B) via 010's mutations, return the placement summary.
- `components/ai/ai-review-panel.tsx` (create) — progress/summary affordance (modeled on `critique-panel.tsx` chrome): "Reading your draft…", then "Placed N of M comments / K of L edits — open the review surface." Provides a button that opens 010's review surface.
- `components/studio-shell.tsx` — repoint `case "ai-critique"` to the AI-review flow; mount `AiReviewPanel` under the existing `settings.aiEnabled` gate AND 010's no-AI-on-shared gate; stop mounting `CritiquePanel`.
- `lib/keyboard/actions.ts` — relabel the `ai-critique` action (keep the id to avoid churn; change `label`/`aliases` to "AI review…"). Optionally add ONE new action id if you prefer a distinct entry (e.g. `ai-review`); if so add it to the union and `ACTIONS` and wire `dispatch`. **Prefer relabeling `ai-critique` in place** (minimal blast radius).
- `lib/studio/use-studio-settings.ts` — ONLY if you build the optional preview-then-place fork (add a boolean setting). Otherwise out of scope.

**Out of scope (do NOT touch):**
- `convex/review.ts`, `convex/schema.ts`, `lib/review/anchor.ts`, `components/review/review-surface.tsx` — these are plan 010's. **011 consumes them; it does not modify them.** The ONE exception: if 010's comment-creation/reviewer-append mutations lack the optional author/origin params that 010's own cross-cutting rule (b) mandates, that is a 010 gap → STOP and report (do not patch 010's mutations from this plan; the parameterization is 010's responsibility per its cross-cutting rule).
- `app/api/ai/critique/route.ts`, `components/ai/critique-panel.tsx`, `buildCritiqueMessages`/`parseCritique` in `lib/ai/transform-request.ts` — leave in the tree (superseded, removed by a later cleanup plan). Do not delete here. *(Update 2026-07-05: that cleanup has since shipped — these files/functions are deleted.)*
- `app/api/ai/transform/route.ts`, `lib/ai/use-ai-transform.ts` — the selection-transform flow is unrelated; do not touch.
- The owner-only ownership gates and any 010 access logic.
- Anything streaming — the review route is a single JSON response.

## Git workflow

- Branch: `advisor/011-ai-reviewer` (or the repo's branch convention if evident).
- Commit per phase (A, then B) after its gates pass. Conventional commits, e.g. `feat: AI reviewer leaves real anchored comments` — NO AI attribution, NO `Co-Authored-By` (see `git log` for the project's style).
- Do NOT push or open a PR unless the operator instructed it.

---

## PHASE A — AI comments (structured output → anchored comment creation)

> Owner invokes "AI review" on their own un-shared doc → POST the markdown → the
> model returns the JSON schema → for each comment, resolve its anchor against the
> LIVE canonical markdown via 010's `locateAnchor`, then create a real comment via
> 010's comment-creation mutation attributed to the synthetic AI reviewer. Drop +
> count unlocatable comments. The owner reads them in 010's comment panel / review
> surface, exactly like human comments.

### Phase A scope

**In scope**: `lib/ai/config.ts`, `lib/ai/review.ts` (+ test), `app/api/ai/review/route.ts`, `lib/ai/use-ai-review.ts` (comments path only), `components/ai/ai-review-panel.tsx`, `components/studio-shell.tsx` (wire entry point + gate + mount panel; unmount `CritiquePanel`), `lib/keyboard/actions.ts` (relabel `ai-critique`). Out of scope for A: suggestions (`suggestions: []` ignored in A — parse them but do nothing with them yet), `lib/ai/review-apply.ts`.

### Phase A Step 0 — confirm plan 010's primitives exist (DO THIS FIRST)

Run, from repo root:

```
test -f lib/review/anchor.ts && echo "anchor OK" || echo "anchor MISSING"
test -f convex/review.ts && echo "review.ts OK" || echo "review.ts MISSING"
grep -n "createAnchor\|locateAnchor" lib/review/anchor.ts
grep -n "comments\b" convex/schema.ts
grep -n "export const \(add\|create\)" convex/review.ts | grep -i comment
grep -n "reviewerAppend\|reviewBranches" convex/review.ts
```

You need ALL of: `lib/review/anchor.ts` exporting `createAnchor` + `locateAnchor`; a `comments` table in `convex/schema.ts`; a comment-creation mutation in `convex/review.ts` (`comments.add` or `comments.create`); `reviewerAppend` + `reviewBranches` (needed for Phase B, but confirm now).

Then confirm the **author/origin parameterization** (010 cross-cutting rule b): inspect the comment-creation mutation's `args`. It must accept an OPTIONAL attributed-author override (e.g. `authorName?` AND a synthetic `authorUserId?` / author id), not derive author solely from `identity`. Likewise `reviewerAppend` must accept an optional `origin` override (or otherwise let the AI branch be tagged `ai:review:<model>`).

**Verify**: all primitives present AND the comment-creation mutation exposes an optional author override.
**STOP** if any primitive is missing → "plan 010 not implemented; 011 is blocked." **STOP** if the comment-creation/reviewer-append mutations do NOT accept optional author/origin params → "plan 010's programmatic seam is not parameterized per its own cross-cutting rule (b); 010 must expose the author/origin override before 011 can attribute AI feedback. Do not patch 010's mutations from this plan." (See STOP conditions.)

### Phase A Step 1 — add the review token cap

In `lib/ai/config.ts`, after `AI_CRITIQUE_MAX_TOKENS` (line 27), add:

```ts
/** Cap output for the AI review pass — a structured list of anchored comments +
 *  edits, not an essay. Larger than critique because each item carries a verbatim
 *  quote + body. */
export const AI_REVIEW_MAX_TOKENS = 2400;
```

**Verify**: `bun run typecheck` → exit 0.

### Phase A Step 2 — `lib/ai/review.ts`: prompt builder, parser, identity

Create `lib/ai/review.ts`. Model the parser tolerance EXACTLY on `parseCritique` (`lib/ai/transform-request.ts:71-99`): strip a ```` ```json ```` fence, slice first `{`…last `}`, `JSON.parse` in a try/catch returning a safe default, validate each array item's required field types, drop malformed items, never throw.

Define and export:

```ts
import { AI_CHAT_MODEL } from "./config";

export type ReviewRequestBody = { text: string };

export type AiReviewComment = {
  quote: string;
  prefix?: string;
  suffix?: string;
  category?: string;
  body: string;
};
export type AiReviewSuggestion = {
  quote: string;
  prefix?: string;
  suffix?: string;
  replacement: string;
  rationale?: string;
};
export type AiReviewResult = {
  comments: AiReviewComment[];
  suggestions: AiReviewSuggestion[];
};

/** Stable synthetic attribution for AI-authored review feedback. */
export const AI_REVIEWER_AUTHOR_ID = "ai:reviewer";
export const AI_REVIEWER_AUTHOR_NAME = `AI · ${modelLabel(AI_CHAT_MODEL)}`; // e.g. "AI · GLM 5.2"
/** Branch origin tag for the AI suggestion branch (Phase B). */
export function aiReviewOrigin(): string { return `ai:review:${AI_CHAT_MODEL}`; }

export function buildReviewMessages(body: ReviewRequestBody): ChatMessage[];
export function parseReview(raw: string): AiReviewResult; // {comments:[],suggestions:[]} when unparseable
```

`modelLabel` is a tiny pure helper mapping `"z-ai/glm-5.2"` → `"GLM 5.2"` (split on `/`, take the last segment, prettify); keep it simple and unit-test it.

The **system prompt** (`buildReviewMessages`) MUST instruct the model to:
- Act as a sharp, kind developmental editor leaving feedback like a human reviewer.
- Return ONLY a JSON object with keys `comments` and `suggestions` exactly matching the committed schema (spell out the field names + types in the prompt).
- For EVERY `quote`: **copy the exact verbatim substring from the provided text** — no paraphrase, no normalization, no added/removed Markdown, no ellipsis. State that if `quote` is not an exact substring it will be discarded.
- Include `prefix`/`suffix` (≤ ~40 chars of surrounding text) when the quote is short or might repeat.
- `comments` point at something specific (what's weak/unclear/dragging and why); `suggestions` propose a concrete `replacement` for the quoted span.
- Output ONLY the JSON object — no prose, no fence required (the parser tolerates a fence but the prompt should ask for raw JSON).

`parseReview` validation rules: a comment item counts only if `quote` and `body` are non-empty strings; a suggestion item counts only if `quote` and `replacement` are non-empty strings; optional fields are kept only when they are strings. Unknown extra keys are ignored. Missing `comments`/`suggestions` arrays default to `[]`.

**Verify**: `bun run typecheck` → exit 0.

### Phase A Step 3 — `lib/ai/review.test.ts`: parser + prompt tests

Create `lib/ai/review.test.ts`, modeled structurally on `lib/ai/transform-request.test.ts`. Cases (all pure, vitest `describe`/`it`):
- `buildReviewMessages` starts with a system message that (a) demands a JSON object with `comments` and `suggestions`, and (b) instructs verbatim `quote` copying (assert with regex on the system content, e.g. `/verbatim/i`, `/exact substring/i`, `/comments/`, `/suggestions/`); and the user message is the provided text.
- `parseReview` parses a clean JSON object with both arrays.
- `parseReview` parses JSON wrapped in a ```` ```json ```` fence.
- `parseReview` parses JSON with stray prose around it.
- `parseReview` drops malformed items: a comment missing `body`, a suggestion missing `replacement`, an item with a non-string `quote` — all excluded; valid siblings kept.
- `parseReview` returns `{comments:[],suggestions:[]}` for unparseable input (`""`, `"not json"`, `'{"comments":"x"}'`).
- `modelLabel("z-ai/glm-5.2")` → `"GLM 5.2"` (and the identity constant `AI_REVIEWER_AUTHOR_NAME` contains it).

**Verify**: `bunx vitest run lib/ai/review.test.ts` → all pass.

### Phase A Step 4 — `app/api/ai/review/route.ts`

Create the route, mirroring `app/api/ai/critique/route.ts` line-for-line in structure (NON-streaming):
- `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`
- `requireUser()` → 401 if null.
- Parse body as `ReviewRequestBody`; 400 if invalid JSON or `text` missing/empty.
- `openRouter()` in try/catch → 503 on throw.
- `client.chat.completions.create({ model: AI_CHAT_MODEL, max_tokens: AI_REVIEW_MAX_TOKENS, messages: buildReviewMessages(body), reasoning: { enabled: false } }, { signal: req.signal })`.
- `const result = parseReview(completion.choices?.[0]?.message?.content ?? "")`.
- `return Response.json(result)`.
- Error mapping identical to critique: `AbortError` → 499; other → 502.

**Verify**: `bun run typecheck` → exit 0; `bun run build` → exit 0 (the route compiles).

### Phase A Step 5 — `lib/ai/use-ai-review.ts` (comments path)

Create the client hook, modeled on `lib/ai/use-rag.ts`'s fetch pattern + `lib/ai/use-ai-transform.ts`'s state machine. It:
1. Takes `{ documentId, getDocMarkdown: () => string }`.
2. On `run()`: read `getDocMarkdown()` (the live canonical markdown — same string `studio-shell`'s `getActiveMarkdown` returns); abort any in-flight request via `AbortController`.
3. `fetch("/api/ai/review", {method:"POST", headers, body: JSON.stringify({ text }), signal})`; map `401`→"Sign in to use AI"; parse `AiReviewResult`.
4. **Comments**: capture the markdown sent (`const docAtRequest = text`). For each `comment`, build an anchor object and resolve it against the LIVE markdown:
   - Build an anchor from the AI fields. Preferred: locate `comment.quote` in `docAtRequest` to get a `from` and call 010's `createAnchor(docAtRequest, from, from + quote.length)` so the anchor's prefix/suffix/offsetHint are computed by 010's own util (keeps the anchor shape canonical). If `quote` is not found in `docAtRequest`, fall back to constructing the anchor object directly from the AI's `{quote, prefix ?? "", suffix ?? "", offsetHint: 0}`.
   - Resolve against the CURRENT live markdown (re-read `getDocMarkdown()` at apply time — it may have shifted since the request): `const loc = locateAnchor(currentMarkdown, anchor)`.
   - If `loc === null` → increment `dropped`, skip. Else → call 010's comment-creation mutation with `{ documentId, anchor, body: comment.body, authorName: AI_REVIEWER_AUTHOR_NAME, authorUserId: AI_REVIEWER_AUTHOR_ID }` (use 010's exact arg names; pass the author override params 010 exposes). Increment `placed`.
5. Return a summary `{ commentsPlaced, commentsTotal, commentsDropped }` (Phase B adds the edit counts). Expose `state: "idle"|"loading"|"done"|"error"`, `summary`, `error`, `run`, `reset`.

Use Convex `useMutation(api.review.<commentCreateFn>)` for the write. Import `locateAnchor`/`createAnchor` from `@/lib/review/anchor`.

**Verify**: `bun run typecheck` → exit 0.

### Phase A Step 6 — `components/ai/ai-review-panel.tsx`

Create the progress/summary panel. Copy `critique-panel.tsx`'s chrome verbatim (fixed inset-y-right `aside`, `recto-panel`, `recto-scrim`, Escape-to-close, focus-restore). Content states:
- `loading` → "Reading your draft and leaving notes…"
- `error` → the error message.
- `done` → "Placed {commentsPlaced} of {commentsTotal} comments." If `commentsDropped > 0`, add: "{commentsDropped} couldn't be anchored and were skipped." A primary button "Open review" that opens 010's comment panel / review surface (call the same action/handler `studio-shell` uses to open it — see Step 7).
- On open, kick off `run()`; abort on close.

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Phase A Step 7 — wire into `studio-shell.tsx`, gated by aiEnabled + 010's no-AI-on-shared gate

In `components/studio-shell.tsx`:
1. Instantiate the hook: `const aiReview = useAiReview({ documentId: activeDocId, getDocMarkdown: getActiveMarkdown });` (place near the other AI hooks ~line 324-336).
2. Add `const [aiReviewOpen, setAiReviewOpen] = useState(false);` near `critiqueOpen` (line 333).
3. Repoint the dispatch: change `case "ai-critique"` (lines 705-707) to open AI review instead — but ONLY when the active doc is the owner's own un-shared doc. Reuse 010's no-AI-on-shared signal (the same boolean 010 wires to gate the other AI entry points; per 010 §"Cross-cutting rule: no AI on shared-for-comment notes", this is "the active document either has any active `documentShares` row (owner side) or was opened as a shared-with-me doc (reviewer side)"). Pseudocode:
   ```ts
   case "ai-critique":
     if (settings.aiEnabled && !isDocSharedOrSh.../* 010 gate */) setAiReviewOpen(true);
     return;
   ```
   If 010 exposed that gate as a hook/value, consume it; if 010 named it differently, grep for how 010 disables the other AI entry points and reuse the SAME condition. Do not invent a parallel gate.
4. In the AI surfaces block (lines 1193-1230, under `{settings.aiEnabled && ( … )}`): **remove the `<CritiquePanel … />` mount** and add `<AiReviewPanel open={aiReviewOpen} review={aiReview} onClose={() => { setAiReviewOpen(false); dispatchFocusEditor(); }} onOpenReview={() => { /* open 010's review surface */ }} />`. Wire `onOpenReview` to whatever opens 010's review surface (a state setter or action 010 added). Keep the `aiEnabled` gate AND ensure the entry point in step 3 also respects the 010 share gate.
5. Remove the now-unused `import { CritiquePanel } …` (line 13) and the `critiqueOpen` state if nothing else uses it. (If removing `critiqueOpen` causes churn, leaving the state unused is acceptable for one commit, but prefer removing the dead `setCritiqueOpen` call sites.)

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0; `bun run build` → exit 0.

### Phase A Step 8 — relabel the action

In `lib/keyboard/actions.ts`, change the `ai-critique` action (lines 217-223): keep `id: "ai-critique"` and `section: "AI"`; set `label: "AI review (comments)…"` and `aliases: ["review", "feedback", "ai review", "comments", "critique", "ai"]`. Keep the `Ctrl+⇧+J` shortcut. (Keeping the id avoids touching the dispatch switch's case label and the palette wiring.)

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0.

### Phase A test plan

- `lib/ai/review.test.ts` — the parser + prompt tests from Step 3 (clean/fenced/loose JSON, dropped-malformed-items, unparseable→empty, `modelLabel`). These are the machine-checkable core of Phase A.
- Anchor resolution + dropped-unlocatable behavior is covered by 010's `lib/review/anchor.test.ts` (locator) — 011 reuses that locator, so no duplicate locator tests. **Do add ONE integration-flavored pure test in `lib/ai/review.test.ts`**: given a parsed `AiReviewResult` with two comments (one whose `quote` exists in a sample markdown, one whose `quote` does not), a small pure helper `resolveComments(markdown, comments)` (extract this into `lib/ai/review.ts` for testability) returns `{ placed: [...], dropped: 1 }` using `locateAnchor`. This proves the drop-and-count contract without Convex.
- Verification: `bunx vitest run lib/ai/review.test.ts` → all pass; `bun run test` → full suite green (no existing test regressed).

### Phase A done criteria (ALL must hold)

- [ ] `bunx convex codegen` exits 0 (no Convex change expected, but run it to be safe).
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run biome` exits 0.
- [ ] `bun run test` exits 0; `lib/ai/review.test.ts` exists and passes (parser cases + resolve-drops-unlocatable case).
- [ ] `bun run build` exits 0.
- [ ] `app/api/ai/review/route.ts` exists, is non-streaming, and reuses `openRouter`/`requireUser`/`AI_CHAT_MODEL`/`reasoning:{enabled:false}` (`grep -n "reasoning" app/api/ai/review/route.ts` → match; `grep -rn "new OpenAI\|new Anthropic\|fetch.*api\." app/api/ai/review/route.ts` → no second provider).
- [ ] The AI-review entry point is gated by `settings.aiEnabled` AND 010's no-AI-on-shared condition (`grep` in `studio-shell.tsx` shows the entry point checks both).
- [ ] AI comments are created via 010's comment-creation mutation with the synthetic author override — NOT via a new mutation (`grep -rn "defineTable\|mutation(" lib/ai/ app/api/ai/review/` → no new Convex tables/mutations in 011's files).
- [ ] `CritiquePanel` is no longer mounted (`grep -n "CritiquePanel" components/studio-shell.tsx` → no JSX mount; import removed).
- [ ] Only files in the Phase A In-scope list are modified (`git status`).

---

## PHASE B — AI tracked-change suggestions (AI suggestion branch via reviewerAppend)

> Apply each `quote→replacement` suggestion onto an AI suggestion branch using
> 010's `reviewerAppend` path (origin `ai:review:<model>`). The owner reviews the
> branch's word-level diff and accepts/rejects it in 010's review surface, exactly
> like a human reviewer's branch.

### Phase B scope

**In scope**: `lib/ai/review-apply.ts` (+ test), extend `lib/ai/use-ai-review.ts` (suggestions path), extend `components/ai/ai-review-panel.tsx` (edit counts in the summary). No new route (the same `/api/ai/review` already returns `suggestions`). No new Convex tables/mutations (reuse 010's `reviewerAppend`/`reviewBranches`).

### Phase B Step 1 — `lib/ai/review-apply.ts` (pure edit application)

Create the pure module that turns resolved `quote→replacement` edits into new markdown:

```ts
import { locateAnchor, type Anchor } from "@/lib/review/anchor"; // 010's types/fn

export type ResolvedEdit = { from: number; to: number; replacement: string };

/** Resolve one suggestion's anchor against `markdown`; null if unlocatable. */
export function resolveEdit(
  markdown: string,
  anchor: Anchor,
  replacement: string,
): ResolvedEdit | null;

/** Apply a batch of suggestions to `markdown`, resolving each via locateAnchor.
 *  Skips unlocatable AND overlapping edits (later overlapping edit dropped).
 *  Applies non-overlapping edits right-to-left so earlier offsets stay valid.
 *  Returns the new markdown + counts. PURE. */
export function applyEdits(
  markdown: string,
  edits: { anchor: Anchor; replacement: string }[],
): { markdown: string; placed: number; dropped: number };
```

Algorithm for `applyEdits`:
1. Resolve each edit via `resolveEdit` (which calls `locateAnchor`). Collect resolved `{from,to,replacement}`; count `null`s as dropped.
2. **Overlap handling**: sort resolved edits by `from`. Walk in order; if an edit's `[from,to)` overlaps a previously KEPT edit's range, DROP it (count as dropped) — ambiguous/overlapping edits are never both applied.
3. Apply the kept edits to the markdown from highest `from` to lowest (right-to-left) so each splice doesn't invalidate earlier offsets.
4. Return `{ markdown: result, placed: keptCount, dropped }`.

Use 010's `Anchor` type and `locateAnchor` — do not redefine them.

**Verify**: `bun run typecheck` → exit 0.

### Phase B Step 2 — `lib/ai/review-apply.test.ts`

Create pure tests (model on `lib/history/diff.test.ts`). Cases:
- Single `quote→replacement` on unique quote → markdown spliced correctly; `placed:1, dropped:0`.
- Two non-overlapping edits → both applied (verify right-to-left ordering didn't corrupt offsets); `placed:2`.
- An edit whose quote is absent from the markdown → `locateAnchor` null → dropped; others still applied.
- Two overlapping edits (same/overlapping span) → only one applied, the other dropped; `placed:1, dropped:1`.
- Empty edits → markdown unchanged, `placed:0, dropped:0`.

**Verify**: `bunx vitest run lib/ai/review-apply.test.ts` → all pass.

### Phase B Step 3 — extend `lib/ai/use-ai-review.ts` (build the AI suggestion branch)

After the comments path (Phase A), add the suggestions path:
1. From the parsed `AiReviewResult.suggestions`, build an `edits` array: for each, build an `Anchor` from `{quote, prefix, suffix}` the same way as comments (prefer `createAnchor` at the located offset in the request markdown; fall back to a directly-constructed anchor).
2. Compute the merged markdown: `const { markdown: branchMarkdown, placed: editsPlaced, dropped: editsDropped } = applyEdits(currentMarkdown, edits);`.
3. If `editsPlaced > 0`, push `branchMarkdown` onto an AI suggestion branch via 010's `reviewerAppend` path, attributed to the AI reviewer:
   - The branch is created off the owner's current node, origin `aiReviewOrigin()` (`ai:review:<model>`), exactly as a human suggester branch would be — but the CALLER is the owner. Use 010's `reviewerAppend` (or whatever 010 named the programmatic reviewer-append entry) with the author/origin override params. The owner is the authenticated caller; the *attributed origin* is `ai:review:<model>`.
   - **v1: one node carrying the full merged markdown for the branch** (matches 010's branch-level accept granularity — 010 Phase C "Accept = additive merge forward … Branch-level for v1"). The branch head's materialized markdown IS `branchMarkdown`; the owner's review surface diffs branch-head vs. live-current via 010's `getBranchDiff` + `diffRuns`.
   - If 010's `reviewerAppend` is patch-based (parent + patch), construct the single patch as `{ from: 0, to: currentMarkdown.length, insert: branchMarkdown }` (mirror the restore patch shape in `convex/versions.ts` referenced by 010), with `snapshot: branchMarkdown` so it materializes in one hop. Use whatever arg shape 010's mutation actually requires — read its signature.
4. Extend the returned summary with `{ editsPlaced, editsTotal, editsDropped, branchId? }`.

**Critical isolation**: the suggestion edits go onto a BRANCH via `reviewerAppend` — they must NOT touch `documents.markdown`/`documents.currentNodeId` and must NOT use the client `commitProgrammatic` (which advances the owner's spine). 010's `reviewerAppend` guarantees the pointer-free append; rely on it. (`grep -n "commitProgrammatic\|updateMarkdown\|updateCurrentNodeId" lib/ai/use-ai-review.ts` → no matches.)

**Verify**: `bun run typecheck` → exit 0.

### Phase B Step 4 — extend the panel summary

In `components/ai/ai-review-panel.tsx`, extend the `done` state to also show edits: "Placed {commentsPlaced} of {commentsTotal} comments and {editsPlaced} of {editsTotal} edits." If `editsDropped > 0`, mention it. The "Open review" button now also surfaces the AI suggestion branch (it already opens 010's review surface, which lists open branches — no extra wiring needed).

**Verify**: `bun run typecheck` → exit 0; `bun run biome` → exit 0; `bun run build` → exit 0.

### Phase B test plan

- `lib/ai/review-apply.test.ts` — the five cases in Step 2 (single splice, two non-overlapping, unlocatable-dropped, overlapping-dropped, empty).
- The branch creation itself goes through 010's `reviewerAppend`, whose isolation (owner doc untouched; accept additive) is proven by 010's `lib/review/access.test.ts`. 011 does not re-prove that; it relies on it. (If you want belt-and-suspenders, the `applyEdits` test already proves the content correctness; the Convex isolation is 010's.)
- Verification: `bunx vitest run lib/ai/review-apply.test.ts` → pass; `bun run test` → full suite green.

### Phase B done criteria (ALL must hold)

- [ ] `bunx convex codegen` exits 0.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run biome` exits 0.
- [ ] `bun run test` exits 0; `lib/ai/review-apply.test.ts` exists and passes (incl. overlapping-dropped + unlocatable-dropped).
- [ ] `bun run build` exits 0.
- [ ] The suggestion path creates an AI branch via 010's `reviewerAppend` with origin `ai:review:<model>` and NEVER writes the owner doc (`grep -n "commitProgrammatic\|updateMarkdown\|updateCurrentNodeId\|defineTable\|mutation(" lib/ai/use-ai-review.ts lib/ai/review-apply.ts` → no matches).
- [ ] Unlocatable and overlapping edits are dropped and counted, never mis-applied (covered by `review-apply.test.ts`).
- [ ] The owner can accept/reject the AI suggestion branch in 010's review surface (manual check: run the flow, confirm the branch appears with a word-level diff and Accept/Reject work).
- [ ] Only files in the Phase B In-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 011 updated.

---

## Test plan (overall)

New test files (all under `lib/**` so vitest's `include` picks them up):
- `lib/ai/review.test.ts` — pure: `buildReviewMessages` (demands JSON + verbatim quote), `parseReview` (clean/fenced/loose JSON, dropped-malformed-items, unparseable→`{comments:[],suggestions:[]}`), `modelLabel`, and `resolveComments` drop-and-count via `locateAnchor`. Model on `lib/ai/transform-request.test.ts`.
- `lib/ai/review-apply.test.ts` — pure: `applyEdits` (single splice, two non-overlapping right-to-left, unlocatable-dropped, overlapping-dropped, empty). Model on `lib/history/diff.test.ts`.

Existing tests must keep passing: `bun run test` runs the full vitest suite + the bun convex spike test. This plan must not break any existing test.

## Done criteria (whole plan — machine-checkable)

ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `bun run biome` exits 0.
- [ ] `bun run test` exits 0; `lib/ai/review.test.ts` + `lib/ai/review-apply.test.ts` exist and pass.
- [ ] `bun run build` exits 0.
- [ ] AI feedback is created EXCLUSIVELY through plan 010's primitives — no new Convex table/mutation in 011 (`grep -rn "defineTable\|export const.*mutation(" lib/ai/ app/api/ai/review/` → no matches; the only Convex code 011 adds is the route's *calls* to 010's mutations from the client hook).
- [ ] No new AI provider/SDK/key (`grep -rn "new OpenAI\|new Anthropic\|@anthropic\|openai.com\|generativeai" lib/ai/review.ts lib/ai/use-ai-review.ts app/api/ai/review/route.ts` → no matches; provider stays OpenRouter via `openRouter()`).
- [ ] The suggestion path never writes the owner doc (`grep -rn "commitProgrammatic\|updateMarkdown\|updateCurrentNodeId" lib/ai/use-ai-review.ts lib/ai/review-apply.ts` → no matches).
- [ ] `plans/010-review-collaboration.md`, `convex/review.ts`, `convex/schema.ts`, `lib/review/anchor.ts`, `components/review/review-surface.tsx` are NOT modified by 011 (`git diff --stat 31a505c..HEAD -- convex/review.ts convex/schema.ts lib/review/anchor.ts components/review/review-surface.tsx plans/010-review-collaboration.md` → empty).
- [ ] Only files in the per-phase In-scope lists are modified (`git status`); `plans/README.md` is touched only to update the 011 status row (the orchestrator owns the index — do not edit other rows).

## STOP conditions

Stop and report back (do not improvise) if:

- **Plan 010's primitives are not present** (Phase A Step 0): `lib/review/anchor.ts` (`createAnchor`/`locateAnchor`), the `comments` table + comment-creation mutation, `reviewerAppend` + `reviewBranches`, and the owner review surface must all exist. If any is missing → "plan 010 not implemented; 011 is a hard dependency and is blocked." Do NOT build 010's primitives inside 011.
- **Plan 010's comment-creation / reviewer-append seam is not parameterized for the AI author/origin** (Phase A Step 0). 010's own cross-cutting rule (b) mandates optional author/origin override params on these mutations so AI feedback can be attributed to the synthetic reviewer while the caller stays the owner. If 010 shipped without them, 011 cannot attribute AI comments/branches correctly → STOP and report that 010 must expose the override (it is 010's responsibility per its cross-cutting rule). Do NOT silently patch 010's mutations from this plan.
- **The model cannot reliably return locatable verbatim quotes** after a genuine attempt (you've iterated the prompt and a real GLM 5.2 call still produces quotes that mostly don't `locateAnchor`). DO NOT fall back to LLM-supplied character offsets — they are unreliable and would mis-anchor. STOP and report; the feature's correctness depends on verbatim quotes.
- **Anchoring would silently mis-place or lose feedback** — if you cannot guarantee the drop-and-count contract (unlocatable comments/edits are skipped and counted, never mis-anchored), STOP rather than ship anchoring that vanishes or lands on the wrong text.
- **Suggestion edits overlap ambiguously and `applyEdits` cannot decide** — the committed rule is "drop the later overlapping edit and count it." If a real case needs something smarter (interleaved/nested edits) you can't resolve cleanly, STOP and report rather than guessing a merge.
- The code at any "Current state" excerpt doesn't match the live file (drift since `31a505c`, EXCLUDING the 010-created files which are expected to appear) — re-verify before proceeding; on a real mismatch, STOP.
- A step's verification fails twice after a reasonable fix attempt.
- A fix appears to require touching an out-of-scope file (especially `convex/review.ts`, `lib/review/anchor.ts`, or `plans/010-review-collaboration.md`).

## Maintenance notes

For the human/agent who owns this after it lands:

- **Tool-calling is the documented future upgrade.** v1 uses one structured-output round-trip. A future version could define `create_comment`/`suggest_edit` tools and let GLM 5.2 call them in a loop — more flexible (the model can probe the doc, ask for more context) but stateful and non-deterministic. The structured schema here maps 1:1 onto those tool args, so the upgrade is additive.
- **Per-edit (multi-node) suggestion branches are deferred.** v1 puts the full merged markdown on ONE branch node (matching 010's branch-level accept). To let the owner accept individual AI edits, append each `quote→replacement` as its own branch node and pair with 010's deferred per-hunk accept (010 Maintenance notes). The `applyEdits` overlap logic already isolates non-overlapping edits, so splitting into per-edit nodes is mechanical. **Update 2026-07-05:** the owner can now accept individual AI edits — per-hunk accept shipped (`00f9e96`/`3a5119d`, `convex/review.ts → acceptHunks`); each non-overlapping AI edit surfaces as its own hunk, so multi-node branches were not needed.
- **The optional preview-then-place fork** (Design decision 8) is a switchable setting if built; v1 default is auto-place. If a user complains AI comments "appear without asking," wire the preview setting rather than changing the default.
- **The model identity string** (`AI_REVIEWER_AUTHOR_NAME`, `aiReviewOrigin()`) derives from `AI_CHAT_MODEL`. If the model is swapped in `lib/ai/config.ts`, the AI reviewer's displayed name and branch origin change automatically — confirm the review surface renders the new name acceptably.
- **Superseded critique cleanup is deferred.** `components/ai/critique-panel.tsx`, `app/api/ai/critique/route.ts`, and `buildCritiqueMessages`/`parseCritique` are left in the tree by this plan. A follow-up cleanup plan should remove them once the AI-review flow is proven in use. **Update 2026-07-05:** this cleanup shipped — the critique files/functions are deleted and the last residue (dead constant + stale comments) was removed by plan 019.
- **What a reviewer should scrutinize in the PR**: that the review route adds no second provider and no Convex write; that AI comments/branches are created ONLY through 010's mutations with the synthetic author override (caller is still the owner); that the suggestion path never reaches `commitProgrammatic`/`updateMarkdown`/`updateCurrentNodeId`; that unlocatable/overlapping feedback is dropped-and-counted (never mis-anchored); that the AI-review entry point respects BOTH the `aiEnabled` setting and 010's no-AI-on-shared gate.
