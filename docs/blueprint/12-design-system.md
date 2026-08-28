# Recto — Design System

> Part of the Recto blueprint. The canonical specification is [`./README.md`](./README.md); if anything here contradicts it, the README wins. This file is self-contained: it fully describes Recto's visual and interaction design system — principles, the dark OKLCH color palette, typography and the reading measure, layout and chrome, motion, the component inventory, the application's visible states, and accessibility. It defines the tokens and treatments that other blueprint files reference: the reading typography that styles **Preview** ([`./04-editor-modes.md`](./04-editor-modes.md) §5.2), the surface treatment for split panes ([`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)), and the chrome for the **command palette**, **slash command palette**, **contextual formatting toolbar**, and **mode indicator** ([`./04-editor-modes.md`](./04-editor-modes.md), [`./13-keyboard-commands.md`](./13-keyboard-commands.md)). The dedicated bespoke design pass that turns these tokens into a finished look happens in Phase 5 ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)).

---

## 1. Design principles

Recto's design is governed by README §4 product principles 5 ("the tool disappears"), 6 ("premium and bespoke"), and 7 ("minimalism removes chrome, not safety nets"), and by the paired-appearance decision [ADR-20](./14-tech-decisions.md#adr-20--light-theme-paper-palette--appearance-setting-reverses-d13) (**Twilight dark + Paper light**, which reverses D13). These principles are normative; every token and component below exists to serve them.

| # | Principle | What it means in practice | What it forbids |
|---|-----------|---------------------------|-----------------|
| P1 | **Typography-first — the type IS the UI** | The defining surface of Recto is set type. Hierarchy, rhythm, and state are expressed primarily through typographic treatment (size, weight, color/ink level, measure, spacing), not through boxes, cards, shadows, and borders. The reading surface is the product. | Decorating the page with containers, drop shadows, gradients, or ornamental dividers to create "design." |
| P2 | **The tool disappears** | Minimal chrome. The writing surface dominates every layout. Affordances are contextual (slash palette, contextual toolbar, command palette) and surface on demand, then recede (README §4 P5; [`./04-editor-modes.md`](./04-editor-modes.md) §2.3, §2.4). | Persistent toolbars, ribbons, sidebars-by-default, or any always-on chrome competing with the text for attention. |
| P3 | **Premium and bespoke** | Considered typography, a restrained palette, deliberate motion. The interface should read as designed by hand for one writer, not assembled from defaults. The bespoke pass in Phase 5 ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)) is where this is taken to a finish using the `frontend-design` skill. | A templated shadcn default look: stock radii, stock shadows, the default Inter-on-near-black card aesthetic, generic accent blue. |
| P4 | **Two authored appearances** | Exactly two palettes ship: **Twilight** (dark) and **Paper** (light). Each is authored for its appearance — Paper is not Twilight inverted, and Twilight is not Paper inverted. The appearance follows the system by default, with an explicit override (ADR-20). | Algorithmically inverting one palette to get the other; a third undesigned palette; per-component `light:`/`dark:` overrides instead of tokens that flip. |
| P5 | **Calm and focused** | Low overall luminance, low chroma, generous whitespace, quiet motion. The default emotional register is calm. Color and motion are spent sparingly so that when they appear (a single accent, a brief transition) they carry meaning. | Saturated accents used as decoration, busy animation, attention-grabbing color, high-contrast UI furniture. |
| P6 | **Minimalism removes chrome, not safety nets** | Hiding menus is allowed; dropping word count, the saving/sync indicator, undo/version affordances, or focus rings is not (README §4 P7). Quiet ≠ absent. | Removing the status bar, the saving indicator, the offline indicator, or focus rings "for cleanliness." |

These resolve a tension the rest of the document keeps in view: **maximal calm for the writing surface, never at the cost of the safety nets** (persistence feedback, undo, word count) that README §4 P7 protects.

---

## 2. Color

### 2.1 Authoring model

The palette is authored in **OKLCH** and consumed through **Tailwind v4** (README §6 stack). OKLCH is chosen deliberately: it is perceptually uniform, so equal numeric steps in lightness (`L`) read as equal visual steps, which makes a layered palette tractable and lets us hold chroma low and constant across hues for a calm, coherent surface (P5).

**The values live in one place: [`packages/design-tokens/tokens.json`](../../packages/design-tokens/tokens.json).** Style Dictionary builds it into the CSS custom properties `app/globals.css` imports, a `Colors.xcassets` catalog and `RectoTokens.swift` for the Apple apps, and an sRGB hex table for widgets that cannot parse OKLCH. Change a colour there and run `bun run tokens:build`; a test fails when the committed outputs drift. Never hand-edit a colour in `globals.css`.

The token names below are the **canonical names** — use these everywhere, exactly. Each exists in every palette, so a component references the name and the appearance resolves the value.

| Token | Role |
|-------|------|
| `--color-bg-app` `--color-bg-surface` `--color-bg-raised` `--color-bg-overlay` `--color-bg-hover` | The four background layers plus the hover fill (§2.2) |
| `--color-ink-primary` `--color-ink-secondary` `--color-ink-tertiary` | The three ink levels (§2.3) |
| `--color-on-accent` | Text/icon on an accent or danger **fill** — not the same as ink-primary in light |
| `--color-line` `--color-line-strong` | Hairlines; `-strong` marks the focused pane |
| `--color-accent` `--color-accent-muted` `--color-accent-2` `--color-accent-wash` | The one live affordance, its fill, links, and the selected-row wash |
| `--color-success` `--color-warning` `--color-danger` | Status meaning only, never decoration (§2.4) |
| `--color-lint-passive` `--color-lint-readability` `--color-lint-adverb` `--color-lint-weasel` | Prose-lint squiggles |
| `--color-comment` `--color-comment-wash` `--color-comment-wash-strong` | Comment anchors |
| `--color-selection` `--color-focus-ring` `--color-caret` | Selection wash, focus ring, caret |
| `--atmos-1` `--atmos-2` `--scrim` `--scrim-opaque` | The atmosphere washes and the overlay scrim (plus its reduced-transparency fallback) |
| `--elevation-panel` `--elevation-toolbar` | The only two lifts in the product; tinted, never pure black |
| `--grain-opacity` `--grain-blend` | Film grain — `soft-light` on Twilight, `multiply` on Paper |

### 2.2 Background layers

Recto uses **four background layers**, separated by lightness rather than by drop shadow, keeping with P1/P3 (no stock shadows) and P5 (calm).

On **Twilight**, raising luminance reads as "closer / higher" the way a shadow does on light, so elevation is a step **up** in `L`. On **Paper** the relationship inverts for furniture — `bg-raised` and `bg-overlay` step **down** in `L` — with one deliberate exception: `bg-surface`, the writing sheet, stays **lighter** than `bg-app`. That is the signature the whole design rests on ([`../../plans/023-native-apple-apps-design.md`](../../plans/023-native-apple-apps-design.md) §2: "the sheet on the atmosphere"), and it is asserted in `packages/design-tokens/tokens.test.ts`.

| Token | Role | Used by |
|-------|------|---------|
| `--color-bg-app` | Deepest canvas, behind everything | The app shell behind the pane tree |
| `--color-bg-surface` | The writing surface | Editor surface, each pane's background ([`./04-editor-modes.md`](./04-editor-modes.md)) |
| `--color-bg-raised` | Raised UI furniture | Command palette body, slash command palette, contextual toolbar, status bar |
| `--color-bg-overlay` | Topmost overlay layer | Dialogs, popovers, toasts, the undo-tree/version panels when floated |

The step between adjacent layers is intentionally small (≈0.04 `L`) so the interface reads as one calm field, not stacked cards.

### 2.3 Ink levels

Three ink levels carry the entire text hierarchy (P1). Hierarchy is expressed by ink level and weight before it is ever expressed by a box or rule.

| Token | Level | Use |
|-------|-------|-----|
| `--color-ink-primary` | Primary | Body prose, headings, active values |
| `--color-ink-secondary` | Secondary | Labels, secondary metadata, inactive-but-legible chrome |
| `--color-ink-tertiary` | Tertiary | Placeholders, hints, the at-rest word count, disabled affordances |

### 2.4 Borders, accents, semantics

- **Lines** (`--color-line`, `--color-line-strong`) are hairlines used sparingly — chiefly the pane divider and the few component edges that need definition. The focused pane uses `--color-line-strong`; unfocused panes use `--color-line` (see §4.4).
- **Accents** are restrained (P5). There is **one primary accent** (`--color-accent`, a cool low-chroma hue) and **one secondary accent** (`--color-accent-2`). The primary accent marks the single most important live affordance in view (active selection in the command palette, focus ring, the synced/active state of the saving indicator). The secondary accent is for links and secondary emphasis so that links do not compete with the primary accent's "this is the live thing" meaning.
- **Semantics** (`--color-success`, `--color-warning`, `--color-danger`) are reserved strictly for status meaning: success = saved/synced, warning = unsynced/offline, danger = destructive/error. They are never decorative.

### 2.5 Contrast (WCAG, both appearances)

Contrast is a hard constraint, not a preference (P6, §8). Ink levels are tuned so that:

| Pair | Target | Rationale |
|------|--------|-----------|
| `--color-ink-primary` on `--color-bg-surface` | ≥ 7:1 (WCAG AAA body) | Body prose is read for long stretches; it gets the strongest contrast. |
| `--color-ink-secondary` on `--color-bg-surface` | ≥ 4.5:1 (WCAG AA) | Secondary text remains comfortably legible. |
| `--color-ink-tertiary` on `--color-bg-surface` | ≥ 4.5:1 (WCAG AA) | Even the muted tier clears AA for normal text; "muted" never means "below threshold." |
| Semantic colors as text/icon on their layer | ≥ 4.5:1 | Status must be legible, not just present. |
| `--color-focus-ring` against adjacent surfaces | ≥ 3:1 (WCAG non-text) | Focus indication must clear the non-text contrast minimum. |

These are measured, not assumed: OKLCH lightness is perceptually uniform but is not a WCAG contrast ratio. `packages/design-tokens/tokens.test.ts` asserts every row above for **both** Twilight and Paper with `culori`, so a token change that breaks a ratio fails the build.

Two deliberate exclusions, both recorded there:

- **`--color-line-strong` is not held to 3:1.** It is a decorative hairline, which WCAG 1.4.11 exempts; the 3:1 non-text obligation is carried by `--color-focus-ring`, which is asserted against all four layers. The exemption is a **skipped test**, not an omission, so the reporter names it on every run — un-skip it and retune both palettes if `line-strong` ever becomes load-bearing for state.
- **`--color-on-accent` on `--color-accent-muted` clears 4.5:1 on Paper but measures 3.15:1 on Twilight.** Pre-existing; fixing it means darkening `accent-muted` in all four dark palettes, which is a separate change.

---

## 3. Typography

Typography is the design (P1). This section defines the typefaces, the type scale, the editor body settings, and — most importantly — **the measure**, which is the single biggest readability lever Recto has.

### 3.1 Typeface rationale

| Role | Typeface class | Used in | Rationale |
|------|----------------|---------|-----------|
| **Reading / prose** | A refined **serif** or **humanist sans** with real optical quality (e.g. a text serif such as Source Serif / Newsreader, or a humanist sans such as a properly hinted grotesque) | **Rich text** editor body, **Preview** body ([`./04-editor-modes.md`](./04-editor-modes.md) §5.2), the reading-mode type scale | The writer reads their own prose for long stretches; the reading face is chosen for sustained-reading comfort and a premium, bespoke voice (P3), not for UI density. This is the face that makes Recto feel like a writing studio rather than a code editor. |
| **Monospace / raw** | A quality programming **monospace** (e.g. a well-drawn mono such as Berkeley Mono / Commit Mono / JetBrains Mono) | **Raw Markdown** and **Vim** editor bodies ([`./04-editor-modes.md`](./04-editor-modes.md) §3, §4) | Raw and Vim show the literal serialized Markdown source; a monospace makes Markdown structure (table pipes, code fences, frontmatter, footnote markers) legible and column-stable, and matches the Obsidian-grade text-editor expectation those modes set. |
| **UI / chrome** | A neutral UI sans (may be the same humanist sans as the reading face if it is suitable at small sizes) | Status bar, mode indicator, palette items, dialog/labels | Chrome stays quiet (P2); the UI face is unobtrusive and reads cleanly at small sizes. |

The final typeface selection — and webfont loading/subsetting — is part of the Phase 5 bespoke pass ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)); this file fixes the *roles* and *rationale*, not the exact font names.

```css
@theme {
  --font-reading: "Source Serif 4", Newsreader, Georgia, "Times New Roman", serif;
  --font-mono:    "Berkeley Mono", "Commit Mono", "JetBrains Mono", ui-monospace, "SF Mono", monospace;
  --font-ui:      "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
}
```

### 3.2 Type scale

A modular scale (ratio ≈ 1.25, major third) keeps sizes harmonious. Sizes are expressed in `rem` (root `16px`).

| Token | Size | Weight | Line-height | Use |
|-------|------|--------|-------------|-----|
| `--text-display` | 2.027rem (≈32.4px) | 600 | 1.2 | Empty-state headline, large titles |
| `--text-h1` | 1.802rem (≈28.8px) | 600 | 1.25 | Document H1 in reading/preview |
| `--text-h2` | 1.602rem (≈25.6px) | 600 | 1.3 | H2 |
| `--text-h3` | 1.424rem (≈22.8px) | 600 | 1.35 | H3 |
| `--text-h4` | 1.266rem (≈20.3px) | 600 | 1.4 | H4 |
| `--text-h5` | 1.125rem (≈18px) | 600 | 1.4 | H5 |
| `--text-h6` | 1.0rem (≈16px) | 600 | 1.4 | H6 (often set in small-caps / tracked) |
| `--text-body` | 1.188rem (≈19px) | 400 | 1.6 | **Editor / reading body** (see §3.3) |
| `--text-ui` | 0.875rem (≈14px) | 400 | 1.45 | Chrome: palette items, dialog text |
| `--text-ui-sm` | 0.8125rem (≈13px) | 400 | 1.4 | Status bar, mode indicator, fine print |

```css
@theme {
  --text-display: 2.027rem;  --leading-display: 1.2;
  --text-h1: 1.802rem;       --leading-h1: 1.25;
  --text-h2: 1.602rem;       --leading-h2: 1.3;
  --text-h3: 1.424rem;       --leading-h3: 1.35;
  --text-h4: 1.266rem;       --leading-h4: 1.4;
  --text-h5: 1.125rem;       --leading-h5: 1.4;
  --text-h6: 1.0rem;         --leading-h6: 1.4;
  --text-body: 1.188rem;     --leading-body: 1.6;
  --text-ui: 0.875rem;       --leading-ui: 1.45;
  --text-ui-sm: 0.8125rem;   --leading-ui-sm: 1.4;
}
```

### 3.3 Editor body

The **editor body** (Rich text and Preview prose, and the base size for Raw/Vim) is set at **~18–20px** with a **line-height of ~1.5–1.7**. The default is `--text-body` = ~19px at line-height 1.6, which sits in the middle of both ranges. This is the comfortable sustained-reading size for a single-column writing surface and is materially larger than typical app body text — because the body text *is* the product (P1).

| Property | Value | Note |
|----------|-------|------|
| Body size | ~19px (`--text-body`, range 18–20px) | The reading body for Rich text and Preview |
| Line-height | 1.6 (range 1.5–1.7) | Open enough for long-form reading |
| Paragraph spacing | ~0.75em–1em between paragraphs | Rhythm over rules; no dividers between paragraphs |
| Raw/Vim base size | ~16–17px monospace | Slightly tighter than reading body; monospace runs visually larger, so it is set a touch smaller for parity |

### 3.4 The measure (max line length)

> **The measure is the single biggest readability lever in Recto.** It is constrained, centered in the surface, and is the reason Recto reads as a designed writing studio rather than full-width text.

| Property | Value | Source |
|----------|-------|--------|
| Optimal measure | **~66 characters per line (CPL)** | Bringhurst's optimum; the target Recto centers on |
| Acceptable range | **45–75 CPL** | Bringhurst's comfortable range |
| Hard ceiling | **≤ 80 CPL** | WCAG 1.4.8 maximum line length for readable blocks of text |
| Alignment | **Centered** in the surface | The measure column is centered; surplus surface becomes calm margin (P5) |

The measure is implemented with the CSS `ch` unit (relative to the font's `0` advance) on the prose container, capped so it never exceeds the WCAG ceiling:

```css
.recto-measure {
  /* ~66ch optimum; clamp keeps it inside the 45–75 range, never past 80 (WCAG 1.4.8). */
  inline-size: clamp(45ch, 66ch, 75ch);
  margin-inline: auto;            /* centered in the surface */
  padding-inline: var(--space-6); /* breathing room at narrow viewports */
}
```

This applies to the **Rich text** body and the **Preview** body (the most type-forward mode, [`./04-editor-modes.md`](./04-editor-modes.md) §5.2). Raw Markdown and Vim show source and may use a wider column for code/table legibility, but their default text column still honors a generous max-width so long lines wrap comfortably rather than running edge to edge.

### 3.5 Heading scale in prose

In Rich text and Preview, headings use the `--text-h1`…`--text-h6` scale (§3.2) within the measure column. Headings are differentiated by **size + weight + spacing**, not by rules or background fills (P1). They carry slightly more space above than below (space-before > space-after) so a heading visually binds to the content it introduces.

---

## 4. Layout & chrome

### 4.1 The surface dominates

The writing surface (the pane tree) occupies essentially the entire viewport (P2). Chrome is reduced to two quiet elements: a **minimal top affordance** and a **quiet status bar**. Everything else (slash palette, contextual toolbar, command palette, history panels) is summoned on demand and dismissed.

```
┌──────────────────────────────────────────────────────────┐
│  ░ minimal top affordance (document title · switcher)   ░ │  ← quiet, ~40px
├──────────────────────────────────────────────────────────┤
│                                                            │
│            ┌───────────── measure ─────────────┐           │
│            │                                    │           │
│            │   the writing surface dominates    │  ← pane   │
│            │   (centered measure column)        │           │
│            │                                    │           │
│            └────────────────────────────────────┘           │
│                                                            │
├──────────────────────────────────────────────────────────┤
│  ░ status bar:  Rich text · normal      1,204 words  ✓  ░ │  ← quiet, ~28px
└──────────────────────────────────────────────────────────┘
```

### 4.2 Minimal top affordance

A single thin top region — not a toolbar. It carries only the active document's title and the entry point to the **document switcher** ([`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)). It uses `--color-bg-app`, `--text-ui` ink at `--color-ink-secondary`, and no persistent formatting controls (formatting is contextual per [`./04-editor-modes.md`](./04-editor-modes.md) §2.4). It may auto-recede in focus/typewriter mode (§6.12).

