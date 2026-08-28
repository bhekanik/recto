# Recto — Sync & Persistence

> Part of the Recto blueprint. Canonical contract lives in [`README.md`](./README.md) (see D10, D11). This file is the full expansion. If anything here contradicts the README, the README wins.

This document specifies **how Recto's live editing state reaches Convex and comes back** — the performance contract that keeps typing off the network, debounced persistence, reactive hydration without clobbering the cursor, the narrow use of optimistic updates, multi-device/multi-tab concurrency for a single user, the offline posture, and why we deliberately do **not** adopt `@convex-dev/prosemirror-sync`, Yjs, or any CRDT/OT engine.

It is self-contained — you can implement the editor↔Convex boundary from this file alone, given the table/field names defined in [`03-data-model.md`](./03-data-model.md).

Sibling references:
- [`02-architecture.md`](./02-architecture.md) — the canonical-model spine and client/server split these flows sit inside.
- [`03-data-model.md`](./03-data-model.md) — exact tables (`documents`, `docNodes`, `versions`, `workspaces`), fields, and the mutation signatures called here.
- [`07-undo-tree.md`](./07-undo-tree.md) — the append-only DAG that is the durable safety net behind last-write-wins.
- [`08-version-control.md`](./08-version-control.md) — tagged versions, the recovery path after a clobber.
- [`09-documents-workspace-split.md`](./09-documents-workspace-split.md) — panes, idle vs focused state, workspace persistence.
- [`14-tech-decisions.md`](./14-tech-decisions.md) — the ADR for rejecting prosemirror-sync / Yjs / CRDT.

Authoritative external references:
- Optimistic updates: <https://docs.convex.dev/client/react/optimistic-updates>
- Optimistic concurrency control (OCC): <https://docs.convex.dev/database/advanced/occ>
- `@convex-dev/prosemirror-sync`: <https://github.com/get-convex/prosemirror-sync>
- Background (collaborative editor on Convex): <https://stack.convex.dev/add-a-collaborative-document-editor-to-your-app>

---

## 1. The performance contract (D11)

> **The local editor owns live state. The editor is never a controlled component bound to a reactive `useQuery` result.**

This is the single rule the whole module exists to protect. Milkdown (rich) and CodeMirror 6 (raw/Vim) each hold their own document state in memory. That local state is authoritative *while the pane is focused*. Convex is where that state is **persisted** and from where it is **hydrated** — it is not the live value the editor renders from on every keystroke.

Why this is mandatory: a reactive `useQuery` re-fires whenever the underlying row changes. If an editor's content were bound directly to that query result, every server echo — including the user's *own* debounced write coming back — would replace the editor's document, resetting selection and **clobbering the cursor** (the exact failure listed in the plan's risk register). Convex queries are reactive by design; the fix is not to fight that, it is to keep the editor out of the reactive render path.

So the query result is used for exactly two things:

1. **Hydration on open** — when a document is first loaded into a pane, seed the editor once from `documents.get`.
2. **Hydration when a pane is idle** — when a pane is not focused, it may re-seed from a newer query result (see §3). A focused pane never re-seeds from the query.

```
focused pane:   keystrokes ──► local editor state ──(debounced)──► Convex mutation
                                     ▲
                                     └─ seeded ONCE on open; never re-bound to useQuery

idle pane:      Convex query ──► (idle + last-writer guard) ──► re-hydrate local editor
```

---

## 2. Debounced persistence

Typing never touches the network. The editor pushes its **canonical Markdown** (D1) to Convex only after the user pauses.

- On each local change, (re)start an idle timer of **~500 ms–1 s**.
- When the timer fires (the user stopped typing), call the appropriate mutation with the current canonical Markdown and word count.
- A new keystroke during the window resets the timer — bursts of typing produce one write, not one per character.

```ts
// Conceptual: debounced flush from a focused pane. The editor owns `getCanonicalMarkdown()`.
const flush = useDebouncedCallback(async () => {
  const markdown = editor.getCanonicalMarkdown(); // serialized from the in-memory MDAST
  const wordCount = countWords(markdown);
  const res = await updateMarkdown({
    documentId,
    markdown,
    wordCount,
    expectedUpdatedAt, // stale-version guard — see §5
  });
  if (res.stale) {
    // A newer write landed from another device; do NOT overwrite again here.
    // Surface for re-hydration of idle panes; keep focused-pane local edits intact.
    markPaneNeedsRehydrate(documentId);
  } else {
    expectedUpdatedAt = res.updatedAt;
  }
}, DEBOUNCE_MS); // 500–1000
```

