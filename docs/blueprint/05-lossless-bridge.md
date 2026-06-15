# 05 — The Lossless Bridge (live two-mode sync)

> This is the most technically critical file in the blueprint. It specifies **the bridge**: the live, two-way synchronization that lets two different editor engines edit **one** document at the same time, losslessly, without cursor jumps or feedback loops.
>
> It is self-contained. Where it touches sibling specs it cross-references them by exact filename: [`02-architecture.md`](./02-architecture.md) (the canonical-model spine), [`04-editor-modes.md`](./04-editor-modes.md) (the four modes and mode-switch UX), [`06-markdown-dialect.md`](./06-markdown-dialect.md) (the supported dialect and serialization/normalization rules, which define the losslessness boundary), and the Phase 0 spike that decides whether the live bridge ships or falls back: [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md).
>
> This file must never contradict the locked decisions **D1–D15** in [`README.md`](./README.md). If it appears to, the README wins.

---

## 1. Problem statement

Per **D6**, the same document can be open in **two live, editable modes at once** — for example a rich-text [Milkdown](https://milkdown.dev/) pane **and** a raw-Markdown [CodeMirror 6](https://codemirror.net/) pane, side by side, both accepting keystrokes. A single pane can also **switch** modes (rich → raw, raw → rich) on demand. Both behaviours must be **instant and lossless** (product principles 3 and 4, **D2**).

The difficulty is that **rich text and raw Markdown are different *representations* of the same content**:

- The rich pane edits a **tree** — a ProseMirror document whose node model *is* a remark **MDAST** (**D1**, **D3**). A keystroke there is a structural transaction (insert a text node, wrap a paragraph in a list item, toggle a `strong` mark).
- The raw pane edits a **flat string** — the serialized Markdown of that same tree, character by character. A keystroke there is a text-range replacement at some offset.

These are not two copies of one format; they are two **projections** of one model. Keeping them live therefore means **translating every edit from one representation into the other in real time** — and doing it without the two failure modes that kill naive implementations:

1. **Cursor jumps** — if propagating an edit replaces the *whole* other document, that engine loses its selection and scroll, and the cursor snaps to the start or end. Unacceptable for a writing tool where you may be typing in *both* panes in a session.
2. **Feedback loops** — pane A's edit updates pane B; pane B's "change" handler fires and tries to update pane A; which fires A's handler; and so on. Without an origin guard this either oscillates or doubles every keystroke.

This file specifies the mechanism that solves both: a **single canonical model as the bus**, **stable serialization** so both directions converge on identical bytes, **minimal diff-based propagation** so cursors survive, and an **origin-guarded, throttled, versioned** update protocol so edits never echo.

> **Scope note.** Vim mode is CodeMirror with `@replit/codemirror-vim` layered on top (**D4**); for the purposes of the bridge, **Vim and raw Markdown are the same engine** — both are CodeMirror editing the canonical Markdown string. "Raw" below means "any CodeMirror text pane." Preview (**D5**) is read-only and is not part of the live two-way bridge; it simply re-renders from the canonical model (see [`04-editor-modes.md`](./04-editor-modes.md)).

---

## 2. The canonical bus

> **The remark MDAST is the single in-memory truth per open document.** Both engines edit *that*, indirectly. Neither engine is the source of truth; the model is. This is the one architectural rule (**D2**) applied to the live case.

```
                       ┌───────────────────────────────────────────┐
                       │   CANONICAL MODEL (per open document)       │
                       │                                             │
   Milkdown            │      remark MDAST  ── stringify ──▶ String  │            CodeMirror
  (rich, D3) ◀────────▶│  (truth in memory)                          │◀──────────▶ (raw/Vim, D4)
   ProseMirror doc     │      ▲   the Milkdown ProseMirror doc        │            text document
   == this MDAST       │      │   *is* this MDAST (no conversion)     │            == this String
                       │      └── parse ◀── String                    │
                       └───────────────────────────────────────────┘
                                          │
                                          ▼
                              persisted to Convex as a
                              Markdown string (D1, D10)
                            see 10-sync-persistence.md
```

Two consequences of **D3** make this tractable:

1. **Milkdown's model *is* the MDAST.** Milkdown is a ProseMirror editor whose schema and (de)serialization are defined against the remark/unified ecosystem. Rich editing is therefore **not** "edit rich, convert to Markdown later" — it is **editing the canonical tree directly**. There is no second rich format to drift from.
2. **The serialized Markdown string is *derived*, not authored separately.** It is produced from the MDAST by `remark-stringify`. The raw pane edits that derived string; its edits are re-absorbed into the tree by `remark-parse`.

### 2.1 Stable serialization — the convergence requirement

For the bridge to be lossless, **both edit paths must converge on byte-identical Markdown for the same content**. This is the [Quarto "canonical" pattern](https://quarto.org/docs/visual-editor/markdown.html): visual (rich) edits and source (raw) edits produce the *same* Markdown output, so neither pane is privileged and round-tripping does not mutate text. Quarto achieves this with a fixed, opinionated writer configuration; Recto does the same with a **single, frozen `remark-stringify` options object** used **everywhere** the model is serialized — for the bridge, for persistence, for export.

```ts
// canonical/stringify-options.ts
// THE single source of serialization truth. Frozen. Used by the bridge,
// by persistence (see 10-sync-persistence.md), and by export (see 11-clipboard-export.md).
// Do not pass ad-hoc options anywhere else; import this.

import type { Options as StringifyOptions } from "remark-stringify";

export const CANONICAL_STRINGIFY: Readonly<StringifyOptions> = Object.freeze({
  bullet: "-",            // unordered list marker: always "-"
  bulletOrdered: ".",     // ordered list delimiter: "1." not "1)"
  emphasis: "_",          // italic delimiter: always "_"
  strong: "*",            // bold delimiter: always "**"
  fence: "`",             // fenced code uses backticks, never "~"
  fences: true,           // always fence code blocks; never indented code
  listItemIndent: "one",  // one space after the marker
  rule: "-",              // thematic break is "---"
  ruleRepetition: 3,
  ruleSpaces: false,
  setext: false,          // ATX headings ("# H1"), never setext underlines
  tightDefinitions: true,
  resourceLink: false,
  // hard breaks: backslash, not trailing-two-spaces (see 06 + §10 soft-break note)
  // escape policy is fixed by the dialect plugins (gfm, frontmatter); see 06-markdown-dialect.md
});
```

> The exact, authoritative values of every knob — bullet marker, emphasis/strong markers, ATX vs setext headings, fence style, list-item indent, hard-break style, the escape policy, and the GFM/footnote/frontmatter extensions — are owned by [`06-markdown-dialect.md`](./06-markdown-dialect.md). The bridge **consumes** that frozen configuration; it does not define it. The contract the bridge depends on is only this: **for a given MDAST there is exactly one serialized string, deterministically.**

Why stability is non-negotiable for the bridge: if `remark-stringify` could emit `*italic*` one time and `_italic_` another, then typing in the rich pane and typing in the raw pane could produce two *textually different but semantically identical* strings. Every such divergence would force a real text change to be pushed across the bridge, moving the other pane's cursor for no reason — and over many cycles would manifest as the same **progressive round-trip drift** documented for TipTap (§10). A frozen writer makes serialization a pure function of the tree, which is what lets the diff in §3 be *minimal* (usually empty).

---

## 3. Rich → raw propagation

When the user edits the **rich** (Milkdown) pane, that pane mutates the canonical MDAST directly (it is the model). The raw pane must reflect the new content **without losing its own cursor or scroll**.

Naive approach (rejected): `cm.dispatch({ changes: { from: 0, to: doc.length, insert: newMarkdown } })` — replace the entire CodeMirror document. This works textually but **collapses the selection** and resets scroll. Rejected per problem statement failure mode 1.

Correct approach: **stringify, then apply a minimal text diff.**

1. On a rich edit (throttled — see §6), serialize the current MDAST with `CANONICAL_STRINGIFY` to get `nextMarkdown`.
2. Compute the **minimal set of change ranges** between the CodeMirror document's current text (`prevMarkdown`) and `nextMarkdown`. A standard prefix/suffix-trimmed diff is sufficient and cheap: find the longest common prefix and suffix, the middle is the single (or few) changed range(s).
3. Dispatch **one CodeMirror transaction** containing only those ranges, tagged with the bridge origin annotation (§5).

CodeMirror's transaction system maps the existing selection through the change set automatically (`tr.changes.mapPos`), so a cursor sitting *after* an untouched region stays put; only a cursor *inside* a changed range moves, which is correct.

```ts
// bridge/rich-to-raw.ts
import { ChangeSet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Root } from "mdast";