### 4.3 The status bar

A **quiet status bar** runs along the bottom edge. It is a safety-net surface (P6) and is always present.

| Element | Content | Token / ink |
|---------|---------|-------------|
| **Word count** | Live word count, always available (D15, README §4 P7) | `--text-ui-sm`, `--color-ink-secondary`; the value rests at `--color-ink-tertiary` until hovered/focused |
| **Per-pane mode indicator** | The active pane's mode, with Vim sub-mode where applicable (e.g. `Rich text`, `Raw Markdown`, `Vim · normal`, `Preview`) — see [`./04-editor-modes.md`](./04-editor-modes.md) §7 | `--text-ui-sm`, `--color-ink-secondary` |
| **Saving / sync indicator** | Saved / saving / offline-unsynced state (§5) | semantic colors per §5 |

The status bar uses `--color-bg-raised` with a single `--color-line` top hairline. The **mode indicator** here is the same per-pane indicator specified in [`./04-editor-modes.md`](./04-editor-modes.md) §7; it reflects the **active pane** ([`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)).

### 4.4 Split panes

Panes are framed by **thin dividers**, never by heavy borders or cards (P1/P3). The split layout is the nested vertical/horizontal pane tree (`react-resizable-panels`, README §6; [`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)).

| Aspect | Treatment |
|--------|-----------|
| **Divider** | A 1px hairline at `--color-line`. The drag-resize hit target is wider (~8px) than the visible line so it is grabbable without thickening the visual seam. |
| **Divider on hover/drag** | Brightens to `--color-line-strong` to confirm the resize affordance; returns on release. |
| **Focused-pane emphasis** | The pane that holds `workspaces.activePaneId` ([`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)) reads as focused. Emphasis is expressed quietly: its boundary uses `--color-line-strong` while unfocused panes use `--color-line`, and unfocused panes may drop ink by one level (primary → secondary on their chrome) so the active pane is unmistakably the live one without any loud highlight (P5). |

### 4.5 Spacing scale

A single spacing scale (base 4px) governs all gaps, padding, and rhythm. Using one scale everywhere is part of feeling bespoke rather than ad hoc (P3).

| Token | px | Typical use |
|-------|-----|-------------|
| `--space-1` | 4px | Icon/label gap, tightest inset |
| `--space-2` | 8px | Compact control padding |
| `--space-3` | 12px | Status-bar item gaps |
| `--space-4` | 16px | Default component padding |
| `--space-5` | 24px | Palette/menu padding, dialog inset |
| `--space-6` | 32px | Measure-column horizontal padding |
| `--space-7` | 48px | Surface vertical breathing room |
| `--space-8` | 64px | Empty-state / large vertical rhythm |

```css
@theme {
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.5rem;  --space-6: 2rem;   --space-7: 3rem;    --space-8: 4rem;

  /* Radii — small and consistent; no stock-shadcn pill radii (P3). */
  --radius-sm: 0.25rem; --radius-md: 0.375rem; --radius-lg: 0.5rem;
}
```

---

## 5. The visible states (saving, offline, loading, empty, focused)

Recto must always tell the writer the truth about persistence (README §4 P2 "never lose a word"; P7 safety nets). These states are surfaced quietly but unmistakably.

| State | Where shown | Treatment |
|-------|-------------|-----------|
| **Empty (no documents)** | Whole surface | Centered empty state (§6.11): a calm prompt to create the first document; `--text-display` headline, `--color-ink-secondary`. |
| **Focused writing** | Whole surface | The default state. Chrome at rest, ink at `--color-ink-primary` in the active measure column, optional focus/typewriter mode (§6.12). |
| **Loading / hydrating** | Pane | While a document hydrates on open/idle (README D11; the editor is never a controlled component of a reactive query), the pane shows a quiet skeleton or low-contrast shimmer at `--color-bg-surface`/`--color-bg-raised`, never a spinner over the text. |
| **Saving** | Status bar | A small saving indicator. At rest after a successful debounced save it shows a quiet "saved" affordance (a check glyph at `--color-success`, or simply nothing once settled). During an in-flight save it shows a subtle "saving" pulse at `--color-ink-tertiary`. |
| **Offline / unsynced** | Status bar | When edits are local-but-not-yet-synced, or the client is offline, the indicator switches to `--color-warning` with an explicit "unsynced" / "offline" label. This is the one place the warning color is expected to appear in normal use; it must be honest and not alarmist. |

The saving and offline indicators are driven by sync state from [`./09-documents-workspace-split.md`](./09-documents-workspace-split.md) and the persistence model (README D10/D11). They are never removed for minimalism (P6).

---

## 6. Component inventory

Each component lists its **intent** and its **states**. Components consume the tokens in §2–§5 and the motion in §7. They are built on shadcn primitives (README §6) but restyled to Recto's bespoke tokens, not left at stock defaults (P3).

### 6.1 Editor surface

- **Intent:** The dominant surface; renders the active mode's view of the canonical document inside the centered measure column ([`./04-editor-modes.md`](./04-editor-modes.md)). It is the product (P1, P2).
- **States:** focused (active pane) · unfocused · loading/hydrating · empty (within an open doc that has no content) · read-only (Preview mode).
- **Treatment:** `--color-bg-surface`; reading typography (§3) for Rich text/Preview, `--font-mono` for Raw/Vim; measure centered (§3.4); text selection uses `--color-selection`.

### 6.2 Pane & pane divider

- **Intent:** A pane binds one document to one mode ([`./04-editor-modes.md`](./04-editor-modes.md) §1.1); the divider frames and resizes adjacent panes ([`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)).
- **States:** pane → focused / unfocused; divider → rest / hover / dragging.
- **Treatment:** thin hairline dividers (§4.4); focused-pane emphasis via `--color-line-strong` and ink-level demotion of inactive panes.