Two distinct rhythms write to the backend (see [`03-data-model.md`](./03-data-model.md) §3):

- **`documents.updateMarkdown`** — the autosave of the live text, on every debounced idle. This is the "never lose a word" guarantee.
- **`docNodes.append`** — appends an immutable undo-tree node only for meaningful edit *groups* (not every debounce). The history cadence is coarser than the autosave cadence; see [`07-undo-tree.md`](./07-undo-tree.md).

`workspace.save` follows the same debounced posture for layout/pane changes — never on a hot path (see [`09-documents-workspace-split.md`](./09-documents-workspace-split.md)).

---

## 3. Reactive hydration (how other devices reflect changes)

Convex queries are reactive, so an **idle** pane on another device (or another tab) sees the new `documents.updatedAt`/`markdown` automatically once a write lands. The job here is to apply that update *without* echoing the user's own writes back into the **focused** editor.

The guard has two parts:

1. **Idle-only re-seed.** Only a pane that is **not focused** re-hydrates from a fresh query result. The focused pane is authoritative; it ignores query echoes entirely. A pane re-seeds when it regains focus only if it was flagged stale while idle.
2. **Last-writer guard.** Each write carries an `origin` (the device/client id, persisted on `docNodes.origin`). When a query result arrives, a pane ignores updates whose newest change originated from *itself within its own debounce window* — that is the round-trip of its own save, not a remote change. Remote-origin updates (different `origin`, or newer `updatedAt` than this pane last wrote) are the ones that trigger an idle re-hydrate.

```
Device A (focused, typing) ──► updateMarkdown(origin=A) ──► documents row updated
                                                               │ reactive
Device B (idle pane on same doc) ◄── useQuery fires ──────────┘
   └─ origin=A ≠ B, updatedAt newer ⇒ re-seed B's local editor from documents.markdown

Device A's own idle pane ◄── useQuery fires ──┐
   └─ origin=A == A within debounce window ⇒ ignore (don't echo own write)
```

The net effect: sit down at any machine and the latest text is there, the cursor of whatever you're actively typing in is never disturbed, and you never see your own keystrokes "bounce" back.

---

## 4. Optimistic updates — narrow by design