import { CANONICAL_STRINGIFY } from "../canonical/stringify-options";
import { bridgeOrigin, bridge } from "./protocol"; // §5

// Minimal change ranges via common prefix/suffix trim.
function diffRanges(prev: string, next: string) {
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev--;
    endNext--;
  }
  // Single contiguous change: replace prev[start..endPrev) with next[start..endNext).
  return { from: start, to: endPrev, insert: next.slice(start, endNext) };
}

export function propagateRichToRaw(cm: EditorView, mdast: Root) {
  const next = stringifyCanonical(mdast);          // remark-stringify(CANONICAL_STRINGIFY)
  const prev = cm.state.doc.toString();
  if (next === prev) return;                        // converged: nothing to do (the common case)

  const change = diffRanges(prev, next);
  bridge.beginApplying();                           // raise the "applying" guard (§5)
  try {
    cm.dispatch({
      changes: change,
      annotations: bridgeOrigin.of(bridge.nextVersion()), // tag as programmatic (§5)
      scrollIntoView: false,                        // do not yank scroll in an unfocused pane
    });
  } finally {
    bridge.endApplying();
  }
}
```

The decisive property: when the two panes are already converged (the steady state, thanks to stable serialization), `next === prev` and **no transaction is dispatched at all** — the raw pane is untouched and its cursor cannot move.

---

## 4. Raw → rich propagation

When the user edits the **raw** (CodeMirror) pane, the canonical model must be updated and the **rich** (Milkdown) pane must reflect it — again **without losing the rich pane's cursor or scroll**.

Naive approach (rejected): re-parse the Markdown, build a fresh ProseMirror doc, and `replaceWith` the whole document. This nukes the rich selection and scroll (failure mode 1) and is also the structural equivalent of the convert-on-every-change anti-pattern (§10).

Correct approach: **parse to a new doc, then diff the old doc against the new doc and apply only the resulting steps.**

1. On a raw edit (throttled — §6), `remark-parse` the CodeMirror text into a new MDAST, then use Milkdown's parser to produce the corresponding new ProseMirror document `nextDoc`. (Because Milkdown's model *is* MDAST, this is a faithful projection, not a lossy conversion.)
2. Compute the ProseMirror **steps** that transform the *current* live doc into `nextDoc` using a **doc-diff → steps** algorithm — `recreateTransform` from **`prosemirror-recreate-steps`** (the package pinned in the stack table of [`README.md`](./README.md), §6 "Stack"). This is the tool whose job is exactly this: *recreate the set of steps that turn document A into document B when you don't have the original steps.* It returns a `Transform` whose `.steps` are mostly `ReplaceStep`s confined to the regions that actually changed.
3. Apply those steps to the **live** ProseMirror state inside a single transaction tagged with the bridge meta (§5). Because the edit is expressed as **localized steps** rather than a whole-doc replacement, ProseMirror's position mapping carries the rich selection through correctly — a cursor outside the changed region does not move.

```ts
// bridge/raw-to-rich.ts
import { recreateTransform } from "prosemirror-recreate-steps";
//   ^ package per README.md stack table (D — Rich↔raw diffing).
//   Maintained scoped forks exist if the unscoped publish lags ProseMirror's core
//   (e.g. @manuscripts/prosemirror-recreate-steps, prosemirror-recreate-transform);
//   the Phase 0 spike (../plan/phase-0-spikes.md) pins the exact build. API is identical:
//   recreateTransform(startDoc, endDoc, opts) -> Transform.

