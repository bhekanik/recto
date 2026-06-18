# Plan 009: AI assistance that fits Recto — reversible transforms, an editorial critique panel, and RAG over the writer's own drafts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in a "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This plan is PHASED and the phases are independently shippable.** Do the
> **SPIKE first, then STOP and report for review.** Do NOT start Phase A until
> a human signs off on the spike. The spike de-risks the entire feature; if it
> fails, the product phases are not worth building as designed.
>
> **Drift check (run first)**:
> ```
> git diff --stat a25c506..HEAD -- \
>   convex/docNodes.ts convex/documents.ts convex/schema.ts convex/crons.ts \
>   convex/retention.ts convex/versions.ts convex/history.ts \
>   lib/history/use-document-history.ts lib/history/patch.ts lib/history/materialize.ts \
>   lib/editor/handle.ts lib/editor/format.ts lib/modes/types.ts \
>   lib/keyboard/actions.ts lib/workspace/workspace-context.tsx \
>   components/command-palette.tsx components/selection-toolbar.tsx \
>   components/history/history-panel.tsx components/studio-shell.tsx \
>   lib/editor/milkdown/selection-toolbar-view.tsx package.json
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none (independent of plans 001/002; they touch the history panel UI but not the commit path or Convex actions)
- **Category**: feature (direction)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

Recto's defining asset is a **branching, append-only undo tree** (`docNodes`
DAG) where every edit is an immutable node and navigation is non-destructive.
That data model makes AI a natural fit *only if it is built to respect it*: an
AI edit that lands as a **child node of the current node** is reversible by
construction — accept = keep the node, reject = `undo()` to the parent. This is
the killer fit and the thing no generic "AI writing assistant" has, because
they mutate the buffer destructively.

**Guiding stance — AUGMENT, DON'T REPLACE.** Every AI feature here is **opt-in,
keyboard-summoned, and never ambient.** We deliberately do NOT build always-on
ghost text, inline autocomplete, or full-draft generation. Those clash with
Recto's "the tool disappears" ethos and with the 2025–26 backlash against AI
"slop". The features are: (A) reversible selection transforms, (B) a read-only
editorial critique panel, (C) retrieval over the writer's own past drafts. All
three are gated behind a master "AI features" setting that defaults **off**.

This is the largest and riskiest feature in the backlog. The risk is almost
entirely in the foundation: can a Convex action call Claude and stream a result
to the client, and can that result be committed as an undo-tree node **without
breaking the debounced sync contract or the cursor-ownership rules**? That is
what the SPIKE proves before any product UI is built.

## Background you must internalize (the commit-path invariant)

The single most important thing to understand: **the live editor owns its text;
Convex is the only *write* path; history is additive and never disturbs the edit
path.** An AI transform is, mechanically, *exactly a programmatic edit recorded
as a new node* — the same shape as `restoreVersion` in
`lib/history/use-document-history.ts`. Study that function (excerpt below). It is
your template for committing an AI result.

There is **no separate "insert an AI node" API to add.** You reuse the existing
grouping-controller path: flush the controller, `seed()` the new markdown into
the editor programmatically, `record(...)` it (which computes the patch and
appends a child node via `onCommit` → `appendNode` mutation), then flush again.
The undo tree, the `updateCurrentNodeId` pointer write, the cross-device union
merge, and `history-panel.tsx`'s rendering all then work **for free**.

## Current state

### Repo facts

- **Stack**: Next.js 16 (Bun, React 19), Convex (`convex@^1.40.0`), Clerk auth,
  Tailwind v4 + shadcn, Biome, Vitest. Single-user, dark-only, OKLCH tokens.
- **No Convex actions exist yet** (`grep -rln "action(" convex/` → empty) and
  **no `convex/http.ts`**. This feature introduces the first Convex action.
- **`@anthropic-ai/sdk` is NOT installed** (`grep -i anthropic package.json` →
  empty). You will add it.
- **Convex vector search + file storage are UNUSED today.** Crons are used only
  for retention (`convex/crons.ts` → `convex/retention.ts`). Phase C is the
  first use of `vectorIndex` and the first scheduled *action* (vs the existing
  scheduled *internalMutation*).
- `convex.json` is `{ "functions": "convex/" }` — default layout.

### The commit path (THE place AI edits land) — `convex/docNodes.ts`

`append` is idempotent on `(documentId, nodeId)`; it NEVER updates an existing
node (append-only) and NEVER writes `currentNodeId` (that is a separate write).
Current signature + handler (`convex/docNodes.ts:40-74`):

```ts
export const append = mutation({
	args: {
		documentId: v.id("documents"),
		nodeId: v.string(),
		parentNodeId: v.union(v.string(), v.null()),
		patch: v.string(),
		snapshot: v.optional(v.string()),
		selection: v.union(
			v.object({ anchor: v.number(), head: v.number() }),
			v.null(),
		),
		origin: v.string(),
		createdAt: v.number(),
	},
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		const existing = await ctx.db
			.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.nodeId),
			)
			.unique();
		if (existing) return { nodeId: args.nodeId, duplicate: true };
		await ctx.db.insert("docNodes", { /* …all fields… */ });
		return { nodeId: args.nodeId, duplicate: false };
	},
});
```

A node stores its delta as a `patch` (a contiguous text replace) and, on the
root + every Nth node, a full `snapshot`. `parentNodeId` is the DAG edge; `null`
only on the root. `origin` is a free-form string (device id today; `"server"`
on root, `"restore"` on restore). **AI nodes will use `origin: "ai"`** so the
history panel and tests can recognize them.

### The patch codec — `lib/history/patch.ts`

A node's `patch` is `JSON.stringify({ from, to, insert })`, a single contiguous
replace relative to the parent's materialized markdown. The contract
(`lib/history/patch.ts:24-57`):

```ts
// applyPatch(parent, encodePatch(computePatch(parent, next))) === next, exactly
export function computePatch(parentMarkdown, nextMarkdown): TextPatch { /* LCP/LCS trim */ }
export function applyPatch(parentMarkdown, patchRaw): string {
	const { from, to, insert } = decodePatch(patchRaw);
	return parentMarkdown.slice(0, from) + insert + parentMarkdown.slice(to);
}
export const SNAPSHOT_EVERY_N = 50;
```

**You do not call `computePatch` directly for an AI edit.** The grouping
controller computes the patch from the seeded markdown for you (see next). You
*will* unit-test a small pure helper that builds the *replaced-full-document
markdown* from `(originalDoc, selectionRange, aiText)` — see Test plan.

### How the client records a node — `lib/history/use-document-history.ts`

`useDocumentHistory` returns a `HistoryController`
(`lib/history/use-document-history.ts:26-39`):

```ts
export type HistoryController = {
	nodes: HistoryNode[];
	currentNodeId: string | null;
	canUndo: boolean; canRedo: boolean;
	undo: () => void; redo: () => void;
	navigateTo: (nodeId: string) => void;
	restoreVersion: (versionNodeId: string) => void;
	recordChange: (opts?: { structural?: boolean }) => void;
	flush: () => void;
	tagVersion: (label: string, kind?: "auto" | "manual") => Promise<void>;
	materializeAt: (nodeId: string) => string | null;
};
```

**`restoreVersion` is your exact template for an AI commit** — it seeds new
markdown and records it as a child node through the grouping controller
(`lib/history/use-document-history.ts:316-333`):

```ts
const restoreVersion = useCallback((versionNodeId: string) => {
	const controller = controllerRef.current;
	if (!controller || !nodesById.has(versionNodeId)) return;
	let markdown: string;
	try { markdown = materialize(versionNodeId, nodesById); } catch { return; }
	controller.flush();
	const handle = getHandleRef.current();
	handle?.seed(markdown, { programmatic: true });   // re-project into the live editor
	controller.record(markdown, null, { structural: true }); // compute patch + append child node
	controller.flush();                                // commit immediately (no debounce wait)
}, [nodesById]);
```

The `onCommit` callback (`:143-171`) is what turns a recorded change into an
`appendNode` mutation + an optimistic local node + a debounced
`updateCurrentNodeId` pointer write + a debounced auto-version. `undo()`
(`:281-288`) navigates to `parentNodeId`. **This is the reject path: after an AI
node lands, `undo()` returns to the pre-AI text.**

Note the `navigatingRef` guard (`:212`, `:253-269`): while a programmatic
re-seed is in flight, `recordChange` is suppressed so navigation never grows the
tree. Your AI commit must NOT be inside a navigation; it is a genuine new edit,
so it goes through `controller.record(...)` (like `restoreVersion`), not
through `navigateTo`.

### The sync contract you must not fight — `lib/sync/use-document-sync.ts`

This is **CRITICAL** and a STOP-risk. `useDocumentSync` debounces editor changes
to `documents.updateMarkdown` (500 ms, 5 s maxWait) and idle-rehydrates on
remote writes. Two rules an AI edit must respect:

1. **The editor is the source of truth for text.** An AI edit must go *into the
   editor via `handle.seed(...)`* and then flow out through the normal change
   handler. Do NOT write `documents.updateMarkdown` (or `documents.markdown`)
   directly from the AI action — that would race the debounced client write and
   the LWW pointer.
2. **Cursor / focus ownership** (`use-document-sync.ts:288-303`): when the editor
   is focused, remote writes are NOT applied (local edits win). The combined
   change handler in `workspace-context.tsx:129-132` calls BOTH `sync.handleEditorChange()`
   and `history.recordChange()`. The `restoreVersion` path already navigates this
   correctly by seeding programmatically; mirror it exactly.

The combined wiring you depend on (`lib/workspace/workspace-context.tsx:116-132`):

```ts
const history = useDocumentHistory({ documentId, getEditorHandle, /* server* */, enabled, origin: getDeviceOrigin() });
const handleEditorChange = useCallback(() => { syncChange(); recordHistory(); }, [syncChange, recordHistory]);
```

`useDocumentHistoryFor(documentId)` (`workspace-context.tsx:74-78`) returns the
live `HistoryController` for a document from the workspace registry. The history
panel already uses it (`components/history/history-panel.tsx:76`). **Your AI UI
gets the controller the same way.**

### The editor handle — `lib/editor/handle.ts` + `lib/modes/types.ts`

```ts
export type EditorHandle = {
	seed: (markdown: string, opts?: { programmatic?: boolean }) => void;
	getCanonicalMarkdown: () => string;
	exportCaret: () => CaretPosition;      // { offset, anchor, head }
	importCaret: (caret: CaretPosition) => void;
	focus: () => void; isFocused: () => boolean;
	getRootElement: () => HTMLElement | null;
	runFormat: (command: FormatCommand, opts?: { href?: string }) => void;
};
export type CaretPosition = { offset: number; anchor: number; head: number };
```

`getCanonicalMarkdown()` returns the whole document as canonical Markdown.
`exportCaret()` returns `{ anchor, head }`. **WARNING — verify during the spike
(see STOP conditions):** `anchor`/`head` are the editor's selection endpoints.
In the CodeMirror lenses (raw/vim) these are character offsets into the markdown
source and map directly onto `getCanonicalMarkdown()`. In the Milkdown (rich)
lens they are ProseMirror document positions, which do **not** equal markdown
string offsets. The spike must confirm which lens it runs in and how to obtain
the selected *markdown substring*. **For the spike and Phase A, scope the
transform to the CodeMirror lenses (raw/vim) where `anchor`/`head` are markdown
offsets**, OR derive the selected text from the editor's own selection-to-text
API in rich mode — do NOT assume rich-mode positions are markdown offsets.

### Selection plumbing for Phase A — selection toolbar + command palette

- `lib/editor/milkdown/selection-toolbar-view.tsx` — a Milkdown PluginView that
  mounts `<SelectionToolbar />` (a floating bar) above a non-empty selection via
  `TooltipProvider`.
- `components/selection-toolbar.tsx` — renders `SELECTION_ACTIONS` buttons that
  call `dispatchFormat(action.command)`. Buttons `preventDefault` on
  pointer-down to keep selection/focus.
- `lib/editor/format.ts` — `dispatchFormat(command)` fires a `recto:format`
  CustomEvent the active editor listens for. **This is the pattern for an
  editor-agnostic "do X to the active editor" command** — Phase A's "transform
  selection" can be summoned the same decoupled way.
- `components/command-palette.tsx` — the cmdk palette. It renders `ACTIONS` from
  `lib/keyboard/actions.ts` and calls `onRunAction(id)`. **Add an AI action id
  here** the same way the other actions are added.

### Action registry — `lib/keyboard/actions.ts`

`ActionId` is a string union (`:17-50`); `ACTIONS: ActionDef[]` (`:64+`) is the
single registry both the chord handler and the palette read. Adding an AI
command means: extend `ActionId`, add an `ActionDef` (new `"AI"` section or
reuse an existing section), and handle the new id in `studio-shell.tsx`'s
`onRunAction` switch (`components/studio-shell.tsx:248+`). `SECTION_ORDER`
(`:298-306`) and `ActionSection` (`:8-15`) must include any new section.

### History panel — `components/history/history-panel.tsx`

`nodeLabel(node.patch, node.parentNodeId, node.origin)` (`:258`) labels each
tree row from its patch + origin. AI nodes (`origin: "ai"`) will get a generic
label today; Phase A includes a one-line tweak to `lib/history/diff.ts`
`nodeLabel` so AI nodes read e.g. "AI: tighten" — confirm `nodeLabel`'s current
signature first (it lives in `lib/history/diff.ts`, referenced here).

### Scheduled-action pattern for Phase C — `convex/crons.ts` + `convex/retention.ts`

`convex/crons.ts` (full file):

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.daily(
	"undo-tree retention sweep",
	{ hourUTC: 8, minuteUTC: 0 },
	internal.retention.sweep,
);
export default crons;
```

