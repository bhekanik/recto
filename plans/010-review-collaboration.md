# Plan 010: Asynchronous review collaboration — share a draft, collect comments + branch suggestions, accept/reject without ever touching the owner's live document

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This plan introduces the FIRST multi-user concept
> in a previously single-user app; the load-bearing risk is reviewer edits
> corrupting the owner's document. The SPIKE exists to prove that isolation
> before any UI is built — **do the SPIKE first and STOP if it can't be made
> clean.** When done, update the status row for this plan in `plans/README.md`
> — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**:
> ```
> git diff --stat 0e473f2..HEAD -- convex/schema.ts convex/documents.ts convex/docNodes.ts convex/versions.ts convex/auth.config.ts convex/crons.ts convex/retention.ts lib/history/use-document-history.ts lib/history/materialize.ts lib/history/diff.ts lib/sync/use-document-sync.ts lib/keyboard/actions.ts lib/workspace/workspace-context.tsx components/history/history-panel.tsx components/outline/outline-panel.tsx components/document-switcher.tsx components/command-palette.tsx lib/editor/codemirror/lint-extension.ts lib/editor/milkdown/lint-plugin.ts
> ```
> If any in-scope file changed since this plan was written (commit `0e473f2`),
> compare the "Current state" excerpts in each phase against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/001-word-level-version-diff.md (DONE — its `diffRuns` + the compare UI in `components/history/history-panel.tsx` are reused). Phases run in order: SPIKE → A → B → C. Each is independently shippable; A is a hard prerequisite for B and C.
- **Category**: direction
- **Planned at**: commit `0e473f2`, 2026-06-18

## Why this matters