import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

import { bridge, BRIDGE_META } from "./protocol"; // §5

export function propagateRawToRich(pmView: EditorView, nextDoc: PMNode) {
  const { state } = pmView;
  const curDoc = state.doc;
  if (curDoc.eq(nextDoc)) return;                   // converged: no-op (common case)

  // Doc-diff -> minimal steps. Options chosen for a prose editor:
  const tr = recreateTransform(curDoc, nextDoc, {
    complexSteps: true,   // allow mark/structure steps, not only ReplaceStep
    wordDiffs: false,     // character-granular text diffs (snappier, smaller steps)
    simplifyDiffs: true,  // merge adjacent steps where safe
  });

  // Replay recreated steps onto the *live* doc so selection maps through them.
  const live = state.tr;
  for (const step of tr.steps) live.step(step.map(live.mapping) ?? step);

  // Map the existing selection through the change and keep it.
  live.setSelection(state.selection.map(live.doc, live.mapping));
  live.setMeta(BRIDGE_META, bridge.nextVersion()); // tag as programmatic (§5)
  live.setMeta("addToHistory", false);             // bridge updates are not separate undo steps; see 07-undo-tree.md

  bridge.beginApplying();
  try {
    pmView.dispatch(live);
  } finally {
    bridge.endApplying();
  }
}
```

> **Why `recreateTransform` and not `setContent`/`replaceWith`.** The Milkdown/ProseMirror "replace the document" path is the structural equivalent of TipTap's `setContent(getMarkdown(...))` round-trip — the exact shape that drifts in TipTap issue [#7147](https://github.com/ueberdosis/tiptap/issues/7147) (§10). Diffing two docs into steps (the approach in [`prosemirror-markdown`](https://github.com/ProseMirror/prosemirror-markdown)-based editors and formalized by `prosemirror-recreate-steps`) keeps the change *surgical* and the cursor *mapped*, instead of throwing the document away and rebuilding it.

---

## 5. Feedback-loop prevention

The bridge is bidirectional, so every programmatic update **must be distinguishable from a human edit**, or pane A's update to pane B will echo straight back. Recto prevents echoes with **three overlapping guards** — defence in depth, because any single one can be bypassed by an engine's internal async dispatch.

1. **Origin / annotation tag.** Every programmatic transaction is tagged: in CodeMirror via a custom `Annotation` (`bridgeOrigin`), in ProseMirror via transaction meta (`BRIDGE_META`). A change handler that sees the bridge tag returns immediately and does **not** propagate.
2. **An "applying" guard.** A boolean (really a small counter to tolerate re-entrancy) raised for the synchronous duration of a programmatic dispatch. While raised, *all* change handlers short-circuit — covering engines that fire listeners without preserving the annotation.
3. **A monotonically increasing version counter.** Each accepted human edit bumps `version`. A programmatic update stamps the version it was *derived from*; a stale update (derived from an older version than the model currently holds) is dropped. This resolves the race where both panes are edited within the same throttle window: the loser's projection is simply discarded and recomputed from the current model.

```ts
// bridge/protocol.ts
import { Annotation } from "@codemirror/state";