`convex/retention.ts` is an `internalMutation` invoked by the cron. **Phase C
models its embedding refresh on this**, but Phase C needs a scheduled
*action* (external embedding API call), so it will be an `internalAction` that
fans out to `internalMutation`s for the DB writes (actions cannot touch `ctx.db`
directly — they call mutations/queries via `ctx.runMutation`/`ctx.runQuery`).

### Schema — `convex/schema.ts`

Index + table patterns to copy. `docNodes` uses `.index("by_document",
["documentId"])`. Phase C adds a new `docChunks` table with both a normal index
AND a `vectorIndex` (see Phase C). Current `docNodes` definition
(`convex/schema.ts:28-42`) is the structural exemplar.

### Auth — `convex/documents.ts`

`requireUserId(ctx)` (`:12-20`) returns the Clerk JWT subject or throws;
`requireOwnedDocument(ctx, documentId)` (`:23-33`) asserts ownership. **Every
new query/mutation copies this.** Actions don't get `ctx.db`, so an action does
auth by calling a query/mutation that itself calls `requireOwnedDocument`, or by
reading `ctx.auth.getUserIdentity()` directly inside the action and passing the
verified `userId` into the mutations it calls.

## Decisions (made — with justification)

| Decision | Choice | Why |
|---|---|---|
| Where the Claude call lives | **Convex `action`** (not a Next.js route handler) | The API key already lives in Convex env (`ANTHROPIC_API_KEY`, set via `npx convex env set`); actions run server-side with that env; actions integrate with Convex auth + can call mutations to append nodes in the same trust boundary; no separate Next.js secret plumbing. A route handler would duplicate auth + secret access and sit outside the reactive write path. |
| How streaming reaches the client | **HTTP streaming via a Convex `httpAction`** (`convex/http.ts`) returning a `ReadableStream`, consumed with `fetch` + `ReadableStream` reader on the client. | Convex **queries/mutations/actions are request-response and CANNOT stream incremental output to a `useQuery` subscriber.** Two viable streaming paths exist: (1) an `httpAction` that proxies Claude's SSE stream straight through as the HTTP response body; (2) an action that, while streaming, writes accumulating partial text into a scratch table that the client `useQuery`-subscribes to. **(1) is recommended for the SPIKE** because it is the smallest end-to-end proof and avoids polluting the DB with partial-token churn. The accumulating-table approach (2) is the documented fallback if httpAction streaming is unavailable/unsupported — note it and try it only if (1) fails. **Confirm the current streaming story via the `convex` skill before coding** (see Toolkit). The final committed node still goes through the normal `append` mutation; streaming is display-only. |
| Replace-in-place vs pending-branch | **SWITCHABLE SETTING** (`aiTransformMode: "replace" | "pending"`), default `"pending"` | Genuine A/B UX fork → the repo convention is a remembered toggle, never a hard pick (see `lib/studio/use-studio-settings.ts` "knobs over fixed picks"; user memory: "for A/B design forks in Recto, build a switchable setting"). `"replace"` = the AI node lands as the new tip immediately (accept-by-default; reject = `undo`). `"pending"` = the AI node lands but the UI shows an accept/reject affordance and auto-`undo`s on reject without leaving the tip moved. Both modes commit a real node first (reversible by construction); they differ only in the confirm UX. |
| Master gate | **`aiEnabled` studio setting, default `false`** | AUGMENT-don't-replace + opt-in. When off, no AI actions appear in the palette, no panels mount, no action is callable. |
| Embedding provider (Phase C) | **Voyage (`voyage-3` family) OR Claude — confirm via skill; do NOT hardcode model id or dimensions** | Anthropic recommends Voyage for embeddings; dimensions depend on the chosen model (e.g. voyage-3 is 1024-dim, but VERIFY). The `vectorIndex` `dimensions` MUST exactly match the model output. Use the `claude-api` skill for the current Anthropic/Voyage embedding model + dimension. Store the choice in one constant. Key by NAME only: `VOYAGE_API_KEY` (or reuse `ANTHROPIC_API_KEY` if using Claude embeddings) in Convex env. |
| Chunking strategy (Phase C) | **Paragraph-windowed**: split canonical markdown on blank lines, then greedily pack paragraphs into ~1–2k-char windows with ~1 paragraph overlap; one embedding per window; store `{documentId, nodeId-at-embed-time, charStart, charEnd, text, embedding}`. | Paragraph boundaries are natural prose units and map cleanly to "scroll to this passage" citations. Small corpus → recall + citation is the value, not chat. Keep it pure + unit-tested. |
| When to re-embed (Phase C) | **Scheduled action (cron), modeled on `convex/crons.ts`**, plus an opt-in manual "re-index" command. NOT on every keystroke. | Embedding is an external paid call; debounced/scheduled keeps cost bounded and avoids fighting sync. |

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Add SDK | `bun add @anthropic-ai/sdk` | exit 0; `@anthropic-ai/sdk` under `dependencies` |
| Add Voyage SDK (Phase C only, if used) | `bun add voyageai` (confirm package name via skill first) | exit 0 |
| Install | `bun install` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0, no errors |
| Lint/format | `bun run biome` | exit 0 (runs `biome check .`) |
| Tests | `bun run test` | all pass (vitest run + bun spike test) |
| Targeted test | `bunx vitest run <path>` | all pass |
| Build | `bun run build` | exit 0 |
| Dev (manual / spike runtime check) | `bun run dev` | studio loads; Convex dev deployment connects |
| Set Convex env (you provide the value; never commit it) | `npx convex env set ANTHROPIC_API_KEY <value>` | key set on the dev deployment |
| List Convex env (names only) | `npx convex env list` | `ANTHROPIC_API_KEY` present |
| Convex codegen (after adding functions) | `bun run convex:codegen` | `convex/_generated` updated, exit 0 |