### 6.3 Status bar

- **Intent:** The always-present quiet safety-net surface: word count (D15), per-pane mode indicator ([`./04-editor-modes.md`](./04-editor-modes.md) §7), saving/sync state (§5).
- **States:** default · saving · saved · offline/unsynced.
- **Treatment:** `--color-bg-raised`, `--text-ui-sm`, top hairline; semantics only for sync state (§2.4, §5).

### 6.4 Command palette (`cmdk`)

- **Intent:** Keyboard-first global actions, mode switching, and document switching (`cmdk`, README §6; [`./13-keyboard-commands.md`](./13-keyboard-commands.md)).
- **States:** closed · opening · open (idle) · filtering (query typed) · item highlighted · empty (no matches) · executing.
- **Treatment:** centered overlay on `--color-bg-overlay` over a subtle scrim of `--color-bg-app` at low alpha; the highlighted item is the single place the **primary accent** marks "the live thing" (`--color-accent` text or a low-alpha `--color-accent-muted` fill); `--text-ui` for items, `--text-ui-sm` for shortcut hints in `--color-ink-tertiary`. Open/close motion per §7.

### 6.5 Document switcher

- **Intent:** Pick/open another document, reached from the minimal top affordance (§4.2) and the command palette ([`./09-documents-workspace-split.md`](./09-documents-workspace-split.md)).
- **States:** closed · open · filtering · item highlighted · empty (no other docs).
- **Treatment:** shares the command-palette visual language (it can be a `cmdk` mode) — `--color-bg-overlay`, accent on the highlighted row. Document rows show title at `--color-ink-primary` and last-edited at `--color-ink-tertiary`.