export const bridgeOrigin = Annotation.define<number>(); // carries the source version
export const BRIDGE_META = "recto/bridge";

export class Bridge {
  private version = 0;
  private applyingDepth = 0;

  /** True while a programmatic projection is being dispatched. */
  get isApplying() { return this.applyingDepth > 0; }
  beginApplying() { this.applyingDepth++; }
  endApplying() { this.applyingDepth = Math.max(0, this.applyingDepth - 1); }

  /** A human edit was accepted into the model; advances the canonical version. */
  bumpVersion() { return ++this.version; }
  get currentVersion() { return this.version; }

  /** Stamp for a programmatic update (derived-from version). */
  nextVersion() { return this.version; }

  /** Should this incoming change be treated as a human edit worth propagating? */
  shouldPropagate(isProgrammatic: boolean): boolean {
    if (this.isApplying) return false;   // guard 2
    if (isProgrammatic) return false;    // guard 1
    return true;
  }

  /** Drop a projection computed from a now-stale model version. */
  isStale(derivedFromVersion: number): boolean {
    return derivedFromVersion < this.version; // guard 3
  }
}

export const bridge = new Bridge();
```

Handler wiring (each engine), conceptually:

```ts
// CodeMirror updateListener (raw -> model -> rich)
EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  const isProgrammatic = update.transactions.some(t => t.annotation(bridgeOrigin) != null);
  if (!bridge.shouldPropagate(isProgrammatic)) return;
  bridge.bumpVersion();
  scheduleRawToRich(update.state.doc.toString()); // throttled, §6
});