Recto is single-user today: there is no sharing, no ACL, no second writer. The most-requested writing-tool workflow it can't do is *"I wrote a draft and want feedback."* This plan adds asynchronous review collaboration: the owner shares one document with an invited person (by email, via Clerk sign-in); that person can leave **comments** and make **tracked changes** that land on a **shadow branch** of the existing undo tree (never touching the owner's live document); the owner then **reviews** each branch with the existing word-level diff and **accepts** (additive merge forward) or **rejects** (abandon — the retention cron prunes it). The whole design reuses two things Recto already has and trusts: the append-only branching `docNodes` DAG (suggestions are just branches) and the additive restore semantics (accept is just a restore-forward of the reviewer's branch head). The risk that makes this a phased spike-first plan: a reviewer's edits must be provably unable to advance `documents.currentNodeId` or overwrite `documents.markdown`.

## Cross-cutting rule: no AI on shared-for-comment notes

**While a document is shared for review/comments, the AI features (plan 009 — transforms, critique, RAG) are disabled for that document — for everyone, including the owner.** Rationale: a reviewer must never trigger the owner's OpenRouter spend or run AI over someone else's draft, the review surface stays about *human* feedback, and AI edits must not muddy the suggestion/branch flow mid-review.

Implementation hook (wire this in Phase A, once "is this document shared?" is knowable): the existing AI enablement gate — the global `aiEnabled` setting plus the AI entry points (the selection-toolbar AI button + the AI section in `components/command-palette.tsx`, summoned via `lib/ai/summon.ts` / `lib/ai/use-ai-transform.ts` and wired in `components/studio-shell.tsx`) — must additionally treat AI as OFF when the active document either (a) has any active `documentShares` row (owner side) or (b) was opened as a shared-with-me doc (reviewer side). Hide/disable the AI affordances and short-circuit the routes for such documents. Add this as a STOP-checked done criterion in Phase A: "with a shared document active, the AI transform/critique entry points are not offered and the routes are not reachable from the UI." A future setting could let an owner opt a specific shared doc back into AI, but default OFF.

## Cross-cutting rule: comment + suggestion creation is programmatic (one path for humans and AI)

The comment-creation and reviewer-branch-suggestion paths built in this plan MUST be callable programmatically, not only from the human review UI — because **plan 011 (AI as a reviewer) reuses them verbatim**: the AI returns structured, anchored feedback and the SAME `comments.create` mutation + reviewer-append / suggestion-branch path create its comments and tracked changes. Design requirements to honor here so 011 needs no rework:

- **(a) No UI-only coupling.** Comment creation and reviewer-branch append are plain Convex mutations / pure utils that take their inputs as arguments; the human UI is just one caller.
- **(b) Author/origin is a parameter, not hardcoded to the calling Clerk user.** Support a synthetic **AI reviewer identity** — e.g. `authorName: "AI · <model>"`, a stable synthetic author id, and branch `origin: "ai:review:<model>"` — so AI comments and suggestion branches render in, and accept/reject through, the exact same review surface as human ones. (Owner-only mutations still verify the *caller* is the owner; the *attributed author* is separate.)
- **(c) Anchoring is reused verbatim.** The quote + prefix/suffix locator (`lib/review/anchor.ts`) must work identically whether the anchor came from a human selection or an AI-supplied exact quote.

This is distinct from the no-AI-on-shared-docs rule above and does not conflict with it: the AI reviewer is the **owner running AI on their OWN (un-shared) document**; the no-AI-on-shared rule governs docs shared *out* to human reviewers.

## Current state

### The undo-tree DAG and where suggestions will live (reused, not redesigned)

`convex/docNodes.ts` — append-only immutable nodes. The `append` mutation is **idempotent on (documentId, nodeId)** and **never writes `currentNodeId`** (the pointer is a separate write). It currently authorizes with `requireOwnedDocument` — this is the line that blocks reviewers and that Phase C relaxes:

```ts
// convex/docNodes.ts:40-74
export const append = mutation({
	args: { documentId: v.id("documents"), nodeId: v.string(),
		parentNodeId: v.union(v.string(), v.null()), patch: v.string(),
		snapshot: v.optional(v.string()), selection: selectionValidator,
		origin: v.string(), createdAt: v.number() },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);   // ← reviewers cannot pass this today
		const existing = await ctx.db.query("docNodes")
			.withIndex("by_document_node", (q) =>
				q.eq("documentId", args.documentId).eq("nodeId", args.nodeId)).unique();
		if (existing) return { nodeId: args.nodeId, duplicate: true };
		await ctx.db.insert("docNodes", { documentId: args.documentId, nodeId: args.nodeId,
			parentNodeId: args.parentNodeId, patch: args.patch, snapshot: args.snapshot,
			selection: args.selection, origin: args.origin, createdAt: args.createdAt });
		return { nodeId: args.nodeId, duplicate: false };
	}});
```

The `origin` field (a free string, today the per-device id from `lib/history/origin.ts`) is the provenance hook this plan uses: reviewer nodes are tagged `review:<reviewerUserId>`.

`convex/history.ts` is a **self-contained** (no cross-directory imports) server copy of materialize/applyPatch — `materialize(targetNodeId, ServerNode[])` walks up to the nearest `snapshot` then replays patches. `convex/docNodes.ts` already exposes `getSnapshotAt` (materializes one node server-side) and `listSince` (DAG hydration) — both gated by `requireOwnedDocument`.

### Additive restore = the accept primitive (reused)

`convex/versions.ts:70-120` `restore`: materializes a source node, appends a NEW node whose parent is the **current tip** (fork forward), writes that markdown, advances `currentNodeId`. Old history is untouched. **Accept (Phase C) is structurally identical**, except the source is the reviewer's branch head instead of a tagged version:

```ts
// convex/versions.ts:89-116 (shape to mirror for accept)
const markdown = materialize(version.nodeId, nodes);
const parentNodeId = doc.currentNodeId;
const parentMarkdown = materialize(parentNodeId, nodes);
const newNodeId = crypto.randomUUID();
await ctx.db.insert("docNodes", { documentId, nodeId: newNodeId, parentNodeId,
	patch: JSON.stringify({ from: 0, to: parentMarkdown.length, insert: markdown }),
	snapshot: markdown, selection: null, origin: args.origin ?? "restore", createdAt: now });
await ctx.db.patch(documentId, { currentNodeId: newNodeId, markdown,
	wordCount: roughWordCount(markdown), updatedAt: now });
```

### Owner access + auth today

`convex/documents.ts` — the only access helpers:

```ts
// convex/documents.ts:11-33
export async function requireUserId(ctx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new Error("Unauthenticated");
	return identity.subject;            // Clerk JWT subject (the user id)
}
export async function requireOwnedDocument(ctx, documentId): Promise<Doc<"documents">> {
	const userId = await requireUserId(ctx);
	const doc = await ctx.db.get(documentId);
	if (!doc || doc.userId !== userId) throw new Error("Document not found");
	return doc;
}
```

`documents.list` (lines 36-53) returns **only `userId === caller` docs**, mapped to `{_id,title,wordCount,updatedAt}`. `documents.get` (56-73) returns null unless owned. `convex/auth.config.ts` wires Clerk: `domain: process.env.CLERK_JWT_ISSUER_DOMAIN`, `applicationID: "convex"`. **The Clerk JWT's exposure of `email` is NOT yet verified — `requireUserId` only ever reads `.subject`.** Resolving the caller's email is the keystone of invite-based access and is the first thing the spike must confirm (see SPIKE Step 0).

### The owner sync path reviewers MUST bypass

`lib/sync/use-document-sync.ts` is the LWW autosave that writes `documents.markdown` via `documents.updateMarkdown`:

```ts
// lib/sync/use-document-sync.ts:120-129 (the write reviewers must NEVER reach)
const result = await updateMarkdown({ documentId, markdown, wordCount: words,
	expectedUpdatedAt: expected, title: derivedTitle });
```

`lib/history/use-document-history.ts` ALSO advances the pointer: `onCommit` (160-190) calls `appendNode(...)` then `debouncedPointer(...)` → `documents.updateCurrentNodeId` (122-133), and `navigateTo`/`restoreVersion` call `updatePointer` directly. **For a reviewer, both the markdown autosave AND every `updateCurrentNodeId`/`updateMarkdown` call must be suppressed.** A reviewer session may only call `docNodes.append` (the append-only, pointer-free, idempotent path). The cleanest isolation is a dedicated reviewer-mode history controller that appends nodes and tracks its own local branch head, with `updatePointer` and the sync host disabled (SPIKE proves this; Phase C wires the UI).

### How the owner's history is wired per pane (where reviewer mode plugs in)

`lib/workspace/workspace-context.tsx:116-124` constructs the live history with `origin: getDeviceOrigin()`:

```ts
const history = useDocumentHistory({ documentId, getEditorHandle,
	serverCurrentNodeId: document?.currentNodeId, serverMarkdown: document?.markdown,
	serverUpdatedAt: document?.updatedAt, enabled, origin: getDeviceOrigin() });
```

`DocumentSyncHost` (80+) runs BOTH `useDocumentSync` and `useDocumentHistory` for an owned doc. Reviewer mode replaces this wiring for a shared doc (Phase C).

### Diff + side-panel + decoration exemplars (reused verbatim where possible)

- `lib/history/diff.ts` — `diffRuns(a, b, granularity)` returns `DiffRun[]` of `{type:"add"|"del"|"same", text}`. `DiffGranularity = "word" | "line"`. Pure.
- `components/history/history-panel.tsx:139-150, 415-503` — the compare-two-versions diff UI: `materializeAt(a)`, `materializeAt(b)`, `diffRuns`, then inline/side-by-side rendering with the exact OKLCH add/del classes. **Copy this render block for the review surface's per-branch diff.**
- `components/outline/outline-panel.tsx` — the canonical right-side `recto-panel` chrome (scrim, Escape-to-close, focus-restore, header, scroll body). **Model the comments panel and review panel on this.**
- `lib/editor/codemirror/lint-extension.ts` — display-only `Decoration.mark` over `{from,to}` offsets in CM (CM's doc IS canonical markdown, so offsets are 1:1). **Reuse this shape for comment highlights in raw/vim.**
- `lib/editor/milkdown/lint-plugin.ts` — display-only PM decorations located by **searching the document text for a substring** (PM positions ≠ source offsets), advancing a cursor, with a markdown-syntax-stripping fallback (`findSpan`, `cleanFragments`). **This is the exact re-anchoring technique the comment anchor needs in rich mode** — comment anchors quote text and re-locate it.

### Action registry + palette + switcher (where share/review actions surface)

- `lib/keyboard/actions.ts` — single `ACTIONS` registry; `ActionId` union + `ActionSection` union + `SECTION_ORDER`. Add a new `"Review"` section and ids here (Phase A/B/C). `components/command-palette.tsx` renders sections from `SECTION_ORDER` and gates a section conditionally (see AI: `if (section === "AI" && !aiEnabled)` at line 192) — mirror that gating for Review (only show on a shared/shareable doc).
- `components/document-switcher.tsx` — `useQuery(api.documents.list, ...)` + a rename modal composed from `Button`/`Input` shadcn primitives. The "Manage sharing" dialog (Phase A) is modeled on its rename modal; the shared-docs list extends the switcher's document list.

### Retention (reject = abandon → pruned automatically)

`convex/retention.ts` `sweep` (daily cron, `convex/crons.ts`) keeps spine + tagged-chains + recent (≤30d) + ancestors-of-kept, deletes whole abandoned subtrees. A **rejected** reviewer branch is abandoned (never on the owner's spine, never tagged) so it is pruned once it ages past 30 days — **reject requires no deletion logic**, only a status flag for UI. **CAUTION**: the 30-day recency window means a freshly-rejected branch is NOT immediately pruned; that is acceptable (status=rejected hides it from the UI).

### Conventions this plan MUST follow

- **Bun** for everything (`bun run …`, `bunx convex …`). CLAUDE.md: prefer Bun.
- **Convex is the only write path.** Every new function authorizes via `requireUserId` or the new `requireDocumentAccess` — never an unauthenticated mutation.
- **Editor owns live state** — never bind an editor's value to a reactive `useQuery`. The reviewer editor seeds once and appends nodes; it does not re-seed from the owner's reactive markdown.
- **shadcn primitives, dark-only OKLCH tokens** (`var(--color-…)`, `var(--space-…)`). Compose existing `recto-panel`/`recto-item`/`recto-scrim`/`recto-kbd` classes; do not introduce new color values except the diff add/del OKLCH literals already used in `history-panel.tsx`.
- **TS strict + ESM**, `@/`-aliased imports.
- **Run `bunx convex codegen` after every schema or Convex-function change**, before typecheck — `api`/`dataModel` types are generated.
- **Commits**: conventional `type: description`, NO AI attribution, NO `Co-Authored-By`. One commit per phase (SPIKE, A, B, C) after its gates pass.
- **A/B forks ship as switchable settings**, not a hardcoded choice (per project memory). This plan has no A/B fork, but if one arises (e.g. comment highlight on/off), make it a toggle.

## Commands you will need

| Purpose             | Command                                                        | Expected on success |
|---------------------|---------------------------------------------------------------|---------------------|
| Install             | `bun install`                                                 | exit 0              |
| Regen Convex types  | `bunx convex codegen`                                         | exit 0; `convex/_generated/*` updated |
| Typecheck           | `bun run typecheck`                                           | exit 0, no errors   |
| Lint/format         | `bun run biome`                                               | exit 0 (no errors)  |
| Tests (all)         | `bun run test`                                                | all pass            |
| Tests (one file)    | `bunx vitest run lib/review/<file>.test.ts`                   | that file passes    |
| Build               | `bun run build`                                               | exit 0              |
| Run a Convex fn     | `bunx convex run <module>:<fn> '<json-args>'`                 | prints result       |

Notes:
- `bun run test` = `vitest run && bun test spikes/undo-tree/tests/convex.bun.test.ts`. Vitest `include` is `["spikes/**/*.test.ts", "lib/**/*.test.ts"]` and `exclude` `["**/*.bun.test.ts"]` (`vitest.config.ts`). **New pure-logic tests MUST live under `lib/**` to be picked up.** `convex-test` works inside vitest (it is inlined in `vitest.config.ts` `server.deps.inline`) — see `spikes/undo-tree/tests/convex.bun.test.ts` for the `convexTest(schema, modules)` pattern.
- Root `tsconfig.json` excludes `spikes` and `**/*.bun.test.ts`; `convex/` is typechecked by `convex/tsconfig.json` via `convex codegen`/`convex dev`. **Always run `bunx convex codegen` before `bun run typecheck`** after Convex changes.

## Suggested executor toolkit

- Skill `convex` — for Convex schema/index/function patterns and `convex-test`. Invoke before writing any new Convex table or mutation.
- Skill `convex-type-depth` — if `bun run typecheck` reports a TS "type instantiation is excessively deep" error after adding tables (Convex's generated types can hit depth limits with many tables).
- Skill `clerk-backend-api` / `clerk` — only if SPIKE Step 0 reveals the JWT lacks `email` and you must read Clerk's identity claim names; do NOT change Clerk config without flagging it.
- Read first-hand before starting: this file's "Current state" excerpts are sufficient; you do NOT need to re-read the blueprint docs.

---

## SPIKE — prove reviewer-branch isolation + accept, no UI

> Goal: a non-owner with `suggester` access appends `docNodes` on a branch off
> the owner's current node (origin `review:<reviewerUserId>`) tracking their OWN
> branch head, WITHOUT mutating `documents.markdown` or `documents.currentNodeId`.
> Then the owner materializes that branch head, word-diffs it, and ACCEPTS it
> additively (a new node on the owner's spine). Prove the owner's document is
> untouched until accept, and reject = do nothing. **This is a throwaway proof
> in test code + minimal Convex functions; if isolation can't be made clean,
> STOP and report — do not build Phases A–C on a leaky foundation.**

### Scope (SPIKE)

**In scope**:
- `convex/schema.ts` — add `documentShares`, `comments`, `reviewBranches` tables (full schema; the spike only exercises `documentShares` + `reviewBranches`, but defining all three now avoids a second migration).
- `convex/review.ts` (create) — `requireDocumentAccess` helper + spike functions: `reviewerAppend` (append-only, access-gated, NO pointer write), `acceptBranch` (additive merge forward), `getBranchDiff` (server-side materialize of branch head + owner current).
- `lib/review/access.test.ts` (create) — `convex-test` proof of isolation + accept + reject.

**Out of scope (SPIKE)**: any React/UI, the comments table logic, palette/switcher wiring. Those are Phases A–C.

### SPIKE Step 0 — verify Clerk identity exposes an email

Add a throwaway query to `convex/review.ts`:

```ts
import { query } from "./_generated/server";
export const _whoami = query({ args: {}, handler: async (ctx) => {
	const id = await ctx.auth.getUserIdentity();
	return id ? { subject: id.subject, email: id.email, emailVerified: id.emailVerified } : null;
}});
```

Run `bunx convex codegen && bunx convex run review:_whoami` **while authenticated** (or inspect `ctx.auth.getUserIdentity()`'s TS type — Convex's `UserIdentity` type includes optional `email`/`emailVerified` fields populated from the JWT's standard claims). Confirm `email` is a non-empty string.

**Verify**: `email` is present and non-empty.
**STOP** if `email` is `undefined`/empty: invite-based sharing keys on email. Report that the Clerk JWT template must be configured to include the `email` claim (a Clerk dashboard change — flag it, do not attempt it here). Delete `_whoami` before committing regardless of outcome.

### SPIKE Step 1 — define the tables

Add to `convex/schema.ts` (inside `defineSchema({...})`, alongside the existing tables; match the indentation/comment style of `docNodes`):

```ts
	// Invite-based per-document ACL (plan 010). Owner shares one document with an
	// invited email; once that email signs in, granteeUserId is resolved & cached.
	documentShares: defineTable({
		documentId: v.id("documents"),
		ownerUserId: v.string(),
		granteeEmail: v.string(),                 // lowercased at write time
		granteeUserId: v.optional(v.string()),    // resolved on first access by that user
		role: v.union(v.literal("commenter"), v.literal("suggester")),
		createdAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_grantee_email", ["granteeEmail"])
		.index("by_grantee_user", ["granteeUserId"]),

	// A reviewer's shadow suggestion branch off the owner's tree (plan 010).
	// headNodeId advances as the reviewer appends; status drives the review surface.
	// Reject = status "rejected" (the abandoned branch is pruned by retention).
	reviewBranches: defineTable({
		documentId: v.id("documents"),
		reviewerUserId: v.string(),
		baseNodeId: v.string(),                    // owner's currentNodeId when the branch opened
		headNodeId: v.string(),                    // latest reviewer node on this branch
		status: v.union(v.literal("open"), v.literal("accepted"), v.literal("rejected")),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_document", ["documentId"])
		.index("by_document_reviewer", ["documentId", "reviewerUserId"]),

	// Anchored comments on a shared document (plan 010, Phase B). Anchor stores the
	// quoted text + position hint; re-located by search so it survives edits.
	comments: defineTable({
		documentId: v.id("documents"),
		authorUserId: v.string(),
		authorName: v.string(),
		anchor: v.object({
			quote: v.string(),       // exact quoted substring of canonical markdown
			prefix: v.string(),      // up to ~32 chars before the quote (disambiguator)
			suffix: v.string(),      // up to ~32 chars after the quote
			offsetHint: v.number(),  // char offset at anchor time (tie-breaker only)
		}),
		body: v.string(),
		threadParentId: v.optional(v.id("comments")),
		resolved: v.boolean(),
		createdAt: v.number(),
	}).index("by_document", ["documentId"]),
```

**Verify**: `bunx convex codegen` exits 0; `convex/_generated/dataModel.d.ts` now references `documentShares`, `reviewBranches`, `comments`.

### SPIKE Step 2 — the access helper + spike functions in `convex/review.ts`

Write `requireDocumentAccess(ctx, documentId, minRole)`:
- Resolve `userId = identity.subject`, `email = (identity.email ?? "").toLowerCase()`.
- If the document's `userId === caller` → return `{ doc, role: "owner" }` (owner outranks all).
- Else look up a share: prefer `by_grantee_user` on `userId`; fall back to `by_grantee_email` on `email`. If found via email and `granteeUserId` is unset, **patch it** (resolve-on-first-access) — but only inside a mutation ctx; in a query ctx, skip the patch (queries can't write).
- Role rank: `commenter` < `suggester` < `owner`. Throw `"Document not found"` (same message as `requireOwnedDocument`, to avoid leaking existence) if no share meets `minRole`.

Then the three spike functions:

```ts
// reviewerAppend: APPEND-ONLY, access-gated at "suggester", NEVER writes the doc.
export const reviewerAppend = mutation({
	args: { documentId: v.id("documents"), branchId: v.optional(v.id("reviewBranches")),
		nodeId: v.string(), parentNodeId: v.string(), patch: v.string(),
		snapshot: v.optional(v.string()), selection: selectionValidator, createdAt: v.number() },
	handler: async (ctx, args) => {
		const { userId } = await requireDocumentAccess(ctx, args.documentId, "suggester");
		// idempotent append, EXACTLY like docNodes.append, origin = `review:<userId>`
		// ... insert node if not existing ...
		// open-or-advance the reviewBranches row (status "open"); set headNodeId = nodeId
		// CRITICAL: never call ctx.db.patch on the documents row.
		return { nodeId: args.nodeId, branchId };
	}});

// getBranchDiff: owner-only; materialize branch head + owner current, return both strings.
export const getBranchDiff = query({ args: { documentId, branchId },
	handler: async (ctx, args) => {
		await requireOwnedDocument(ctx, args.documentId);
		// collect docNodes by_document, materialize(branch.headNodeId) and materialize(doc.currentNodeId)
		return { branchMarkdown, currentMarkdown };
	}});

// acceptBranch: owner-only; additive merge forward (mirror versions.restore).
export const acceptBranch = mutation({ args: { documentId, branchId },
	handler: async (ctx, args) => {
		const doc = await requireOwnedDocument(ctx, args.documentId);
		// materialize(branch.headNodeId); append new node parented at doc.currentNodeId
		//   (origin "review-accept"), snapshot = merged markdown; patch doc currentNodeId/markdown.
		// set branch.status = "accepted".
		return { newNodeId };
	}});

// rejectBranch: owner-only; status = "rejected" only. NO node deletion.
export const rejectBranch = mutation({ args: { documentId, branchId }, handler: ... });
```

Import `materialize`/`ServerNode` from `./history` and `requireUserId`/`requireOwnedDocument` from `./documents` (re-export `requireDocumentAccess` from `convex/review.ts`).

**Verify**: `bunx convex codegen && bun run typecheck` → exit 0.

### SPIKE Step 3 — prove isolation in `lib/review/access.test.ts`

Use `convex-test` (mirror `spikes/undo-tree/tests/convex.bun.test.ts`, but as a **vitest** file under `lib/review/` so `bun run test` picks it up; use `import { describe, expect, it } from "vitest"` and `convexTest(schema, modules)` with the full module map including `convex/review.ts`, `convex/documents.ts`, `convex/docNodes.ts`, `convex/versions.ts`, `convex/history.ts`). Use `t.withIdentity({ subject, email })` to simulate the owner vs the reviewer (convex-test supports per-call identities).

Assert, in order:
1. **Owner creates** a doc (`documents.create`) and types an edit (append a node via `docNodes.append` as owner, advance pointer via `documents.updateCurrentNodeId`). Capture `ownerMarkdown0`, `ownerCurrentNodeId0`, `ownerUpdatedAt0`.
2. **Reviewer with no share is blocked**: `reviewerAppend` as a different identity → throws `"Document not found"`.
3. **Grant suggester** (insert a `documentShares` row via `t.run` direct db write, or a share mutation if you wrote one — direct db write is fine for the spike). Reviewer `reviewerAppend` of 2–3 nodes now succeeds; each node has `origin === "review:<reviewerSubject>"`; a `reviewBranches` row exists with `status:"open"`, `baseNodeId === ownerCurrentNodeId0`, `headNodeId === last reviewer nodeId`.
4. **Owner document is untouched**: re-fetch the doc → `markdown === ownerMarkdown0`, `currentNodeId === ownerCurrentNodeId0`, `updatedAt === ownerUpdatedAt0`. **This is the load-bearing assertion.**
5. **Diff is materializable**: `getBranchDiff` returns `branchMarkdown !== currentMarkdown`, and `diffRuns(currentMarkdown, branchMarkdown)` (import from `@/lib/history/diff`) has ≥1 run with `type:"add"` or `type:"del"`.
6. **Accept is additive**: `acceptBranch` → doc `currentNodeId` is a NEW id, `markdown === branchMarkdown`, and the pre-accept owner node (`ownerCurrentNodeId0`) **still exists** in `docNodes` (history preserved). Branch `status === "accepted"`.
7. **Reject is a no-op on data**: open a second reviewer branch, `rejectBranch` → branch `status === "rejected"`, no `docNodes` deleted, doc unchanged.
8. **Reviewer cannot accept/reject**: `acceptBranch`/`rejectBranch` as the reviewer identity → throws.
9. **Commenter cannot suggest**: grant a third user `commenter`; `reviewerAppend` → throws (role below `suggester`).

**Verify**: `bunx vitest run lib/review/access.test.ts` → all assertions pass.

### SPIKE done criteria (ALL must hold)

- [ ] `bunx convex codegen` exits 0; the three tables exist in generated types.
- [ ] `bun run typecheck` exits 0.
- [ ] `bunx vitest run lib/review/access.test.ts` passes, including assertion #4 (owner doc untouched) and #6 (accept additive, old node survives).
- [ ] `_whoami` was used to confirm `identity.email`, then deleted.
- [ ] `bun run biome` exits 0.

### SPIKE STOP conditions

- **`identity.email` is undefined/empty** (Step 0). Invite-by-email cannot be keyed; report that Clerk's JWT template needs the `email` claim. Do not fake it with `subject`.
- **You cannot prevent reviewer writes from reaching `documents`** without contorting the schema (e.g. you find `reviewerAppend` must touch the doc to be useful). Report the specific reason; the whole feature's safety rests on this.
- Assertion #4 fails (owner doc mutated by reviewer activity) — the isolation is leaky; STOP.

---

## PHASE A — sharing / ACL (invite by email, see shared docs)

> Builds on the SPIKE's `documentShares` table + `requireDocumentAccess`. Adds
> share-management mutations/queries, surfaces shared docs in the owner's and
> grantee's document lists, and a "Manage sharing" dialog.

### Scope (Phase A)

**In scope**:
- `convex/review.ts` — add share-management functions: `shares.add`, `shares.list` (by document, owner-only), `shares.revoke` (owner-only), `listSharedWithMe` (docs the caller is a grantee of). Finalize `requireDocumentAccess` (already drafted in SPIKE).
- `convex/documents.ts` — extend `documents.list` (or add `documents.listAccessible`) so the caller also sees docs shared with them, each marked with `shared: true` + `role`. **Do NOT change `documents.get`/`updateMarkdown`/`updateCurrentNodeId`/`remove` ownership gates** — those stay owner-only.
- `components/share-dialog.tsx` (create) — add-by-email + role select + list + revoke, composed from `Button`/`Input` + a shadcn `Select` (compose from `@base-ui/react` primitives if no `Select` exists; check `components/ui/`). Model the modal chrome on `components/document-switcher.tsx`'s rename modal (lines 173-205).
- `components/document-switcher.tsx` — show shared-with-me docs in the list (marked, read-only badge), and a "Share…" affordance per owned doc that opens the dialog.
- `lib/keyboard/actions.ts` — add `ActionSection "Review"` and `ActionId "manage-sharing"`; add to `SECTION_ORDER`.
- `lib/review/access.test.ts` — extend with share add/revoke/list + `listSharedWithMe` cases.

**Out of scope (Phase A)**: comments (Phase B), reviewer editing UI + review surface (Phase C). Anonymous/public links (explicitly never — invite-only). Changing any owner-only ownership gate.

### Phase A steps (high level — match SPIKE patterns)

1. **`shares.add`** (mutation): owner-only (`requireOwnedDocument`). Args `{documentId, email, role}`. Lowercase + trim the email; reject empty; reject the owner's own email (`identity.email`) — can't share with self; upsert by `(documentId, granteeEmail)` (query `by_document`, filter in memory — small N). Insert `{documentId, ownerUserId, granteeEmail, role, createdAt}`.
2. **`shares.list`** (query, owner-only): list `by_document`; return `{_id, granteeEmail, granteeUserId, role, createdAt}`.
3. **`shares.revoke`** (mutation, owner-only): delete a `documentShares` row by id after confirming `ownerUserId === caller`. **Note**: revoking does NOT delete the reviewer's existing branches/comments (they remain for the owner to review/accept); it only blocks further access. Document this in a code comment.
4. **`listSharedWithMe`** (query): for the caller, gather shares via `by_grantee_user` (subject) AND `by_grantee_email` (email); for email-only hits inside this **query**, do NOT patch `granteeUserId` (queries can't write) — instead resolve lazily on the first mutation (`requireDocumentAccess` in a mutation ctx). For each share, `ctx.db.get(documentId)` and return `{_id, title, wordCount, updatedAt, role, ownerUserId}` (skip docs that were deleted).
5. **`documents.list` extension**: keep the owned-docs query; do NOT merge shared docs into the same return shape if it risks the optimistic-update code in `document-switcher.tsx` (it `setQuery(api.documents.list, {}, ...)`). **Safer**: leave `documents.list` exactly as-is and consume `review.listSharedWithMe` as a SEPARATE query in the switcher, rendered as a distinct "Shared with you" group. This avoids touching the optimistic-update contract. Prefer this.
6. **`share-dialog.tsx`**: a modal (model on the rename modal) with an email `Input`, a role `Select` (commenter/suggester), an "Invite" `Button`, and the current shares list with per-row "Revoke". All writes go through the Convex mutations.
7. **Switcher wiring**: add a per-owned-doc "Share…" button (like the rename/delete buttons at lines 272-298) that opens `share-dialog` for that doc; add a "Shared with you" `Command.Group` fed by `listSharedWithMe`, each item opening the doc read-only (Phase C makes it editable for suggesters).
8. **Action + palette**: add `manage-sharing` to `actions.ts`; gate the `"Review"` section in `command-palette.tsx` so it only appears when the active doc is owned (mirror the AI gating at line 192).

### Phase A test plan

- `lib/review/access.test.ts` (extend): `shares.add` lowercases email + rejects self + rejects empty; duplicate add upserts (no duplicate row); `shares.revoke` removes only the targeted row and only for the owner; `listSharedWithMe` returns the doc for both a user-resolved and an email-only grantee; a non-owner cannot call `shares.add`/`shares.list`/`shares.revoke`.
- Model structurally on the SPIKE test (same `convexTest` + `withIdentity`).

### Phase A done criteria

- [ ] `bunx convex codegen && bun run typecheck && bun run biome` exit 0.
- [ ] `bun run test` passes; new share-management cases exist and pass.
- [ ] `bun run build` exits 0.
- [ ] `documents.get`/`updateMarkdown`/`updateCurrentNodeId`/`remove` are byte-for-byte unchanged in their ownership gates (`git diff convex/documents.ts` shows ONLY the additive `listAccessible`/`list` change, if any).
- [ ] No anonymous/public access path exists (`grep -rn "public\|anonymous\|share.*link\|linkToken" convex/review.ts` → no matches).

---

## PHASE B — comments (anchored, cross-lens, threaded, resolvable)

> Commenter+ roles and the owner can add comments. Author + owner can
> resolve/delete. Comments anchor into the canonical markdown via quoted text +
> position hint, re-located by search so they survive edits.

### Scope (Phase B)

**In scope**:
- `convex/review.ts` — `comments.add` (access ≥ commenter), `comments.list` (access ≥ commenter), `comments.resolve` (author or owner), `comments.remove` (author or owner).
- `lib/review/anchor.ts` (create) — PURE anchoring: `createAnchor(markdown, from, to)` → `{quote, prefix, suffix, offsetHint}`; `locateAnchor(markdown, anchor)` → `{from, to} | null` with fuzzy fallback. **This is the tricky part — see the algorithm below.**
- `lib/review/anchor.test.ts` (create) — anchoring re-location across edits.
- `components/review/comments-panel.tsx` (create) — side panel modeled on `outline-panel.tsx`/`history-panel.tsx`: list comments, jump-to-anchor, add/reply/resolve/delete.
- Comment highlight decorations: reuse `lib/editor/codemirror/lint-extension.ts` shape for raw/vim (offsets are 1:1) and `lib/editor/milkdown/lint-plugin.ts`'s `findSpan` search technique for rich mode. **Create `lib/review/comment-decorations-cm.ts` and `lib/review/comment-decorations-pm.ts`** rather than editing the lint files (minimal blast radius; the lint extensions stay single-purpose).
- `lib/keyboard/actions.ts` — `ActionId "toggle-comments"` in the `"Review"` section.

**Out of scope (Phase B)**: branch suggestions + accept/reject (Phase C). Real-time presence/typing. Comment notifications/email.

### The anchoring algorithm (`lib/review/anchor.ts`) — be explicit

Comments must survive owner edits to surrounding text. Store, never a bare offset alone:
- `quote`: the exact selected substring of canonical markdown (cap length, e.g. ≤ 200 chars; if the selection is empty, anchor to the enclosing word/sentence).
- `prefix`: up to 32 chars of markdown immediately before `from`.
- `suffix`: up to 32 chars immediately after `to`.
- `offsetHint`: the original `from` offset (tie-breaker only, never authoritative).

`locateAnchor(markdown, anchor)`:
1. **Exact unique**: if `quote` occurs exactly once in `markdown`, return that range.
2. **Context-disambiguated**: if `quote` occurs multiple times, pick the occurrence whose surrounding text best matches `prefix`+`suffix` (compare the chars before/after each candidate to `anchor.prefix`/`anchor.suffix`; choose max overlap; break ties by proximity to `offsetHint`).
3. **Fuzzy fallback**: if `quote` is not found verbatim (the quoted text itself was edited), search a window around `offsetHint` for the best near-match of `prefix+quote+suffix` (a simple normalized-substring or token-overlap score; do NOT pull in a heavy fuzzy-match dependency — a small scoring loop is fine and matches the codebase's "pure small helpers" style). If no candidate clears a minimum score, return `null` (the comment becomes "orphaned" — see below).
4. Return `null` only when nothing reasonable is found.

**Orphaned comments**: when `locateAnchor` returns `null`, the comment still renders in the panel marked "anchor lost" (show the `quote` as context) but has no highlight. It is NOT deleted. This is the explicit, recoverable failure mode — never silently drop a comment.

### Cross-lens highlight

Comments are anchored into the **canonical markdown**, so `locateAnchor` runs against the same string regardless of lens:
- **raw/vim (CodeMirror)**: offsets map 1:1 — reuse the `lint-extension.ts` `Decoration.mark(from,to)` shape exactly (a new StateField + StateEffect carrying `{commentId, from, to}[]`).
- **rich (Milkdown/ProseMirror)**: offsets ≠ PM positions — reuse `lint-plugin.ts`'s `findSpan`/`cleanFragments` to locate each comment's `quote` text in PM and decorate it.

### Phase B permissions

- `comments.add`: `requireDocumentAccess(..., "commenter")` (owner passes; suggester passes; commenter passes). `authorName` from `identity.name ?? identity.email ?? "Reviewer"`.
- `comments.resolve` / `comments.remove`: allowed if `authorUserId === caller` OR caller is the document owner. Otherwise throw.
- `comments.list`: `requireDocumentAccess(..., "commenter")`.

### Phase B test plan (`lib/review/anchor.test.ts`)

PURE, no Convex. Cases:
- `createAnchor` then `locateAnchor` on the **unchanged** markdown returns the original `{from,to}`.
- Anchor survives an **insertion before** the quote (offset shifted; relocated by quote+context).
- Anchor survives an **insertion after** the quote.
- **Duplicate quote** disambiguated by prefix/suffix to the correct occurrence.
- **Edited-quote fuzzy fallback** relocates approximately (a small edit inside the quote).
- **Irrecoverable**: quote fully deleted → `locateAnchor` returns `null` (orphan path).
- Model structurally on `lib/history/diff.test.ts` (plain vitest `describe`/`it`).

### Phase B done criteria

- [ ] `bunx convex codegen && bun run typecheck && bun run biome` exit 0.
- [ ] `bun run test` passes; `lib/review/anchor.test.ts` exists with the 6 cases above, all passing.
- [ ] A non-author non-owner cannot resolve/delete another's comment (covered in `access.test.ts`).
- [ ] Comments render in BOTH lenses (manual check) and an orphaned comment still appears in the panel (manual check).
- [ ] `bun run build` exits 0.

---

## PHASE C — branch suggestions (reviewer editing) + owner review surface

> Wire the SPIKE's `reviewerAppend`/`reviewBranches` into a real reviewer editing
> session and an owner review surface that diffs each open branch and accepts/rejects.

### Scope (Phase C)

**In scope**:
- `convex/review.ts` — finalize `reviewerAppend`, `getBranchDiff`, `acceptBranch`, `rejectBranch` (from SPIKE) + `listOpenBranches` (owner-only, by document, status `open`) and `listReviewableBranches` returning enough to render the review surface (branch + reviewer name + node count).
- `lib/review/use-reviewer-history.ts` (create) — a reviewer-mode history controller analogous to `lib/history/use-document-history.ts` but: appends via `review.reviewerAppend` (origin `review:<reviewerUserId>`), tracks its OWN `branchHeadNodeId` locally, and **NEVER calls `documents.updateCurrentNodeId` or `documents.updateMarkdown`**. Seeds the editor once from the owner's current materialized markdown, then appends on edits. Reuse the grouping controller (`lib/history/grouping.ts`) the same way `use-document-history.ts` does.
- `lib/workspace/workspace-context.tsx` — when the open doc is shared-with-me and my role is `suggester`, mount the reviewer-mode controller INSTEAD of the owner `useDocumentSync` + `useDocumentHistory`. **This is the isolation boundary in the UI: the owner sync host must not run for a reviewer.** A `commenter` (or any non-suggester) opens the doc read-only (preview lens), no editor write path at all.
- `components/review/review-surface.tsx` (create) — owner per-document panel (modeled on `history-panel.tsx`): lists open branches + comments; per branch renders the word-level diff via `getBranchDiff` + `diffRuns` + the exact render block from `history-panel.tsx:415-503`; Accept / Reject buttons per branch.
- `lib/keyboard/actions.ts` — `ActionId "review-surface"` in `"Review"`.
- `lib/review/access.test.ts` — extend with `listOpenBranches` + accept-advances-spine + reject-keeps-doc (mostly already proven in SPIKE; assert the listing functions here).

**Out of scope (Phase C)**: per-hunk accept/reject (deferred — see Maintenance notes). Real-time co-editing/presence. Reviewer seeing other reviewers' branches. Notifications.

### Phase C key design decisions (committed — do not redesign)

- **Suggestions are branch-based, reusing the undo tree** — a reviewer's edits are `docNodes` on a branch off the owner's `currentNodeId` at open time (`baseNodeId`), origin `review:<reviewerUserId>`. They never advance `documents.currentNodeId` or write `documents.markdown`.
- **`reviewBranches` is a small index over those nodes**, NOT a second copy of the content. `headNodeId` advances as the reviewer appends; the content lives in `docNodes`. Justification for a dedicated table (vs. inferring branches from `origin`): the owner needs O(1) "list open branches for this doc" + a per-branch `status` to drive Accept/Reject/hide-rejected, which an origin scan can't give cheaply, and `status` has nowhere else to live.
- **Accept = additive merge forward** (mirror `versions.restore`): materialize the branch head, append a new node parented at the owner's CURRENT tip (so concurrent owner edits since branch-open are preserved — the merge is forward from the live tip, the diff in the surface shows branch-head vs. live-current), advance `currentNodeId`. **Branch-level for v1** (the whole branch head is merged as one node).
- **Reject = `status:"rejected"`** only; retention prunes the abandoned subtree later.
- **The reviewer editor seeds once and is append-only** — it must NOT re-seed from the owner's reactive `documents.get` markdown (that would clobber the reviewer's in-progress branch). This is the "editor owns live state" rule applied to reviewer mode.

### Phase C test plan

- `lib/review/access.test.ts` (extend): `listOpenBranches` returns only `status:"open"` branches for the doc and is owner-only; after `acceptBranch`, the branch no longer appears in `listOpenBranches` and the owner doc advanced; after `rejectBranch`, it no longer appears and the doc is unchanged. (The core isolation/accept/reject behavior is already proven in the SPIKE test — keep those assertions.)
- Pure logic in `use-reviewer-history.ts` that can be extracted (e.g. "compute next branch node parented at current head") should be a tiny pure helper with its own vitest case if non-trivial; otherwise rely on the Convex-level tests.

### Phase C done criteria

- [ ] `bunx convex codegen && bun run typecheck && bun run biome` exit 0.
- [ ] `bun run test` passes; the SPIKE isolation+accept+reject assertions still pass; new listing assertions pass.
- [ ] A suggester editing a shared doc produces `docNodes` with `origin` starting `review:` and a `reviewBranches` row, while the owner's `documents` row is unchanged (Convex test assertion).
- [ ] Owner review surface renders a per-branch diff using the reused `diffRuns` render block; Accept advances the owner spine additively; Reject marks rejected without deleting nodes.
- [ ] Reviewer-mode editor never calls `documents.updateMarkdown`/`documents.updateCurrentNodeId` (`grep -n "updateMarkdown\|updateCurrentNodeId" lib/review/use-reviewer-history.ts` → no matches).
- [ ] `bun run build` exits 0.
- [ ] `plans/README.md` status row for 010 updated.

---

## Test plan (overall)

New test files (all under `lib/**` so vitest's `include` picks them up):
- `lib/review/access.test.ts` — `convex-test` (mirror `spikes/undo-tree/tests/convex.bun.test.ts` but vitest + `withIdentity`): isolation (#4 owner untouched), accept additive (#6), reject no-op (#7), role gating (#8, #9), share add/revoke/list, `listSharedWithMe`, `listOpenBranches`.
- `lib/review/anchor.test.ts` — pure anchoring (model on `lib/history/diff.test.ts`): re-location across insertions, duplicate disambiguation, fuzzy fallback, irrecoverable→null.

Existing tests must keep passing: `bun run test` runs the full vitest suite + the bun convex spike test. The plan must not break any of the 234 existing tests.

## Done criteria (whole plan — machine-checkable)

ALL must hold:

- [ ] `bunx convex codegen` exits 0; `documentShares`, `comments`, `reviewBranches` exist in generated types.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run biome` exits 0.
- [ ] `bun run test` exits 0; `lib/review/access.test.ts` and `lib/review/anchor.test.ts` exist and pass; the owner-doc-untouched and accept-additive assertions pass.
- [ ] `bun run build` exits 0.
- [ ] `grep -rn "updateMarkdown\|updateCurrentNodeId" lib/review/` returns no matches (reviewer path never writes the owner doc).
- [ ] `grep -rn "anonymous\|publicShare\|linkToken\|share.*public" convex/review.ts` returns no matches (invite-only).
- [ ] `documents.get`/`updateMarkdown`/`updateCurrentNodeId`/`remove` ownership gates unchanged (`git diff 0e473f2..HEAD -- convex/documents.ts` shows only additive list/access changes).
- [ ] Only files in the per-phase In-scope lists are modified (`git status`); `plans/README.md` is touched only to update the 010 status row (the orchestrator owns the index — do not edit other rows).

## STOP conditions

Stop and report (do not improvise) if:

- **`ctx.auth.getUserIdentity()` does not expose a non-empty `email`** (SPIKE Step 0). Invite-by-email is the locked access model; report that Clerk's JWT template needs the `email` claim — a dashboard config change you must NOT make silently.
- **Reviewer activity mutates `documents.markdown` or `documents.currentNodeId`** (SPIKE assertion #4 fails, or you cannot write `reviewerAppend` without touching the doc). The feature's entire safety contract is broken — STOP.
- **Comment anchors drift irrecoverably in a way that silently loses comments** — if you cannot implement the orphan path (null → "anchor lost", never delete), STOP rather than ship anchors that vanish.
- The code at any "Current state" excerpt doesn't match the live file (drift since `0e473f2`) — re-verify before proceeding; on a real mismatch, STOP.
- A step's verification fails twice after a reasonable fix attempt.
- A fix appears to require touching an out-of-scope file (especially the owner-only gates in `convex/documents.ts`, or the lint extensions `lib/editor/{codemirror/lint-extension,milkdown/lint-plugin}.ts` — create new decoration files instead).
- Adding the three tables triggers a TS "type instantiation is excessively deep" error — invoke the `convex-type-depth` skill; if unresolved, STOP and report.

## Maintenance notes

For the human/agent who owns this after it lands:

- **Per-hunk accept/reject is deliberately deferred.** v1 accepts/rejects a whole branch. To add per-hunk: the review surface already has `diffRuns` runs; map each add/del run back to a markdown range and synthesize a partial merged markdown, then feed that to an accept variant. The branch-based model supports it (you'd append a node materializing the partial merge), but it's significant UI + range-mapping work.
- **Revoking a share does NOT remove existing reviewer branches/comments** (intentional — the owner may still want to review/accept work done before revocation). If a "purge on revoke" is ever wanted, add it to `shares.revoke` explicitly.
- **Rejected branches are pruned by the 30-day retention window, not immediately.** They're hidden from the UI via `status:"rejected"`. If immediate pruning is wanted, extend `convex/retention.ts` to treat `status:"rejected"` branch subtrees as eligible regardless of recency (careful: don't orphan snapshots a survivor depends on — the existing `sweep` keeps ancestor chains).
- **Accept merges from the owner's CURRENT tip, not the branch's base.** If the owner edited after the reviewer opened their branch, those edits are preserved and the accept fork-forwards over them. The diff shown is branch-head vs. live-current, so the owner sees exactly what will change.
- **What a reviewer should scrutinize in the PR**: that no reviewer code path can reach `documents.updateMarkdown`/`updateCurrentNodeId`; that `requireDocumentAccess` correctly ranks roles and never leaks document existence (same error message as `requireOwnedDocument`); that comment anchoring's orphan path never deletes; that the reviewer editor seeds once and is not bound to a reactive `useQuery` of the owner's markdown.
- **Multi-user is new** — watch for Convex per-value/per-transaction ceilings if a single doc accumulates many reviewer branches; the cascade-delete in `documents.remove` should also delete `documentShares`/`reviewBranches`/`comments` for that doc (add this when wiring Phase A/B — it's currently only `docNodes`+`versions`; flag it if not done).