### 6.6 Slash command palette

- **Intent:** Insert blocks in **Rich text** by typing `/` ([`./04-editor-modes.md`](./04-editor-modes.md) §2.3); inline, at the cursor. The authoritative command list is in [`./13-keyboard-commands.md`](./13-keyboard-commands.md).
- **States:** open (after `/`) · filtering · highlighted · empty (no match) · dismissed (`Esc` leaves `/` as literal text).
- **Treatment:** a compact inline popover on `--color-bg-raised`, anchored at the caret; `--text-ui` rows; highlighted row uses the primary accent like the command palette. Reveal motion is faster and lighter than the command palette (it is inline and frequent, §7).

### 6.7 Contextual formatting toolbar

- **Intent:** Apply inline marks (bold, italic, strikethrough, inline code, link) to a non-empty selection in **Rich text** ([`./04-editor-modes.md`](./04-editor-modes.md) §2.4). It is contextual, not persistent chrome (P2).
- **States:** hidden (no selection) · appearing · visible (selection active) · a mark active/toggled · dismissing (selection collapses).
- **Treatment:** a small floating bar on `--color-bg-overlay` near the selection; icons at `--color-ink-secondary`, active marks at `--color-accent`. Appears/dismisses with a brief fade+rise (§7).

### 6.8 Undo-tree visualizer panel