// ProseMirror dispatchTransaction (rich -> model -> raw)
function dispatchTransaction(tr) {
  view.updateState(view.state.apply(tr));
  if (!tr.docChanged) return;
  const isProgrammatic = tr.getMeta(BRIDGE_META) != null;
  if (!bridge.shouldPropagate(isProgrammatic)) return;
  bridge.bumpVersion();
  scheduleRichToRaw(currentMdastFrom(view.state)); // throttled, §6
}
```

The combination is what makes the loop provably terminate: a programmatic update can never satisfy `shouldPropagate`, so it has no return path; and `isStale` guarantees that even a contested same-window edit collapses to a single fixpoint (the latest human edit), recomputed once.

---

## 6. Throttling & batching

Propagation across engines is **throttled**, not run per keystroke.

- A **rich → raw** projection is `remark-stringify` + a string diff + one CM transaction.
- A **raw → rich** projection is `remark-parse` + a Milkdown parse + a doc-diff (`recreateTransform`) + one PM transaction.

The raw→rich path in particular (full reparse + structural diff) is the heavier of the two. Running it on every keystroke would make typing in the raw pane feel laggy under fast input — and it is wasted work, because intermediate keystrokes are immediately superseded.

The bridge therefore schedules each direction on a **short trailing throttle** (target ~30–60 ms, tuned in the Phase 0 spike) with **leading** behaviour so the *first* keystroke projects immediately and subsequent ones within the window coalesce:

```ts
// bridge/schedule.ts
function throttleTrailing<T extends unknown[]>(fn: (...a: T) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  return (...args: T) => {
    pending = args;
    const now = performance.now();
    const wait = Math.max(0, ms - (now - last));
    if (wait === 0 && timer === null) {           // leading edge: project now
      last = now; fn(...(pending as T)); pending = null;
    } else if (timer === null) {                   // trailing edge: coalesce burst
      timer = setTimeout(() => {
        timer = null; last = performance.now();
        if (pending) { fn(...pending); pending = null; }
      }, wait);
    }
  };
}