Convex supports client optimistic updates (<https://docs.convex.dev/client/react/optimistic-updates>). Recto uses them **only for list/derived UI**, **never for the actively-edited field**.

Allowed:

- Document list re-ordering / title change in the switcher after `rename`.
- New document appearing immediately after `create`.
- A version tag appearing in the history list after `versions.create`.

Forbidden:

- Optimistically updating `documents.markdown` for the document open in a focused pane. The editor already owns that state locally (§1); an optimistic update to the same field would re-enter the reactive path and risk a cursor clobber. The local editor *is* the optimism — no mirror needed.

Hard rule when writing any optimistic update: **never mutate objects in place; create new ones.** The optimistic store is shared; in-place mutation corrupts other queries' cached results.

```ts
// CORRECT — build new objects.
const renameDocument = useMutation(api.documents.rename).withOptimisticUpdate(
  (store, { documentId, title }) => {
    const list = store.getQuery(api.documents.list, {});
    if (!list) return;
    store.setQuery(
      api.documents.list,
      {},
      list.map((d) =>
        d._id === documentId ? { ...d, title } : d, // new object, not d.title = title
      ),
    );
  },
);
```

---

## 5. Multi-device / multi-tab concurrency (one user)

Recto is single-user (README §1), so there is no real-time *collaboration* problem. There is still a **single-writer-across-many-surfaces** problem: the same one person can have the same document open on a laptop and a desktop, or in two tabs. The model is **debounced last-write-wins**, with three layers of protection.

### 5.1 What Convex gives us for free: OCC

Convex mutations run under **optimistic concurrency control** (<https://docs.convex.dev/database/advanced/occ>). If two mutations' read/write sets conflict, Convex automatically retries the loser (**up to ~32 times**) so neither is silently dropped at the transaction level. This means *overlapping* mutations are serialized correctly — we never get a torn write or a lost row insert.

What OCC does **not** solve: two "replace the whole `markdown` field" writes that both completed validly. OCC serializes them; the second still **overwrites** the first. That is last-write-wins at the application level, and it is the behavior we accept (D10).

### 5.2 The clobber window

The only data-loss risk is narrow: the **same document edited on two devices within the debounce window**. Device A types, A's ~500 ms–1 s timer hasn't fired; Device B (which had a slightly stale copy) types and its timer fires first, writing B's markdown; then A's timer fires and writes A's markdown over B's. Edits B made in that sub-second window are overwritten in the live `documents.markdown`.

### 5.3 Mitigations

1. **Stale-version guard via `documents.updatedAt`.** Every `updateMarkdown` carries `expectedUpdatedAt`. The mutation overwrites only if the stored `updatedAt` still equals it; otherwise it returns `{ stale: true }` and does **not** overwrite (see [`03-data-model.md`](./03-data-model.md) §3.1). The losing device then re-hydrates its idle pane instead of blindly stomping the newer write.
2. **Re-hydrate idle panes.** As soon as a remote write lands, idle panes on the same document re-seed (§3), so a device that was behind catches up rather than racing with stale text.
3. **The version-history safety net.** Even in the rare case where a clobber does overwrite live text, the overwritten content is not gone: it was captured as an immutable `docNodes` node (and possibly a tagged `version`). Recovery is an **additive restore** from history — never a destructive rewrite. See [`08-version-control.md`](./08-version-control.md).

The combination — OCC serialization, the stale guard, idle re-hydration, and the append-only history — shrinks the loss window to "edits made on two machines inside the same sub-second pause," and even those are recoverable from the DAG.

---

## 6. Offline posture

`@convex-dev/prosemirror-sync` has **no offline support today** — it is roadmap-only as of **v0.2.4** (<https://github.com/get-convex/prosemirror-sync>). Recto does not depend on it for sync anyway (§7), so offline is handled in the app layer:

- **Local draft buffer.** A focused editor mirrors its canonical Markdown to a small local buffer (`localStorage`, or IndexedDB for larger docs), keyed by `documentId`, on the same debounce tick as the network flush. This is purely a crash/offline safety copy — it is **not** the live editor state (§1).
- **Flush on reconnect.** When connectivity returns, the buffered Markdown is pushed via `updateMarkdown` (subject to the §5 stale guard). If the document moved on while offline, the stale guard prevents a blind overwrite and the buffered text is offered as a restore rather than auto-applied.
- **Warn on unsynced close.** If there are buffered changes not yet acknowledged by Convex, a `beforeunload` warning fires so a tab/window isn't closed with unsynced text.

Offline is a *resilience* feature (don't lose words during a blip), not a collaboration feature. There is no offline conflict-merge engine; reconnection reconciles via last-write-wins plus the stale guard plus the append-only history net.

---

## 7. Why we don't use prosemirror-sync, Yjs, or any CRDT/OT

This is the ADR summary; the full rationale and rejected alternatives live in [`14-tech-decisions.md`](./14-tech-decisions.md).

| Approach | Why it's rejected for Recto |
|----------|------------------------------|
| `@convex-dev/prosemirror-sync` (<https://github.com/get-convex/prosemirror-sync>) | It is a **collaborative** editor sync layer for ProseMirror, and it makes **ProseMirror JSON the canonical, synced document**. Recto's canon is a **remark MDAST persisted as a Markdown string** (D1). Adopting it would force PM-JSON as the source of truth and **undercut losslessness** — the exact round-trip degradation Recto is built to avoid. It also has no offline support (v0.2.4, §6). |
| **Yjs** (or any CRDT) | CRDTs exist to merge **concurrent edits from multiple writers** without a central authority. Recto has **one writer** (single user, README §1). A CRDT would impose a second, parallel document representation alongside the canonical Markdown, ongoing merge metadata overhead, and a binary update channel — solving a multi-writer merge problem we **do not have**. |
| **OT** (operational transform) | Same mismatch: OT is machinery for transforming **concurrent operations from multiple participants** into a consistent order. With a single user, ordering across devices is adequately handled by Convex OCC + debounced last-write-wins + the stale guard (§5). OT adds transform complexity for a conflict class that does not occur. |

What we use instead is exactly what the single-user, lossless-Markdown design calls for: the local editor owns live state (§1), debounced last-write-wins persistence of the canonical Markdown (§2, §5), reactive idle hydration (§3), and the append-only undo DAG as the durable history/recovery net ([`07-undo-tree.md`](./07-undo-tree.md), [`08-version-control.md`](./08-version-control.md)). Simpler, lossless, and matched to the actual problem.

---

## 8. What syncs and what stays on the device (ADR-21)

Two stores hold the studio's preferences, and the boundary between them is a
product decision, not a technical one.

**localStorage holds everything**, under `recto:studio-settings`. It is
synchronous, so the studio never flashes defaults while a Convex query is in
flight; it is what the pre-paint appearance script reads; and it is the whole
story while signed out or offline. A device id lives beside it under
`recto:device-id` — a random UUID, no fingerprinting.

**Convex holds a subset**, in the `settings` table as one opaque JSON object.
The test for what belongs there is whether the setting is about the **writer**
or about the **screen in front of them**.

| Stays on the device | Why |
|---|---|
| `appearance` | Answers "is this room dark right now". It already defaults to `system`, which is a per-device answer from the OS; syncing it would let a desk at midnight force dark mode on a phone in daylight. |
| `readingScale` | Calibrated against one display's size and viewing distance. A comfortable 1.6× on a phone is unreadable zoom on a 27" monitor. |
| `topToolbar` | Window furniture. A phone has no room for it. |
| `outlineOpen` | Window furniture. Syncing it would let a desktop session close a panel on a tablet mid-sentence. |

| Syncs | Why |
|---|---|
| `theme` | Taste, not environment. The palette is part of how the writer's studio looks to them, and it should follow onto a new machine. (`appearance` decides *whether* a dark palette applies at all, which is why the two split differently.) |
| `readingFont`, `spellcheck`, `smartPaste` | How the writer works with text. |
| `diffGranularity`, `diffLayout` | How they read their own history. |
| `wordGoalTarget`, `wordGoalKind`, `dailyGoalTarget`, `goalStyle`, `goalScope` | Goals belong to the writer. The streak data behind them (`writingStats`) is already per-user, so keeping the target per-device would have shown one person two different goals against one streak. |
| `typewriter`, `focusDim`, `focusDimScope` | Focus-mode habits. |
| `lint`, `lintCategories` | Which prose rules this writer wants held to. |
| `previewVariant` | Whether they are writing a newsletter. |
| `aiEnabled`, `aiTransformMode` | AI posture, which is a stance, not a screen. Note this is a preference, not consent: it does not carry the 5.1.2(i) consent record. |

### 8.1 How the two stay in step

1. **localStorage is written on every change**, signed in or not.
2. **On first hydration the server wins.** A device that has never signed in on
   this account seeds the server from its own localStorage; after that, signing
   in on a new machine adopts the writer's settings rather than pushing that
   machine's defaults over them.
3. **Pushes are debounced 800 ms and always compare-and-set.** The hook tracks
   which settings *this device* changed and has not had accepted. On a lost CAS
   it takes the winner's values for every setting this device did not touch,
   keeps the one it did, and writes again on top of the winner's stamp — so the
   writer's most recent click survives *and* a stale tab cannot revert another
   device. A failed save (offline, rejected) leaves those keys dirty and a
   backoff timer re-sends them; nothing is dropped.
4. **A key the server does not carry keeps its local value, and a key this
   BUILD does not know is carried through untouched.** `SYNCED_KEYS` is compiled
   from the running build's defaults, so an older web client's idea of "the whole
   object" is missing every setting a newer native client added. Those
   properties ride along in a sidecar (`pickUnknown`) and are written back with
   every save, so opening the web app cannot silently reset an iPad's
   preferences.
5. **The device-local keys are filtered on the way out and on the way in.** The
   server never sees them, and a blob that somehow contains them cannot change
   this device's appearance or zoom.

Pane layout is the same story one level up: it lives in `workspaces`, keyed by
`(userId, deviceId)` — see [`03-data-model.md`](./03-data-model.md) §3.4.