- **Intent:** Visualize and navigate the branching **undo tree** (the immutable `docNodes` DAG, README D8; [`./07-undo-tree.md`](./07-undo-tree.md)); navigating it is undo/redo across branches.
- **States:** closed · revealing · open · node hovered · current node (where `documents.currentNodeId` points) · branch-point.
- **Treatment:** a panel on `--color-bg-overlay`; the tree drawn as quiet hairlines (`--color-line`) with the **current node** marked in the primary accent and branch points distinguished by node shape, not color noise (P5). Reveal motion is a slide/expand (§7).

### 6.9 Version-history panel

- **Intent:** Browse tagged **versions** (auto + manual, README D9; [`./08-version-control.md`](./08-version-control.md)) and perform additive restore.
- **States:** closed · revealing · open · version selected · comparing/diff · restoring.
- **Treatment:** a list panel on `--color-bg-overlay`; manual tags at `--color-ink-primary`, auto tags at `--color-ink-secondary`, timestamps at `--color-ink-tertiary`; the `kind: "auto" | "manual"` distinction (README §7) shown by ink level and a small label, not by competing colors.

### 6.10 Dialogs & toasts

- **Intent:** Confirm consequential actions (dialogs) and report transient outcomes (toasts) — e.g. export complete ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)), restore confirmation.
- **States (dialog):** closed · open · confirming · destructive (uses `--color-danger` only on the destructive action). **States (toast):** entering · visible · auto-dismissing · dismissed.
- **Treatment:** dialogs on `--color-bg-overlay` over a low-alpha scrim, centered, `--radius-lg`; toasts on `--color-bg-raised` anchored bottom-trailing above the status bar; semantic color only when the toast reports success/warning/error (§2.4).