export const scheduleRichToRaw = throttleTrailing(propagateRichToRawFromMdast, 50);
export const scheduleRawToRich = throttleTrailing(propagateRawToRichFromText, 50);
```

Why a short throttle keeps it snappy:

- **Typing is never blocked.** The engine you are typing in owns its live state (**D11**); the throttled projection runs *after* your keystroke is already on screen, on a microtask/timer, never on the input critical path.
- **Bursts coalesce.** Holding a key or pasting fires many edits; the trailing throttle reparses **once** at the end of the burst instead of N times.
- **Convergence makes most projections free.** Thanks to stable serialization (§2.1) and the `===`/`.eq()` short-circuits in §3–§4, a projection that produces no net change costs a stringify/parse and exits with **zero** transactions.

> This throttling is distinct from, and sits *upstream* of, the **debounced persistence to Convex** described in [`10-sync-persistence.md`](./10-sync-persistence.md). The bridge keeps the two panes in sync within ~50 ms; persistence batches the canonical Markdown to the backend on a longer debounce. Two independent timers, two independent concerns.

---

## 7. Cursor & selection preservation across reprojection

This is the heart of why the bridge feels seamless. Each engine already has a robust position-mapping system; the bridge's job is to express updates as **change sets / steps** so those systems can do their work, never as whole-document replacements.

- **Raw pane (CodeMirror).** A transaction carries a `ChangeSet`; CodeMirror remaps the selection through it (`selection.map(changes)`) automatically. Because §3 dispatches only the minimal changed ranges, a selection anchored *outside* a change is unmoved; a selection *inside* a replaced range is clamped to the change boundary (the only correct behaviour — the text it pointed at is gone). Scroll is preserved by passing `scrollIntoView: false` for programmatic updates so an **unfocused** raw pane never scrolls itself.
- **Rich pane (ProseMirror/Milkdown).** Recreated steps produce a `Mapping`; §4 maps the prior selection through it (`selection.map(doc, mapping)`) and re-sets it on the transaction. A cursor outside the changed subtree keeps its document position; one inside is mapped to the nearest valid position.

**Which pane preserves what:**

| Pane | Role in this propagation | Selection behaviour |
|------|--------------------------|---------------------|
| **Focused** (the one being typed in) | Source of the human edit | Untouched — the bridge never writes back to the focused pane within the same edit (origin guard, §5) |
| **Non-focused** (receiving the projection) | Target of the programmatic update | Selection **mapped** through the diff/steps and retained; scroll **not** forced |

In short: the pane you are typing in is never disturbed by the bridge, and the *other* pane keeps its cursor where the content it pointed at still is. Selections only collapse/clamp when the underlying text genuinely changed beneath them, which is unavoidable and expected.

---

## 8. Mode SWITCH vs LIVE SYNC

Both behaviours **flow through the canonical model** (**D2**). They differ only in topology.

### 8.1 Live sync — two panes, one document, different modes (the bridge proper)

Two panes are bound to the **same** document but different modes (rich + raw). Both are mounted and live. Every human edit in either pane runs the throttled, origin-guarded propagation of §3–§6 into the *other*. This is the case the whole file describes. See [`09-documents-workspace-split.md`](./09-documents-workspace-split.md) for how the pane tree binds two panes to one document.

```
   [ rich pane ] --human edit--> MDAST (bumpVersion) --§3 diff--> [ raw pane ]  (selection mapped)
   [ raw pane  ] --human edit--> MDAST (bumpVersion) --§4 steps--> [ rich pane ] (selection mapped)
                  ^ origin-guarded both ways: no echo (§5)