Notes: `bun run biome` reports BOTH lint and format issues; if it flags
formatting, run `bunx biome check --write <files>` then re-run. The Convex dev
server is started by `bun run dev` (`convex dev --start 'next dev --turbopack'`).

## Suggested executor toolkit

- **Invoke the `claude-api` skill** before writing any Claude call. Use it for:
  the current model ids (do NOT guess model names), streaming + cancellation
  patterns with `@anthropic-ai/sdk` (`client.messages.stream(...)` / the
  streaming events), token/usage, and the recommended embedding model + its
  vector dimension (for Phase C's `vectorIndex`). The repo prefers retrieval-led
  over memory-led answers for Claude specifics.
- **Invoke the `convex` skill** (and its vector-search / actions references)
  before writing: the Convex **action** pattern, the **httpAction streaming**
  story and whether it is the current best practice (this gates the spike's
  streaming approach), `vectorIndex` schema config + `ctx.vectorSearch(...)`
  usage, and **scheduled actions / crons** for Phase C. Confirm `vectorIndex` is
  supported on the project's current Convex plan (STOP condition).
- Convex docs for actions, http endpoints, vector search, scheduling are also in
  the Convex skill references; prefer them over memory.

## Scope

### SPIKE — in scope
- `convex/aiTransform.ts` (**create**) — the spike action/httpAction.
- `convex/http.ts` (**create**) — only if the recommended streaming path is an
  httpAction (most likely; confirm via `convex` skill).
- `lib/ai/spike-client.ts` (**create**) — minimal client helper to call the
  action/stream and commit the result through the live `HistoryController`.
- A temporary dev-only trigger (a command-palette action `"ai-spike"` behind the
  `aiEnabled` flag, OR a throwaway button) — **mark it clearly as spike-only**;
  it is removed/replaced in Phase A.
- `package.json` / `bun.lock` — `@anthropic-ai/sdk`.

### Phase A — in scope (after spike sign-off)
- `convex/aiTransform.ts` — productionize the transform action/stream.
- `lib/ai/use-ai-transform.ts` (**create**) — hook: stream a transform of a
  selected span, commit as an undo-tree node via the controller.
- `lib/ai/instructions.ts` (**create**) — the preset instructions (tighten,
  rewrite, expand, fix grammar) + types; pure.
- `lib/ai/apply-transform.ts` (**create**) — pure helper:
  `(doc, range, aiText) => newDoc` (the unit-tested patch-from-AI path).
- `components/ai/ai-transform-popover.tsx` (**create**) — shadcn-composed
  ⌘K-style instruction picker over the selection.
- `lib/keyboard/actions.ts` — add the AI transform action id + def + section.
- `components/command-palette.tsx` — surface it (only when `aiEnabled`).
- `components/selection-toolbar.tsx` — add an AI button (only when `aiEnabled`).
- `components/studio-shell.tsx` — wire the new action id + mount the popover.
- `lib/studio/use-studio-settings.ts` — add `aiEnabled` (default false) +
  `aiTransformMode` (`"pending"` default).
- `lib/history/diff.ts` — extend `nodeLabel` so `origin: "ai"` nodes label nicely.
- Tests: `lib/ai/apply-transform.test.ts`, `lib/ai/instructions.test.ts`.

### Phase B — in scope
- `convex/aiCritique.ts` (**create**) — action returning structured critique.
- `components/ai/critique-panel.tsx` (**create**) — read-only side panel.
- `lib/keyboard/actions.ts`, `components/command-palette.tsx`,
  `components/studio-shell.tsx` — summon + mount (gated on `aiEnabled`).
- Test: mock the action; assert the panel renders feedback and applies NO edits.

### Phase C — in scope
- `convex/schema.ts` — add `docChunks` table + `vectorIndex`.
- `convex/embeddings.ts` (**create**) — `internalAction` (embed via Voyage/Claude)
  + `internalMutation`s (upsert/delete chunks) + a query that runs
  `ctx.vectorSearch`.
- `convex/crons.ts` — add the scheduled re-embed (model on the existing daily cron).
- `lib/ai/chunk.ts` (**create**) — pure chunking; unit-tested.
- `lib/ai/embed-request.ts` (**create**) — pure builder of the embedding request
  payload; unit-tested.
- `components/ai/related-passages-panel.tsx` (**create**) — side panel with
  citations + scroll-to.
- `lib/keyboard/actions.ts`, `components/command-palette.tsx`,
  `components/studio-shell.tsx` — summon + mount (gated on `aiEnabled`).
- Tests: `lib/ai/chunk.test.ts`, `lib/ai/embed-request.test.ts`.

### Out of scope (do NOT touch)
- `convex/retention.ts`, `convex/versions.ts` (restore/materialize write paths) —
  AI never rewrites/erases history; it only *appends*.
- `lib/history/use-document-history.ts`, `lib/history/patch.ts`,
  `lib/history/materialize.ts`, `convex/history.ts` — the commit primitives are
  reused as-is. Do NOT add an "AI append" variant; use `controller.record(...)`.
- `lib/sync/use-document-sync.ts` — never write document markdown from the AI
  action; go through the editor.
- The data shape of `docNodes`/`documents`/`versions`.
- Authorship/provenance dimming of AI spans (iA-style) — a real differentiator,
  but explicitly **deferred** (see Maintenance notes). Mention only.
- Always-on ghost text / inline autocomplete / full-draft generation — out by
  design.

## Git workflow

- Branch: `advisor/009-ai-reversible-assist` (create from `main`).
- Commit per logical unit; conventional-commit style, **NO AI attribution / no
  Co-Authored-By lines**, author = the repo user only. Example from `git log`:
  `feat: add switchable calm color themes`. Suggested commits:
  - SPIKE: `chore: add @anthropic-ai/sdk`, `spike: stream a Claude transform through a Convex action`, `spike: commit the AI result as an undo-tree node`.
  - Phase A: `feat: add aiEnabled + aiTransformMode settings`, `feat: reversible AI selection transform`, `test: cover AI patch + instructions`.
  - Phase B: `feat: editorial critique panel`.
  - Phase C: `feat: RAG over past drafts via Convex vector search`.
- Do NOT push or open a PR unless the operator instructs it.

---

# PHASE 0 — SPIKE (do this, then STOP and report)

**Goal**: prove the full path end-to-end with the smallest possible code:
a Convex action calls Claude via `@anthropic-ai/sdk` using `ANTHROPIC_API_KEY`
from Convex env, **streams** a transformation of a selected span to the client,
and the final result is **committed as a child `docNode`** through the existing
`HistoryController`, such that **`undo()` returns to the parent (reject)** and
the document keeps syncing normally. If any of {streaming through a Convex
action/httpAction, committing as a node without breaking sync/cursor} cannot be
made to work, **STOP and report** — the product phases depend on it.

### Spike Step 0: read the skills

Invoke `claude-api` (model id + `messages.stream` + cancellation) and `convex`
(action vs httpAction streaming; confirm the current recommended streaming
approach; vector-index plan support for later). Write down: the model id you will
use, the streaming API surface, and whether httpAction streaming is the
recommended path. Do NOT proceed on guessed model names.

### Spike Step 1: add the SDK + set the key

```
bun add @anthropic-ai/sdk
```
Then set the key on the Convex **dev** deployment (you supply the value; it is
never written to a file or this plan): `npx convex env set ANTHROPIC_API_KEY <value>`.
Verify with `npx convex env list` → `ANTHROPIC_API_KEY` listed (value not shown).

**Verify**: `grep '"@anthropic-ai/sdk"' package.json` → present under
`dependencies`; `bun run typecheck` → exit 0.

### Spike Step 2: the streaming action

Create `convex/aiTransform.ts`. Following the `convex` skill's current streaming
guidance (most likely an `httpAction` in `convex/http.ts` that returns a
streamed `Response`):

- Authenticate (`ctx.auth.getUserIdentity()`; reject if absent — mirror
  `requireUserId`).
- Read `ANTHROPIC_API_KEY` from `process.env` inside the action.
- Construct the Anthropic client and call the streaming messages API (use the
  exact surface the `claude-api` skill gives; do NOT guess). The user prompt is
  a transform instruction + the selected text span; system prompt instructs
  "return ONLY the rewritten text, no preamble".
- Stream text deltas back to the client (httpAction: pipe Claude's stream into
  the response `ReadableStream`).
- Support cancellation: the client aborts the `fetch` via `AbortController`; the
  action must stop consuming Claude's stream when the request is aborted.

If httpAction streaming is NOT the current recommended/working path, use the
fallback (an `action` that writes accumulating partial text into a scratch row a
`useQuery` subscribes to). Note which path you used in your report.

**Verify (compiles + deploys)**: `bun run convex:codegen` → exit 0; start
`bun run dev` and confirm the Convex dev deployment connects with the new
function present (no deploy error in the console).

### Spike Step 3: commit the streamed result as a node

Create `lib/ai/spike-client.ts` + a spike-only trigger (a palette action
`"ai-spike"` gated on a temporary always-true flag, OR a labeled dev button).
The trigger must, for the active document:

1. Get the `HistoryController` via `useDocumentHistoryFor(activeDocId)` and the
   editor handle via the workspace registry (same path the history panel uses).
2. Get the selected span. **For the spike, run in the raw lens** (CodeMirror,
   where `exportCaret().anchor/head` are markdown offsets). Compute
   `from = min(anchor, head)`, `to = max(...)`, `original = getCanonicalMarkdown()`,
   `selected = original.slice(from, to)`. If `from === to`, no selection — abort.
3. Stream the transform of `selected` (display the partial text somewhere
   trivial — a console log or a fixed div is fine for the spike).
4. On completion, build `newDoc = original.slice(0, from) + aiText + original.slice(to)`.
5. Commit it through the controller **exactly like `restoreVersion`**:
   ```ts
   controller.flush();
   handle.seed(newDoc, { programmatic: true });
   controller.record(newDoc, null, { structural: true });
   controller.flush();
   ```
   (Confirm the controller is exposed for direct `record/flush` calls; if only
   the `HistoryController` public surface is available, add a thin method to it —
   but PREFER not modifying `use-document-history.ts`; instead replicate the
   restore path. If you cannot commit without touching `use-document-history.ts`,
   that is a finding to report, not a silent change.)

**Verify (manual runtime check — this IS the spike's success criterion)**: in
`bun run dev`, in the raw lens, select a sentence, run the spike trigger, and
confirm ALL of:
- [ ] Partial text streams in (not a single blob at the end).
- [ ] The transformed text replaces the selection in the editor.
- [ ] A NEW node appears in the undo-tree panel (open with the history shortcut),
      child of the previous current node, labeled with `origin: "ai"`.
- [ ] **`undo()` (⌘Z / Ctrl+Z) returns to the exact pre-AI text** (reject path).
- [ ] **`redo()` returns to the AI text** (the node persisted, not lost).
- [ ] After the edit, normal typing still autosaves (status bar shows saved) and
      the document is unchanged on reload except for the committed node.
- [ ] Triggering then aborting mid-stream (cancel) leaves the document untouched
      (no partial node committed).

### Spike STOP / report

**STOP and report** after the spike regardless of outcome. In the report state:
1. Which streaming path worked (httpAction vs accumulating table) and any
   Convex-version caveats.
2. The model id used (from `claude-api`).
3. Whether the rich (Milkdown) lens needs a different selection-to-markdown
   approach (you scoped the spike to raw — flag what Phase A needs for rich).
4. Whether committing required touching `use-document-history.ts` (it should
   not).
5. Confirmation of the 8 checklist items above.

**Spike STOP conditions** (report, do not push through):
- Streaming cannot be made to work through any Convex path → the whole feature's
  streaming UX is blocked; report so the operator can choose non-streamed-but-
  reversible as a fallback design.
- Committing the AI result corrupts undo/redo (e.g. the node is orphaned, the
  pointer doesn't advance, or `undo` doesn't return to the pre-AI text).
- The commit fights sync (e.g. the document reverts, a conflict banner appears,
  or the cursor jumps unexpectedly) and the `restoreVersion`-style path does not
  fix it.
- `ANTHROPIC_API_KEY` is not readable in the action's `process.env` (env not set
  on the right deployment).

---

# PHASE A — Selection → reversible transform (after spike sign-off)

Productionize the spike into real UX. Select text → ⌘K-style summon (or the
selection toolbar's AI button) → pick a preset or type an instruction →
streamed result replaces the selection, **committed as an undo-tree node**;
reject = undo. Gated on `aiEnabled`. Respect `aiTransformMode` (`"pending"`
default vs `"replace"`).

### A.1 — Settings

In `lib/studio/use-studio-settings.ts` add (mirror the existing toggle pattern —
type field, `DEFAULTS`, `loadSettings` validator, `StudioSettingsApi`, setter,
returned object — exactly as plan 001 step 3 describes for `diffGranularity`):
- `aiEnabled: boolean` (default `false`).
- `aiTransformMode: "pending" | "replace"` (default `"pending"`).
With setters/togglers. **Verify**: `bun run typecheck` → 0.

### A.2 — Pure transform helper + instructions (TEST-FIRST)

- `lib/ai/instructions.ts`: an array of presets
  `{ id, label, prompt }` for tighten / rewrite / expand / fix-grammar, plus a
  type. Pure.
- `lib/ai/apply-transform.ts`:
  `applyTransform(doc: string, range: {from:number;to:number}, aiText: string): string`
  → `doc.slice(0,from) + aiText + doc.slice(to)`. Guard `from<=to`,
  `0<=from`, `to<=doc.length`; throw on invalid range. This is the
  patch-from-AI-result path — `controller.record` will turn the returned doc into
  a node via `computePatch`.
Write `lib/ai/apply-transform.test.ts` + `lib/ai/instructions.test.ts` first
(see Test plan). **Verify**: `bunx vitest run lib/ai/` → all pass.

### A.3 — The transform hook

`lib/ai/use-ai-transform.ts`: given `documentId`, the editor handle, and the
`HistoryController`, expose `transform(instruction, range)` that streams from the
action, exposes the partial text (for display), and on completion commits via
the restore-style controller path from Spike Step 3. Cancellation via
`AbortController`. In `"pending"` mode, after commit, expose `reject()` (calls
`controller.undo()`) and `accept()` (no-op; the node is already the tip). In
`"replace"` mode, commit and done (undo still rejects).

### A.4 — UI (shadcn-composed, OKLCH, dark-only)

`components/ai/ai-transform-popover.tsx`: a ⌘K-style command input listing the
presets + a free-text instruction, positioned over the selection. Compose
shadcn/cmdk primitives (mirror `components/command-palette.tsx` styling tokens).
While streaming, show the partial result inline and an accept/reject control in
`"pending"` mode. No raw one-off styles — reuse `--color-*`, `--space-*`,
`--radius-*`, `recto-panel`/`recto-item` classes.

### A.5 — Summon wiring

- `lib/keyboard/actions.ts`: add `ActionId` `"ai-transform"`, an `ActionDef`
  (new `"AI"` section; add `"AI"` to `ActionSection` + `SECTION_ORDER`), suitable
  shortcut hint.
- `components/command-palette.tsx`: the AI section renders only when `aiEnabled`.
- `components/selection-toolbar.tsx`: append an AI button (only when `aiEnabled`)
  that opens the popover; keep the `onPointerDown` preventDefault so selection is
  preserved.
- `components/studio-shell.tsx`: handle `"ai-transform"` in `onRunAction`; mount
  the popover; gate everything on `aiEnabled`.

### A.6 — Node labels

In `lib/history/diff.ts`, extend `nodeLabel` so `origin === "ai"` yields a label
like `AI: <instruction>` (store the instruction label, e.g. append it to
`origin` as `"ai:tighten"`, or keep `origin:"ai"` and infer a generic "AI edit").
Keep the change minimal and confirm `nodeLabel`'s signature first.

**Phase A done criteria**: see consolidated Done criteria. Includes: with
`aiEnabled:false`, NO AI UI appears anywhere; with it on, the transform streams,
commits a node, and undo rejects; unit tests pass; gates green.

---

# PHASE B — Editorial critique panel (read-only)

Keyboard-summoned side panel. Claude returns qualitative feedback on the current
section (Lex "ABCD"-style: what's weak, confusing, where it drags) — **READ-ONLY
feedback, applies NO edits, commits NO nodes.**

### B.1 — Action

`convex/aiCritique.ts`: an action (streaming optional; a single structured
response is fine — critique is not an edit). Auth like the transform action.
Input: the current section's markdown (selection, or the whole doc if no
selection). Output: structured feedback (e.g. an array of `{category, note}`).
Use the `claude-api` skill for the model + a JSON-structured response approach.

### B.2 — Panel

`components/ai/critique-panel.tsx`: a side panel modeled structurally on
`components/history/history-panel.tsx` (fixed inset-y right aside, `recto-panel`,
scrim, Escape-to-close, focus restore). Renders the feedback list. **No buttons
that mutate the document.** Gated on `aiEnabled`.

### B.3 — Summon wiring

Same three-file pattern as A.5: add `"ai-critique"` action, surface in palette
(when `aiEnabled`), handle + mount in `studio-shell.tsx`.

**Phase B done criteria**: panel opens via the command, shows feedback for the
current section, and a test confirms it renders feedback and exposes NO
edit-applying control. Gates green.

---

# PHASE C — RAG over the writer's own drafts

Uses the previously-UNUSED Convex vector search + a scheduled action. A
"related passages from your past drafts" side panel surfaces semantically-similar
passages **with citations** (which doc + scroll-to). On a small corpus the value
is recall + citation, NOT "chat my notes".

### C.1 — Schema

In `convex/schema.ts` add (model on `docNodes` indexing):
```ts
docChunks: defineTable({
	userId: v.string(),
	documentId: v.id("documents"),
	charStart: v.number(),
	charEnd: v.number(),
	text: v.string(),
	embedding: v.array(v.float64()),
	embeddedNodeId: v.string(), // the currentNodeId when this chunk was embedded
	updatedAt: v.number(),
})
	.index("by_document", ["documentId"])
	.vectorIndex("by_embedding", {
		vectorField: "embedding",
		dimensions: /* EXACT model output dim — confirm via skill; e.g. 1024 */ 1024,
		filterFields: ["userId"],
	}),
```
**The `dimensions` MUST equal the embedding model's output dimension** (confirm
via `claude-api`/`convex` skills). **Verify `vectorIndex` is supported on the
project's Convex plan** before relying on it (STOP condition). **Verify**:
`bun run convex:codegen` → exit 0; `bun run dev` deploys the schema without error.

### C.2 — Embedding pipeline (pure parts TEST-FIRST)

- `lib/ai/chunk.ts`: `chunk(markdown): {charStart;charEnd;text}[]` — split on
  blank lines, pack into ~1–2k-char windows with ~1-paragraph overlap. Pure.
- `lib/ai/embed-request.ts`: pure builder of the embedding API request payload
  (model id, input array, dimensions if applicable). Pure.
- `convex/embeddings.ts`:
  - `internalAction` `reindexDocument(documentId)`: read the doc's current
    markdown via `ctx.runQuery`, `chunk` it, call the embedding API
    (`VOYAGE_API_KEY` or `ANTHROPIC_API_KEY` from env), then `ctx.runMutation`
    to upsert `docChunks` (delete prior chunks for the doc first).
  - `internalMutation`s for upsert/delete (these touch `ctx.db`).
  - a `query`/`action` `relatedPassages(documentId, queryText)` that embeds the
    query and runs `ctx.vectorSearch("docChunks", "by_embedding", { vector, filter: q => q.eq("userId", uid), limit })`,
    then loads the matched chunk rows and returns `{documentId, title, text, charStart, score}`.
Write `lib/ai/chunk.test.ts` + `lib/ai/embed-request.test.ts` first.
**Verify**: `bunx vitest run lib/ai/chunk.test.ts lib/ai/embed-request.test.ts` → pass.

### C.3 — Scheduling

In `convex/crons.ts`, add a scheduled re-embed modeled on the existing daily
cron — a daily `internalAction` that iterates the user's documents and calls
`reindexDocument` for those whose `currentNodeId` differs from the stored
`embeddedNodeId` (changed since last embed). Add an opt-in manual "Re-index
drafts" command too. **Do NOT embed on every keystroke.**

### C.4 — Panel

`components/ai/related-passages-panel.tsx`: side panel (same structural pattern
as the history panel) listing related passages with the source doc title (the
citation) and a "scroll to" affordance (open that document / scroll to
`charStart`). Gated on `aiEnabled`.

### C.5 — Summon wiring

Same three-file pattern: `"ai-related"` action, palette surface (when
`aiEnabled`), handle + mount in `studio-shell.tsx`.

**Phase C done criteria**: schema deploys with the vector index; chunk/embed
unit tests pass; the panel returns cited passages for a query; embedding runs on
the schedule/manual command, not per keystroke. Gates green.

---

## Test plan

Unit-test the pure pieces; **mock the Claude/Convex action** for component
tests; the spike's success is the **manual runtime checklist** (Spike Step 3),
not an automated test. Model test structure on `lib/history/history.test.ts` /
plan 001's `diff.test.ts` (plain vitest, table-driven, pure functions).

- **`lib/ai/apply-transform.test.ts`** (Phase A): for several `(doc, range,
  aiText)` cases assert `applyTransform` produces
  `doc.slice(0,from)+aiText+doc.slice(to)`; assert the round-trip with
  `computePatch`/`applyPatch` from `lib/history/patch.ts`
  (`applyPatch(doc, encodePatch(computePatch(doc, applyTransform(...)))) === applyTransform(...)`)
  — this proves the AI result becomes a valid node patch. Cover: mid-doc
  replace, replace-at-start (`from=0`), replace-at-end (`to=len`), empty
  selection guard (throws), out-of-range guard (throws), empty `aiText`
  (deletion).
- **`lib/ai/instructions.test.ts`** (Phase A): presets have unique ids,
  non-empty prompts/labels; the registry shape is stable.
- **`lib/ai/chunk.test.ts`** (Phase C): chunking is deterministic; `charStart`/
  `charEnd` are non-overlapping-except-by-design and within bounds; concatenating
  chunk `text` (minus overlap) reconstructs the source paragraphs; empty/short
  inputs → 0 or 1 chunk.
- **`lib/ai/embed-request.test.ts`** (Phase C): the request builder emits the
  configured model id + the correct input array + the configured dimensions.
- **Component tests (optional, if a component test setup exists — check for
  existing `*.test.tsx`)**: with `aiEnabled:false`, AI actions are absent from
  the palette; the critique panel exposes no edit control. Mock the action.

**Verify**: `bunx vitest run lib/ai/` → all pass; `bun run test` → whole suite
green (vitest + the bun spike test that `package.json` already runs).

## Done criteria (per phase — machine-checkable; ALL in a phase must hold)

**SPIKE** (then STOP):
- [ ] `grep '"@anthropic-ai/sdk"' package.json` → under `dependencies`.
- [ ] `npx convex env list` shows `ANTHROPIC_API_KEY` (name only).
- [ ] `bun run convex:codegen` exits 0; `bun run dev` deploys `aiTransform` (and
      `http.ts` if used) with no deploy error.
- [ ] The 8-item manual runtime checklist in Spike Step 3 all pass.
- [ ] Executor has STOPPED and reported (spike not auto-continued into Phase A).

**PHASE A**:
- [ ] `bun run typecheck` 0; `bun run biome` 0; `bun run build` 0; `bun run test` 0.
- [ ] `lib/ai/apply-transform.test.ts` + `lib/ai/instructions.test.ts` exist and
      pass (apply-transform includes the patch round-trip assertion).
- [ ] `grep -n "aiEnabled" lib/studio/use-studio-settings.ts` shows field +
      default `false` + validator + setter.
- [ ] `grep -rn "aiTransformMode" lib/studio/use-studio-settings.ts` shows the
      switchable mode.
- [ ] With `aiEnabled:false`, `grep`/manual: no AI item in the palette, no AI
      button in the selection toolbar, popover not mounted.
- [ ] Manual: transform streams, commits an `origin:"ai"` node, `undo` returns to
      pre-AI text, `redo` returns to AI text.

**PHASE B**:
- [ ] Gates green. Critique panel opens via `"ai-critique"`; renders feedback;
      test confirms NO edit-applying control. No `docNodes` written by critique.

**PHASE C**:
- [ ] Gates green. `convex/schema.ts` has `docChunks` with a `vectorIndex` whose
      `dimensions` matches the embedding model. `bun run dev` deploys it.
- [ ] `lib/ai/chunk.test.ts` + `lib/ai/embed-request.test.ts` pass.
- [ ] Manual: related-passages panel returns cited passages; embedding runs on
      the cron/manual command, NOT per keystroke.

**ALL PHASES**:
- [ ] `git status` shows only in-scope files for the phase modified.
- [ ] No secret value appears in any committed file (`git diff` shows env keys by
      NAME only).
- [ ] `plans/README.md` status row for plan 009 updated.

## STOP conditions (all phases)

Stop and report (do not improvise) if:
- **Spike STOP conditions** (above) trigger — the foundation is not viable.
- The code at any "Current state" location does not match the excerpts (drift).
- Committing an AI result appears to require modifying
  `lib/history/use-document-history.ts`, `lib/history/patch.ts`,
  `lib/history/materialize.ts`, `convex/history.ts`, or `lib/sync/use-document-sync.ts`
  (out of scope — the restore-style path should suffice; report if not).
- `vectorIndex` is unsupported on the project's current Convex plan, or the
  embedding model's dimension is unknown/unconfirmed (Phase C).
- Streaming through Convex cannot be made to work by any documented path.
- An AI edit corrupts undo/redo or fights the debounced sync / cursor ownership.
- Any verification command fails twice after a reasonable fix attempt.
- A step appears to require touching an out-of-scope file.

## Maintenance notes

- **The reversibility guarantee lives in the commit path, not the AI.** AI edits
  are reversible *because* they go through `controller.record(...)` → a child
  node → `undo()` to parent. If anyone later "optimizes" AI edits to write
  `documents.updateMarkdown` directly, the reversibility (and the whole pitch) is
  gone. Reviewer: confirm AI commits go through the controller, never the doc
  mutation.
- **Streaming approach may need revisiting** when Convex changes its streaming
  story; the spike report records which path was used. The committed node never
  depends on streaming — streaming is display-only.
- **Embedding dimension is load-bearing.** `vectorIndex.dimensions` must equal
  the model output exactly; changing the embedding model means a new index +
  re-embed. Keep the model id + dimension in one place.
- **`aiTransformMode` is a deliberate A/B fork kept as a setting** (user
  preference: knobs over fixed picks). Don't collapse it to one mode without the
  user asking.
- **Deferred (out of this plan):** iA-style **authorship/provenance** — tracking
  and visually dimming AI-originated spans. This is a genuine differentiator
  (most tools hide that AI touched the text). It would build on `origin:"ai"`
  nodes already created here: materialize-time, mark ranges that came from AI
  patches. Scoped out to keep this plan shippable; revisit as a follow-up plan.
- **Cost control** (Phase C): embedding is a paid external call on a schedule.
  The cron only re-embeds documents whose `currentNodeId` changed. If the corpus
  grows, add a per-run cap.