### 6.11 Empty states

- **Intent:** Guide the writer when there is nothing to show — no documents at all, or an open-but-empty document.
- **States:** no documents (whole surface) · empty document (within a pane) · empty search/switcher result.
- **Treatment:** centered, type-led (P1): `--text-display` or `--text-h2` headline at `--color-ink-secondary`, a one-line hint at `--color-ink-tertiary`, and a single primary action. No illustration clutter (P3, P5).

### 6.12 Focus / typewriter mode (optional)

- **Intent:** Maximize calm and focus (P5) by receding all chrome and keeping the writer's eye in one place.
- **Behavior:** chrome (top affordance, and optionally the status bar) recedes; in **typewriter mode** the **active line is kept centered** in the surface as the writer types, so the eye never tracks down the page. This is an optional, toggleable mode.
- **States:** off (default) · focus (chrome receded) · typewriter (active line centered).
- **Treatment:** transitions in/out with a slightly longer, gentle fade (§7); honors `prefers-reduced-motion` (§7.4).

---

## 7. Motion

Motion is **subtle and purposeful** (P3, P5): it explains a change of state, it never decorates. Every animation is short, eased, and interruptible, and all of it is gated by `prefers-reduced-motion` (§7.4).

### 7.1 Tokens

```css
@theme {
  /* Durations */
  --motion-instant: 80ms;   /* state toggles, hover */
  --motion-fast:    140ms;  /* slash menu, toolbar, mode transition */
  --motion-base:    200ms;  /* command palette, dialogs */
  --motion-slow:    280ms;  /* panel reveals (undo/version), focus mode */

  /* Easing */
  --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);    /* entrances: decelerate */
  --ease-in-out: cubic-bezier(0.45, 0, 0.55, 1);   /* moves/resizes */
  --ease-in:     cubic-bezier(0.4, 0, 1, 1);        /* exits: accelerate out */
}
```