```

### 8.2 Mode switch — one pane changes its own mode

A single pane swaps the engine it renders **through** (e.g. user hits the mode shortcut; see [`04-editor-modes.md`](./04-editor-modes.md) and [`13-keyboard-commands.md`](./13-keyboard-commands.md)). There is no second pane to sync; the switch is a **handoff via the canonical model**:

1. The outgoing engine has been keeping the canonical MDAST current (rich pane *is* the MDAST; raw pane's text was parsed into it on its last throttled tick — flush any pending throttle synchronously first).
2. Tear down the outgoing engine; mount the incoming engine **from the canonical model** — rich mounts the MDAST directly; raw mounts `stringifyCanonical(mdast)`.
3. Translate the caret: map the outgoing selection to a model position, then to the incoming engine's coordinate space (a Markdown character offset ↔ a ProseMirror document position, computed from the same parse), so the cursor lands at the *same logical place* in the text.

```ts
// modes/switch.ts (sketch) — see 04-editor-modes.md for the full mode-switch UX
export function switchPaneMode(pane: Pane, to: Mode, model: CanonicalDoc) {
  flushPendingThrottles(pane);              // ensure model reflects the outgoing engine
  const caret = pane.engine.exportCaret(model); // logical caret in model space
  pane.engine.destroy();
  pane.engine = mountEngine(to, model);     // mount from the canonical model, not from the old engine
  pane.engine.importCaret(caret, model);    // restore caret at the same logical position
}
```

> **Critical:** a mode switch is **not** a format conversion (**D2**, principle 3). It is reproject-the-same-tree-through-a-different-engine. This is precisely why a switch is lossless where a convert-on-switch design is not (§10).

The two behaviours are unified: **the bridge in §8.1 is just §8.2 happening continuously and on both panes at once.** Whether you switch a pane's mode or split a doc into two live modes, the only mutated thing is the canonical MDAST.

---

## 9. Lossless guarantees and their boundary

The losslessness promise (principle 3, **D2**) is **bounded by the supported dialect**:

> **Guarantee.** For any content expressible in the supported Markdown dialect — CommonMark + GFM (tables, task lists, strikethrough, autolinks) + footnotes + YAML frontmatter (**D7**, enumerated in full in [`06-markdown-dialect.md`](./06-markdown-dialect.md)) — round-tripping content **rich → raw → rich** (and **raw → rich → raw**) returns **byte-identical** Markdown after the first normalization.

Two mechanisms make this true and keep it true:

1. **The rich editor can only ever produce dialect constructs (D7, README §8).** There are no rich-only features without a Markdown representation, so the MDAST never contains a node that `remark-stringify` cannot faithfully emit. Losslessness cannot be broken by a feature that has no serialization.
2. **Normalization is a one-time idempotent step, not a per-cycle mutation.** The *first* time a string passes through the model it is normalized to canonical form (canonical bullet, emphasis, fence, heading style, etc., per §2.1 / [`06-markdown-dialect.md`](./06-markdown-dialect.md)). Because `CANONICAL_STRINGIFY` is a pure function of the tree, the **second and every subsequent** pass produce the *same* bytes: `serialize(parse(x)) === x` once `x` is canonical. There is no progressive change because there is no per-cycle variability to accumulate. This is the formal statement of the README's round-trip definition: `serialize(parse(markdown)) === normalize(markdown)`.

**Boundary, stated plainly.** Content *outside* the dialect is out of scope (it cannot be authored in the rich pane, and is handled by the dialect spec's documented narrowing rather than silently dropped — see [`06-markdown-dialect.md`](./06-markdown-dialect.md) and the risk register in [`../plan/README.md`](../plan/README.md)). Within the dialect, byte-stability is a property test, not a hope (§11).

---

## 10. Known degradation cases — and why Recto avoids each

These are the **real** failure modes the bridge is designed against. They are why **D2** exists.

1. **Convert-on-every-switch → progressive round-trip drift.** The canonical failure: an editor that stores rich state and *converts to/from Markdown on each mode switch or each sync*. Every conversion is slightly lossy or non-idempotent, so the document **degrades a little each cycle** — exactly the bug reported in **TipTap issue [#7147](https://github.com/ueberdosis/tiptap/issues/7147)**: extracting Markdown, parsing it, and extracting again does **not** return identical content; the input and output drift. Recto avoids this structurally: there is **no conversion between two formats** at all. There is one model (MDAST); rich edits *are* edits to it; raw edits *parse into* it; both serialize through one frozen writer. A switch reprojects the same tree (§8.2). Idempotence is a property of a single pure serializer, not of a chain of converters.
2. **Soft-break → space (and kin) serializer quirks.** A classic lossy spot: a soft line break in the source becoming a literal space (or a hard break becoming two trailing spaces, or vice-versa) on serialize, so line structure drifts on round-trip. Recto pins these in `CANONICAL_STRINGIFY` (hard breaks as backslash, defined break handling) and in the dialect's serialize rules ([`06-markdown-dialect.md`](./06-markdown-dialect.md)), then **proves** they hold with the round-trip corpus (§11). Because the writer is fixed, a soft break has exactly one rendering forever.
3. **Whole-document replacement on update → cursor loss masquerading as a sync bug.** Re-`setContent`/`replaceWith` on each external edit not only risks (1), it destroys selection and scroll, which reads to the user as jank. Recto's diff-based propagation (§3 minimal ranges; §4 recreated steps) is the direct countermeasure (§7).

The throughline: **stable serialization + a single canonical model** turn a chain of fragile conversions into a single idempotent projection. Drift requires variability between cycles; there is none.

---

## 11. Test strategy

The bridge guards a core product promise, so it is tested as a **property**, not by spot-checking.

1. **Round-trip corpus (byte-stability).** The shared corpus owned by [`06-markdown-dialect.md`](./06-markdown-dialect.md) — covering every dialect construct, with the notorious cases (nested lists, tables with alignment, task lists, footnote refs+defs, frontmatter, hard vs soft breaks, code fences containing Markdown) — is asserted to satisfy `serialize(parse(normalize(x))) === normalize(x)` for every entry. This is the idempotence proof behind §9/§10.
2. **Cursor-stability harness.** An automated harness drives the two-pane live setup headlessly: place a caret at a known logical position, inject an edit in the *other* pane, run propagation, and assert the observed caret position equals the *expected mapped* position — for inserts/deletes before, inside, and after the caret, in **both** directions. This is the regression net for §7.
3. **No-drift-over-N-cycles.** A fuzz/property test applies a randomized sequence of edits, alternating panes, for many cycles, and asserts: (a) the canonical Markdown is **byte-identical** to a single direct `serialize(parse(...))` of the final content (no accumulation — the anti-#7147 assertion), and (b) no propagation produced a transaction when the panes were already converged (the `===`/`.eq()` short-circuits in §3–§4 fire — proving the steady state is truly idle).
4. **Feedback-loop assertion.** Inject a single human edit and assert exactly **one** `bumpVersion` and **zero** further human-classified changes result (no echo), validating §5.

These tests are **not optional** (see Definition of Done and the testing convention in [`../plan/README.md`](../plan/README.md)).

---

## 12. The fallback (decided by the Phase 0 spike)

Per the **risk register** in [`../plan/README.md`](../plan/README.md): *"Live two-mode sync is janky (cursor jumps, feedback loops)."* The full live bridge of §1–§8 is **unproven** until [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) demonstrates it is smooth on real content. If the spike shows the raw→rich `recreateTransform` path is too slow or the cursor mapping too unstable to feel seamless, Recto **degrades — it does not ship jank:**

- **A single pane uses switch-on-mode only** (§8.2): mode switches still flow through the canonical model and remain lossless, but a pane syncs **only at switch time**, not continuously.
- **Cross-pane live editing is limited to *different* documents.** Two panes may each be live on their own document; the **same** document is **not** held open in two simultaneously-editable modes. (The same doc may still appear in a second pane as read-only **Preview** (**D5**), which has no write-back and so cannot jank.)

This fallback preserves **D1–D5** and the lossless guarantee (§9) intact; it relaxes **only D6** (simultaneous two-mode editing of one document), and only if the spike says so. The decision is made **once, in Phase 0**, and recorded in [`14-tech-decisions.md`](./14-tech-decisions.md). Everything above assumes the spike succeeds; this section is the documented contingency if it does not.

---

## 13. Cross-references

- [`README.md`](./README.md) — locked decisions **D1–D15**; canonical-model rule; stack (the `prosemirror-recreate-steps` pin); glossary ("Bridge", "Round-trip").
- [`02-architecture.md`](./02-architecture.md) — the canonical-model spine and client/server split this bridge lives inside.
- [`04-editor-modes.md`](./04-editor-modes.md) — the four modes, the mode indicator, and the mode-switch UX referenced in §8.2.
- [`06-markdown-dialect.md`](./06-markdown-dialect.md) — **owns** the supported dialect and the frozen serialization/normalization rules this bridge consumes; **owns** the round-trip corpus.
- [`10-sync-persistence.md`](./10-sync-persistence.md) — debounced persistence to Convex, downstream of and independent from the bridge throttle.
- [`../plan/phase-0-spikes.md`](../plan/phase-0-spikes.md) — the throwaway spike that proves the bridge or selects the §12 fallback.

### External references

- TipTap issue #7147 (markdown round-trip drift): <https://github.com/ueberdosis/tiptap/issues/7147>
- Quarto visual editor "canonical Markdown" (visual + source edits produce identical output): <https://quarto.org/docs/visual-editor/markdown.html>
- `prosemirror-markdown` (ProseMirror's Markdown parse/serialize model): <https://github.com/ProseMirror/prosemirror-markdown>
- `prosemirror-recreate-steps` / `recreateTransform` (doc-diff → steps): the README-pinned `prosemirror-recreate-steps`; maintained scoped variants `@manuscripts/prosemirror-recreate-steps` and the `prosemirror-recreate-transform` fork share the identical `recreateTransform(startDoc, endDoc, opts)` API. Exact build pinned by the Phase 0 spike.