### 7.2 Where motion is used

| Event | Motion | Duration · easing |
|-------|--------|-------------------|
| **Mode transition** (Rich/Raw/Vim/Preview switch, [`./04-editor-modes.md`](./04-editor-modes.md) §6) | A brief crossfade of the pane content; **content stays in place** (switching is just mounting a different projection, [`./04-editor-modes.md`](./04-editor-modes.md) §6.2 — never a slide that implies "a different document") | `--motion-fast` · `--ease-out` |
| **Command palette open/close** | Scrim fades; panel rises slightly and fades in (open) / reverses (close) | open `--motion-base` `--ease-out`; close `--motion-fast` `--ease-in` |
| **Slash command palette** | Quick fade+rise at the caret | `--motion-fast` · `--ease-out` |
| **Contextual toolbar** | Fade+rise on selection; fade out on collapse | `--motion-fast` · `--ease-out` / `--ease-in` |
| **Pane resize** | The divider follows the pointer 1:1 (no easing while dragging); only the hover/active brighten is eased | brighten `--motion-instant` · `--ease-out` |
| **Undo-tree / version-history panel reveal** | Slide + expand in from its edge, fade content | `--motion-slow` · `--ease-out` |
| **Dialog** | Scrim fade + slight scale/rise | `--motion-base` · `--ease-out` |
| **Toast** | Slide+fade in from bottom-trailing; auto-fade out | in `--motion-base` `--ease-out`; out `--motion-fast` `--ease-in` |
| **Focus / typewriter mode** | Chrome fade; in typewriter mode the active-line recenter scroll is eased gently | `--motion-slow` · `--ease-in-out` |

### 7.3 What never animates

Typing, caret movement, and text reflow inside the editor never animate — input latency is a feature (README §4 P4; the plan's snappiness contract). Motion is confined to chrome and overlays, never the hot path of editing.

### 7.4 Reduced motion

`prefers-reduced-motion` is honored globally. Transforms (rise/slide/scale) are dropped to opacity-only or removed; durations collapse toward instant. State changes still happen — only the animation is suppressed.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 8. Accessibility

Accessibility is a hard constraint, consistent with P6 (minimalism never removes safety nets) and the keyboard-first nature of the product ([`./04-editor-modes.md`](./04-editor-modes.md), [`./13-keyboard-commands.md`](./13-keyboard-commands.md)).

| Area | Requirement |
|------|-------------|
| **Contrast** | Meet the targets in §2.5 **in both appearances**: body prose ≥ 7:1, secondary/tertiary text and semantic text ≥ 4.5:1, focus ring and non-text indication ≥ 3:1. "Muted" ink never drops below AA. Enforced by the token contrast tests. |
| **Visible focus rings** | Every focusable element shows a visible focus indicator using `--color-focus-ring` (≥ 3:1, WCAG 1.4.11). Use `:focus-visible` so the ring appears for keyboard focus without cluttering mouse interaction. Focus rings are a safety net and are never removed for aesthetics (P6). |
| **Full keyboard operability** | Everything is reachable and operable from the keyboard — command palette, slash command palette, document switcher, mode switching, undo-tree and version-history navigation. The keymap is authoritative in [`./13-keyboard-commands.md`](./13-keyboard-commands.md). No action is mouse-only. |
| **ARIA — command palette / switcher** | `cmdk`-based palettes expose combobox/listbox semantics (`role="combobox"` on the input, `role="listbox"`/`role="option"` on results, `aria-activedescendant` for the highlighted item) so the highlighted option is announced as the writer filters. |
| **ARIA — slash menu** | The slash command palette ([`./04-editor-modes.md`](./04-editor-modes.md) §2.3) exposes menu/listbox semantics with the active item announced; `Esc` closes and returns focus to the editor with the `/` text intact. |
| **ARIA — dialogs** | Dialogs use `role="dialog"` with `aria-modal="true"`, a labelled title (`aria-labelledby`), focus trapped while open, focus restored to the trigger on close, and `Esc` to dismiss. |
| **ARIA — toasts / status** | Transient toasts and the saving/offline indicator are announced via an appropriate live region (`role="status"`/`aria-live="polite"`, or `assertive` for errors) so persistence state is conveyed non-visually too (P6, §5). |
| **Reduced motion** | `prefers-reduced-motion` is honored (§7.4). |
| **Respect OS settings** | `prefers-color-scheme` selects the appearance by default (ADR-20); the writer can override it to light or dark and the choice is remembered per device. Reduced-motion (§7.4), reduced-transparency (avoid load-bearing transparency; the layered backgrounds in §2.2 already convey elevation without relying on alpha) and forced-colors/high-contrast are respected. |

---

## 9. How Recto avoids the generic AI aesthetic

This is principle P3 made concrete. The Phase 5 bespoke design pass ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)) uses the `frontend-design` skill specifically to push the look past defaults; until then, these do/don'ts keep the foundation from drifting toward the templated look.

| Do | Don't |
|----|-------|
| Author the palette natively in OKLCH for dark, with low chroma and considered hue (§2). | Ship the stock near-black + saturated-blue-accent + default-Inter look that reads as "an AI made this." |
| Let **typography carry hierarchy** — size, weight, ink level, measure, rhythm (P1, §3). | Wrap everything in cards with stock radii and drop shadows to manufacture structure. |
| Choose a **real reading typeface** (refined serif / humanist sans) and a **quality monospace** (§3.1). | Set the whole product in one generic UI sans, including the prose the writer reads for hours. |
| Constrain the **measure** to ~66ch, centered, with calm margin (§3.4). | Run prose full-width edge to edge because "it fills the screen." |
| Spend **one restrained accent** on the single live affordance; keep the rest monochrome (§2.4, P5). | Sprinkle gradients, glows, and multiple saturated accents as decoration. |
| Express elevation with **luminance layers** (§2.2) and **thin hairlines** (§4.4). | Stack heavy borders, big shadows, and glassmorphism. |
| Keep motion **brief, purposeful, interruptible**, off the typing path (§7). | Animate everything with bouncy springs and long durations. |
| Keep chrome **quiet and contextual** — slash palette, contextual toolbar, command palette (P2). | Add a persistent formatting ribbon and a default sidebar. |

The test from the user's positioning rule applies: a choice is real differentiation only if a competitor could credibly claim the opposite. "Centered 66ch measure in a serif on a layered OKLCH dark surface" is a stance; "clean, modern, accessible" is not.

---

## 10. Token reference (consolidated)

The complete set of canonical token names defined in this file. Use these exact names; values are tuned in the Phase 5 pass ([`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md)).

| Group | Tokens |
|-------|--------|
| Background layers | `--color-bg-app`, `--color-bg-surface`, `--color-bg-raised`, `--color-bg-overlay` |
| Ink levels | `--color-ink-primary`, `--color-ink-secondary`, `--color-ink-tertiary` |
| Lines | `--color-line`, `--color-line-strong` |
| Accents | `--color-accent`, `--color-accent-muted`, `--color-accent-2` |
| Semantic | `--color-success`, `--color-warning`, `--color-danger` |
| Selection / focus | `--color-selection`, `--color-focus-ring` |
| Fonts | `--font-reading`, `--font-mono`, `--font-ui` |
| Type sizes | `--text-display`, `--text-h1`…`--text-h6`, `--text-body`, `--text-ui`, `--text-ui-sm` (+ matching `--leading-*`) |
| Spacing | `--space-1`…`--space-8` |
| Radii | `--radius-sm`, `--radius-md`, `--radius-lg` |
| Motion | `--motion-instant`, `--motion-fast`, `--motion-base`, `--motion-slow`, `--ease-out`, `--ease-in-out`, `--ease-in` |

---

## 11. Cross-references

| File | Why you'd go there from here |
|------|------------------------------|
| [`./04-editor-modes.md`](./04-editor-modes.md) | The four modes whose surfaces this system styles: the reading typography for **Preview** (§5.2 there), the **contextual formatting toolbar** (§2.4 there), the **slash command palette** (§2.3 there), and the **mode indicator** (§7 there) |
| [`./09-documents-workspace-split.md`](./09-documents-workspace-split.md) | The pane tree, the focused/active pane (`workspaces.activePaneId`), the document switcher, and the sync state that drives the saving/offline indicators in §5 |
| [`./13-keyboard-commands.md`](./13-keyboard-commands.md) | The full keymap and the authoritative command/slash lists behind the command palette, slash command palette, and the keyboard operability required in §8 |
| [`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md) | The phase where the dedicated bespoke design pass happens using the `frontend-design` skill — final typeface selection, token tuning, and the finished look on top of this system |
