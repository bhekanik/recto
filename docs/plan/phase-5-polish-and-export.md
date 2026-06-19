# Phase 5 — Polish & export

> **Execution companion to the blueprint.** This phase file is self-contained: it restates its goal, prerequisites, scope, work breakdown, technical approach, the libraries and data-model touch it requires, explicit out-of-scope items, testable exit criteria, and risks. Read [`../blueprint/README.md`](../blueprint/README.md) for canon (the locked decisions **D1–D15**, the canonical Convex schema, the Markdown dialect, the glossary). Where this file states behavior it must never contradict **D1–D15**.
>
> **Canon anchors for this phase:** [`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) (copy/export), [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) (the bespoke design + a11y system), [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) (the keymap, the `cmdk` command palette, the slash list). Supporting: [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) (the dialect the exporters must render), [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md) (the ADR for skipping `.rtf`).

---

## Goal

Make Recto **premium and bespoke**, and get a writer's content **out of the studio cleanly**. Two deliverables in one phase, because both are the last 10% that turns a working prototype into a finished tool:

1. **A `cmdk` command palette** that is Recto's single discoverability and command surface — fuzzy search over *every* action and *every* document, sectioned in the canonical order, each row showing its platform-correct shortcut, fully keyboard-operable end to end. It wires *every* action defined in [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2 into one place.
2. **Clipboard and file export derived from the active document's canonical MDAST** — *Copy as rich text* (`text/html` + `text/plain` in one `ClipboardItem`), *Copy as Markdown* (`text/plain` only), *Export as `.md`*, *Export as rich text (`.html`)* — exactly as specified in [`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md).
3. **A bespoke design pass** (using the `frontend-design` skill) that takes the design-system tokens of [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) to a finished look: refined typography (final typeface selection + webfont loading), the OKLCH dark palette tuned and contrast-verified, the spacing scale, the status bar, pane framing, motion, and every visible state (empty / focused / loading / saving / offline).
4. **An accessibility pass** that meets the hard constraints in [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §8 — contrast on dark, visible focus rings, full keyboard operability, ARIA for palette/menus/dialogs, reduced-motion.
5. **Final QA** that verifies every blueprint promise still holds end to end after polish: lossless round-trip, never-lose-work across refresh + devices, instant mode switches, snappy typing, undo tree + versions, split + workspace resume.

This is the **last** v1 phase. When it is done, Recto is shippable as the private single-user writing studio described in [`../blueprint/README.md`](../blueprint/README.md) §1.

---

## Why now / prerequisites

Polish and export are deliberately last. They sit on top of mechanisms that must already work, because:

- The command palette **dispatches into the single action registry** that the global capture-phase chord handler already populates ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.4: "Single source per action"). There is one implementation per action, surfaced two ways. So the palette can only be built *after* the actions exist as a registry — which is the cumulative product of Phases 1–4.
- Clipboard/export **serialize from the active document's canonical MDAST** ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §1.1), so they need the canonical model, its `remark-stringify` serialization, and the `unified` pipeline — all established in Phases 1–2.
- The bespoke design pass refines an interface that **must already be functionally complete**; you cannot do a finishing typography/motion pass on screens that do not yet exist.

**Prerequisites — Phases 0–4 are done** (per the global Definition of Done in [`./README.md`](./README.md)):

| Prereq | From phase | What this phase relies on |
|--------|-----------|---------------------------|
| Canonical model + `remark-stringify` + `unified` pipeline (parse/serialize the dialect) | [`./phase-1-foundation.md`](./phase-1-foundation.md), [`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md) | The single `ExportSource` accessor and `generateExportHtml` ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §1.1, §6) |
| All four modes with instant, lossless switching; slash palette; full GFM + footnotes + frontmatter with round-trip corpus | [`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md) | The exporters render exactly the dialect; QA re-verifies lossless round-trip |
| Multi-doc switcher, nested split panes, same-doc-two-live-modes, workspace persistence + cross-device resume | [`./phase-3-multi-doc-split-workspace.md`](./phase-3-multi-doc-split-workspace.md) | Palette **Documents** + **Panes** sections; QA re-verifies split + workspace resume |
| Undo-tree visualizer + version history (auto/manual tags, additive restore) wired to the persisted DAG | [`./phase-4-history.md`](./phase-4-history.md) | Palette **History** section; QA re-verifies undo tree + versions |
| The single application-level **action registry** + capture-phase chord handler | Phases 1–4 (built incrementally as each action lands) | The palette dispatches into this registry; this phase does **not** invent a second implementation |
| Design-system tokens declared in `@theme` (background layers, ink, lines, accents, semantics, fonts, type scale, spacing, radii, motion) | [`./phase-1-foundation.md`](./phase-1-foundation.md) onward, per [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) | The design pass **tunes** these tokens; it does not rename them |

> If any prerequisite is not demonstrably met, stop and finish the owning phase first. This phase assumes the action registry, the canonical-model serialization, and all functional UI already exist.

---

## In scope

1. **Command palette (`cmdk`).**
   - Opened with `Cmd/Ctrl+K` ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2.2).
   - Fuzzy search over **all actions** (every row of the §2 keymap) **and all documents** (by title) in one query box (§4.1).
   - Sectioned in the canonical display order: **Documents, Modes, Panes, History, Copy/Export, View** (§4.2).
   - Every action row renders its platform-correct keyboard shortcut on the right (§4.1).
   - Full keyboard navigation: `↑/↓` move across section boundaries, `Enter` run/open, `Esc` close and restore focus, typing filters live (§4.3).
   - Selecting a row dispatches into the **same single action registry** the chord uses (§4.1, §7.3.4) — one implementation, two surfaces.
   - The **Documents** section is also what `Cmd/Ctrl+P` opens pre-scoped to (§2.2, §4.2).

2. **Clipboard — whole app, derived from the active document's canonical MDAST** ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md)).
   - The single `ExportSource` accessor (§1.1) every copy/export action funnels through.
   - **Copy as rich text** (`Cmd/Ctrl+Shift+C`): one `ClipboardItem` carrying `text/html` (a `Promise<Blob>`) + `text/plain` (a `Blob` of the canonical Markdown), written via `navigator.clipboard.write()` called **synchronously in the gesture** (Safari-safe Promise-in-`ClipboardItem`); absolute `https://` URLs; feature-detected with a Markdown-copy fallback (§2).
   - **Copy as Markdown** (`Cmd/Ctrl+Alt+C`): `navigator.clipboard.writeText(markdown)` — `text/plain` only, never a `text/html` representation (§3).

3. **File export** ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §4–§6), reached via the **Export** chord `Ctrl+Shift+E` and the **Copy/Export** palette section.
   - **Export as `.md`**: `Blob` of type `text/markdown;charset=utf-8`, `<a download>`, `URL.revokeObjectURL` after the click (§4).
   - **Export as rich text (`.html`)**: self-contained HTML (one `<style>` block, absolute URLs), generated from the canonical MDAST via `remark-rehype` → `rehype-stringify` (`generateExportHtml`, §6) — the **export** pipeline, distinct from the in-app preview pipeline.

4. **Bespoke design pass** (`frontend-design` skill), per [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md): final typeface selection + webfont loading/subsetting (the three roles `--font-reading` / `--font-mono` / `--font-ui`, §3.1); OKLCH dark palette tuning + numeric contrast verification (§2.5); the measure (~66ch, centered, ≤80 CPL, §3.4); the spacing scale; the **status bar** (live word count + per-pane mode indicator + saving/sync indicator, §4.3); pane framing (thin hairline dividers, focused-pane emphasis, §4.4); motion (mode transitions, palette, panel reveals, honoring `prefers-reduced-motion`, §7); and every visible state — empty / focused / loading-hydrating / saving / offline-unsynced (§5, §6.11).

5. **Accessibility pass**, per [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §8: contrast on dark to the §2.5 targets; visible `:focus-visible` rings using `--color-focus-ring`; full keyboard operability of every surface; ARIA for the command palette / switcher (combobox/listbox), the slash menu (menu/listbox), dialogs (`role="dialog"` + `aria-modal` + focus trap/restore), toasts/status (live regions); reduced-motion; respect OS forced-colors / reduced-transparency.

6. **Final QA** — a documented pass that re-verifies every blueprint promise after polish (see [Acceptance / exit criteria](#acceptance--exit-criteria)).

---

## Out of scope

Strictly the v1 non-goals ([`../blueprint/README.md`](../blueprint/README.md) §5) plus the items the blueprint explicitly defers:

- **Multi-user / collaboration / presence / comments / sharing** — never in v1 ([`../blueprint/README.md`](../blueprint/README.md) §5).
- **A light theme / theme toggle / `prefers-color-scheme` light handling** — dark only (**D13**, [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §1 P4).
- **Publishing / sending newsletters** — export + copy only ([`../blueprint/README.md`](../blueprint/README.md) §5).
- **Plugins / extensibility API** ([`../blueprint/README.md`](../blueprint/README.md) §5).
- **`.docx` export** — a noted, deferred enhancement using [`html-to-docx`](https://www.npmjs.com/package/html-to-docx) over the §6 HTML; explicitly out of scope for v1 ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §10). It requires *no change* to the canonical model or the §6 pipeline when added.
- **`.rtf` export** — deliberately not offered; `.html` covers it with zero custom code ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §9; ADR in [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md)). Do **not** hand-roll an RTF serializer.
- **Copy current selection (as rich text or Markdown)** — copy/export always operate on the *whole document* in v1 ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §1.1). Bare `Cmd/Ctrl+C` still does the ordinary editor selection copy; Recto's document-level commands are the explicit ones.
- **New actions or new keybindings.** This phase *surfaces and polishes* the existing keymap ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2); it does not invent actions. If a row is missing a handler, that is a defect in the owning phase, not new scope here.
- **Re-architecting the action registry or the capture-phase chord handler** — they already exist (Phases 1–4). The palette consumes the registry; it does not replace it.
- **Optional BOM on `.md` export** — default is no BOM ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §4); a BOM is opt-in only and not built unless a concrete legacy-Windows interop need is raised.

---

## Work breakdown

### A. Command palette (`cmdk`)

- **A1. Action registry shape audit.** Confirm the single action registry (built across Phases 1–4) exposes, for each action: a stable id, a display label, the section it belongs to (Documents/Modes/Panes/History/Copy/Export/View), its platform-correct chord string for the shortcut hint, fuzzy-match aliases, and a `run()` that is invokable **synchronously from a gesture**. If any field is missing, add it to the registry definition (not to the palette) so both the chord handler and the palette read the same source ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.4).
- **A2. Palette shell.** Build the `cmdk` palette mounted at the studio shell, opened by the existing `Cmd/Ctrl+K` registry action. One query input; results grouped into the six canonical sections in canonical order (§4.2). Empty query shows recent/likely actions + recent documents; as the query narrows, empty sections collapse (§4.1).
- **A3. Documents source.** Feed the **Documents** section from the document list (`documents.by_user_updated`, [`../blueprint/README.md`](../blueprint/README.md) §7; [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md)): fuzzy-match by title; rows show title at `--color-ink-primary` and last-edited at `--color-ink-tertiary` ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §6.5); include the **New document** entry. Selecting a document opens it in the active pane.
- **A4. Action rows + shortcut hints.** Render every registry action as a row in its section, each with its chord rendered on the right (`--text-ui-sm`, `--color-ink-tertiary`, [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §6.4), platform-correct (mac vs win/linux). This is the palette-as-cheat-sheet (§1 philosophy rule 2).
- **A5. Wire every §2 action.** Each of the following is a palette row dispatching the registry `run()` (the same handler the chord fires):
  - **Modes:** Rich text (`Ctrl+Shift+R`), Raw Markdown (`Ctrl+Shift+M`), Vim (`Ctrl+Shift+V`), Preview (`Ctrl+Shift+P`), Cycle next (`Ctrl+Shift+]`), Cycle prev (`Ctrl+Shift+[`).
  - **Panes:** Split vertical (`Cmd/Ctrl+\`), Split horizontal (`Cmd+Shift+\` / `Ctrl+Shift+\`), Close pane (`Cmd+Shift+W` / `Ctrl+Shift+W`), Focus next pane (`Ctrl+Shift+→`), Focus previous pane (`Ctrl+Shift+←`).
  - **History:** Create version / tag (checkpoint) (`Cmd/Ctrl+S`), Open undo-tree visualizer (`Ctrl+Shift+U`), Open version history (`Ctrl+Shift+H`), plus Undo/Redo (which also have native chords).
  - **Copy/Export:** Copy as rich text (`Cmd+Shift+C` / `Ctrl+Shift+C`), Copy as Markdown (`Cmd+Alt+C` / `Ctrl+Alt+C`), Export `.md`, Export `.html` (both under the `Ctrl+Shift+E` export affordance).
  - **View:** Toggle word count / status (`Ctrl+Shift+S`), Toggle focus mode (`Ctrl+Shift+F`).
  - **Documents:** quick-open by title, New document (`Cmd+N` / `Ctrl+Alt+N`).
- **A6. Keyboard navigation.** `↑/↓` move the highlight across section boundaries; `Enter` runs the highlighted action / opens the highlighted document then closes; `Esc` closes without running and restores focus to the previously active pane; printable chars filter, `Backspace` widens (§4.3). End-to-end keyboard-operable; the mouse is never required.
- **A7. Gesture-synchronous Copy/Export dispatch.** The palette's action dispatch must call Copy/Export handlers **synchronously** from the key/click handler — never after an `await` — so clipboard transient activation is preserved ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §8, §2.1 pitfall 2). Verify the `cmdk` `onSelect` path does not interpose an awaited tick before the handler runs.

### B. Clipboard

- **B1. `ExportSource` accessor.** Implement `exportSourceFor(doc)` returning `{ title, markdown, mdast }` from the active document, where `markdown = doc.serializeCanonicalMarkdown()` (`remark-stringify`, dialect rules per [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md)) and `mdast = doc.canonicalMdast()` ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §1.1). **Never** read `editorView.dom.innerHTML` or any editor selection. This is the one accessor all four actions funnel through.
- **B2. `copyAsRichText(source)`.** Feature-detect `ClipboardItem` + `navigator.clipboard.write` first (pitfall 5); on absence, degrade to `copyAsMarkdown` and `notifyRichCopyUnsupported()`. Build `htmlBlob` lazily as a `Promise<Blob>` from `generateExportHtml(source.mdast)` (do **not** `await` before `write()`); build `textBlob` eagerly as a `Blob` of `source.markdown`. Call `navigator.clipboard.write([new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob })])` as the **first** async call in the gesture (pitfalls 1, 2). One `ClipboardItem`, two keys — not two items (§2.2).
- **B3. `copyAsMarkdown(source)`.** `navigator.clipboard.writeText(source.markdown)` — `text/plain` only. **Critically do not** add a `text/html` representation (§3): the distinction between the two copy actions *is* the presence/absence of `text/html`.
- **B4. Clipboard error handling.** Single `handleClipboardError` for `write()`/`writeText()`: on `NotAllowedError` (no gesture / insecure context / permission denied) show an honest, actionable toast pointing to *Export* as the reliable alternative; on unknown failure surface generically and never swallow (§7). Success is quiet but visible — a brief non-blocking confirmation ("Copied as rich text" / "Copied as Markdown").

### C. File export

- **C1. `generateExportHtml(mdast)`.** The single HTML generator shared by *Copy as rich text* and *Export as `.html`* ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §6): `unified().use(remarkGfm).use(remarkRehype, { allowDangerousHtml: false }).use(absolutizeUrls, { origin: APP_ORIGIN }).use(rehypeStringify).run(mdastForExport(mdast))`, then `wrapSelfContainedHtml(...)`. `mdastForExport` strips the frontmatter node from the body (frontmatter is metadata, not body content — [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md)). `absolutizeUrls` resolves every root-relative image/link URL to absolute `https://` against `APP_ORIGIN` (pitfall 2.1.4). `wrapSelfContainedHtml` emits `<!doctype html>`, `<meta charset="utf-8">`, a single `<style>` block carrying the export typography, and the body. This is the **export** pipeline — it is **not** the preview pipeline (preview adds `rehype-sanitize` for in-app display; export targets foreign consumers — **D5**, §6).
- **C2. `triggerDownload(blob, filename)`.** Shared mechanism for both file exports: `URL.createObjectURL` → synthetic `<a download>` appended, `.click()`, removed, then `URL.revokeObjectURL(url)` **after** the click (§4 — revoke discipline is mandatory; skipping it leaks the blob).
- **C3. `safeFilename(title)`.** Strip path/illegal chars (`[\\/:*?"<>|]` → `-`), collapse whitespace, cap at 120 chars, fall back to `"untitled"` (§4).
- **C4. `exportMarkdownFile(source)`.** `new Blob([source.markdown], { type: "text/markdown;charset=utf-8" })` → `triggerDownload(blob, \`${safeFilename(source.title)}.md\`)`. No BOM by default (§4).
- **C5. `exportHtmlFile(source)`.** `const html = await generateExportHtml(source.mdast)` → `new Blob([html], { type: "text/html;charset=utf-8" })` → `triggerDownload(blob, \`${safeFilename(source.title)}.html\`)` (§5). Anchor downloads have no clipboard gesture/secure-context constraints, but in practice export is user-triggered.
- **C6. Export affordance.** `Ctrl+Shift+E` opens the export affordance where the writer chooses `.md` or `.html` (format choice is a palette/dialog selection, not separate top-level chords — [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2.5). Both formats are also direct rows in the **Copy/Export** palette section (§4.2). Export buttons live in the document's action menu / overflow, not a persistent toolbar ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §8; [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §6.10).

### D. Bespoke design pass (`frontend-design` skill)

> Run the **`frontend-design`** skill to drive this pass ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §1 P3, §9). It tunes the *values* of the canonical tokens in §10 of that file; it must **not** rename tokens, introduce a light theme, add stock-shadcn radii/shadows, or add persistent chrome.

- **D1. Final typefaces + webfonts.** Select the concrete faces for the three roles — `--font-reading` (refined serif / humanist sans for Rich text + Preview body and the reading scale), `--font-mono` (quality programming mono for Raw + Vim), `--font-ui` (neutral UI sans for chrome) — and implement webfont loading/subsetting ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §3.1). Keep `font-display` and fallback stacks so first paint is not blocked.
- **D2. Type scale + editor body + measure.** Apply the modular scale (`--text-display`, `--text-h1`…`--text-h6`, `--text-body`, `--text-ui`, `--text-ui-sm`, §3.2). Set the editor body at ~19px / line-height 1.6 (§3.3). Implement `.recto-measure` with `inline-size: clamp(45ch, 66ch, 75ch); margin-inline: auto;` for Rich text + Preview, never exceeding the ≤80 CPL WCAG 1.4.8 ceiling (§3.4). Headings differentiated by size + weight + spacing, not rules/fills (§3.5).
- **D3. OKLCH palette tuning + contrast verification.** Tune the four background layers, three ink levels, two lines, accents, semantics, and selection/focus tokens (§2.1). **Numerically verify** the §2.5 contrast targets (body prose ≥ 7:1, secondary/tertiary/semantic text ≥ 4.5:1, focus ring + non-text ≥ 3:1) and re-verify whenever a token's `L` changes — OKLCH lightness is not a WCAG ratio (§2.5 note). Record the measured ratios.
- **D4. Spacing + radii + layout.** Apply the single base-4 spacing scale (`--space-1`…`--space-8`) and the small radii (`--radius-sm/md/lg`, §4.5). Lay out the surface so the pane tree dominates the viewport, with the minimal top affordance (~40px, title + document switcher entry, §4.2) and the quiet status bar (~28px, §4.3).
- **D5. Status bar.** Finish the always-present quiet status bar (§4.3, §6.3): live **word count** (always available, **D15**; value rests at `--color-ink-tertiary`, lifts on hover/focus), the per-pane **mode indicator** reflecting the active pane (`Rich text`, `Raw Markdown`, `Vim · normal/insert/visual`, `Preview` — [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §7), and the **saving / sync indicator** (semantic colors per §5). `--color-bg-raised`, `--text-ui-sm`, single `--color-line` top hairline. Never removed for minimalism (P6).
- **D6. Pane framing.** Thin 1px `--color-line` hairline dividers with a wider (~8px) drag hit target; brighten to `--color-line-strong` on hover/drag; focused-pane emphasis via `--color-line-strong` boundary + ink-level demotion of inactive panes (§4.4, §6.2). No heavy borders or cards (P1/P3).
- **D7. Motion.** Implement the motion tokens (`--motion-instant/fast/base/slow`, the three easings, §7.1) and apply them: mode transition = brief content crossfade, content stays in place, never a slide (§7.2; [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §6.2); command palette open/close (scrim fade + rise); slash palette quick fade+rise; contextual toolbar fade+rise; panel reveals (undo-tree / version history slide+expand); dialog scrim fade + slight scale/rise; toast slide+fade. **Typing, caret, and text reflow never animate** (§7.3 — input latency is a feature). Honor `prefers-reduced-motion` globally: transforms drop to opacity-only or are removed, durations collapse to ~1ms, state changes still happen (§7.4).
- **D8. Visible states.** Finish all five (§5, §6): **empty (no documents)** — centered type-led empty state, `--text-display` headline at `--color-ink-secondary`, one-line hint at `--color-ink-tertiary`, single primary action, no illustration clutter; **empty document** within a pane; **focused writing** — the default, chrome at rest, optional focus/typewriter mode (§6.12, honoring reduced-motion); **loading / hydrating** — quiet skeleton/low-contrast shimmer on the pane, never a spinner over text (respects **D11** hydrate-on-open/idle); **saving** — quiet "saved" check at `--color-success` settling to nothing, "saving" pulse at `--color-ink-tertiary`; **offline / unsynced** — `--color-warning` with an explicit honest, non-alarmist label.
- **D9. Avoid the generic AI aesthetic.** Apply the do/don't table ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §9): native-OKLCH dark, typography carries hierarchy, real reading face + quality mono, centered ~66ch measure, one restrained accent on the single live affordance, elevation via luminance layers + hairlines, brief purposeful motion off the typing path, quiet contextual chrome. No stock near-black + saturated-blue + default-Inter card look.

### E. Accessibility pass

- **E1. Contrast on dark.** Confirm the D3 measured ratios meet §2.5 across body prose, secondary/tertiary text, semantic text, focus ring, and non-text indication. "Muted" ink never drops below AA.
- **E2. Visible focus rings.** Every focusable element shows a `:focus-visible` ring using `--color-focus-ring` (≥ 3:1, WCAG 1.4.11); rings appear for keyboard focus without cluttering mouse interaction; never removed for aesthetics (P6).
- **E3. Full keyboard operability.** Re-verify every surface is reachable and operable from the keyboard — command palette, slash command palette, document switcher, mode switching, undo-tree + version-history navigation, copy/export, view toggles. No action is mouse-only ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §8; [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §1 rule 1).
- **E4. ARIA — command palette / document switcher.** `role="combobox"` on the input, `role="listbox"`/`role="option"` on results, `aria-activedescendant` for the highlighted item so the active option is announced as the writer filters ([`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §8). `cmdk` provides most of this; verify the rendered DOM.
- **E5. ARIA — slash menu.** Menu/listbox semantics with the active item announced; `Esc` closes and returns focus to the editor with the `/` text intact ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §5.2; [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §8). (Built in Phase 2; verify here, fix if it regressed.)
- **E6. ARIA — dialogs.** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` title, focus trapped while open, focus restored to the trigger on close, `Esc` dismisses (export dialog, restore confirmation — §8, §6.10).
- **E7. ARIA — toasts / status.** Transient toasts and the saving/offline indicator announced via a live region (`role="status"` / `aria-live="polite"`, `assertive` for errors) so persistence state is conveyed non-visually (P6, §5).
- **E8. OS settings.** Honor `prefers-reduced-motion` (E7/§7.4); avoid load-bearing transparency (the luminance layers already convey elevation without alpha); respect forced-colors / high-contrast. No `prefers-color-scheme` light handling — dark only (**D13**).

### F. Final QA — verify every blueprint promise

A documented end-to-end pass after polish. Each item maps to a product principle / locked decision and must be demonstrably true:

- **F1. Lossless round-trip** (principle 3, **D1/D2**): a document that round-trips rich → raw → rich comes back byte-stable within the dialect; the Phase 2 round-trip property-test corpus ([`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md)) is green, including footnotes + tables.
- **F2. Never lose work** (principle 2, **D10/D11**): refresh, navigate away, and switch devices without losing content; persistence/merge tests green.
- **F3. Instant, lossless mode switches** (principle 4, §2.1; [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) §6): mode switch is a keystroke mounting a different projection — instant, content stays in place.
- **F4. Snappy typing** (principle 4, **D11**): no perceptible input latency; sync debounced off the hot path; the editor is never a controlled component of a reactive query.
- **F5. Undo tree + versions** (**D8/D9**): branching undo navigation across branches; auto + manual tagged versions; additive restore — all synced across devices ([`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md), [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md)).
- **F6. Split + workspace resume** (**D6**): nested split panes; same document open in two live editable modes kept in sync keystroke-by-keystroke; workspace (pane tree + open docs + per-pane state) restored on load and across devices ([`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md)).
- **F7. Export fidelity** (this phase): `.md` and `.html` open cleanly (`.html` in Word / Pages / Google Docs / LibreOffice); copy-as-rich-text keeps formatting in Google Docs/Gmail and stays plain in a code editor; copy-as-markdown yields raw source.

---

## Technical approach & key decisions

1. **One action registry, two surfaces.** The command palette is *not* a second place actions are defined. Each action exists once in the registry; the capture-phase chord handler ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.1–7.3.4) and the `cmdk` palette (§4) both dispatch into it. This is what lets a palette row faithfully display the exact chord and run the identical code path (§4.1). If this phase needs a field the registry lacks (e.g. a section tag or shortcut-hint string), add it to the registry, not to the palette.

2. **Copy/Export read the canonical model, never the DOM.** Every clipboard/export action funnels through `exportSourceFor(doc)` ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §1.1). Output is a property of the *document*, not the *lens*: a copy from Preview and a copy from Rich text produce identical bytes because both read the same MDAST (**D2**). We never read `editorView.dom.innerHTML` or the editor selection.

3. **Safari-safe clipboard, synchronous in the gesture.** `navigator.clipboard.write()` is the **first** async call inside the click/keypress handler; the HTML is generated by a `Promise<Blob>` passed *into* the `ClipboardItem`, so async work happens *after* transient activation is registered (pitfall 2). Each representation is a `Blob` (Chrome rejects raw strings for non-text MIME types — pitfall 1). One `ClipboardItem` with two keys (`text/html` + `text/plain`), not two items. Feature-detect and fall back to *Copy as Markdown* when `ClipboardItem`/`write` is absent (pitfall 5). The palette and buttons dispatch these handlers synchronously (no awaited tick before the call) so activation survives ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §8).

4. **`text/plain` carries Markdown, not stripped prose.** When *Copy as rich text* lands in a plain target (code editor, terminal, YAML field), the most useful plain representation of a Markdown document is its Markdown source. So `text/plain` = `source.markdown`. *Copy as Markdown* is `text/plain` only — adding a `text/html` representation there would make rich targets paste rendered output, defeating its purpose (§3). The two copy actions differ *exactly* by the presence/absence of `text/html`.

5. **One export HTML generator, distinct from preview.** `generateExportHtml(mdast)` is `remark-rehype` → `rehype-stringify` over the canonical MDAST and is shared by both *Copy as rich text* and *Export as `.html`* — one generator to test/maintain (§6). It is **not** the preview pipeline: preview adds `rehype-sanitize` for safe in-app display (**D5**); export targets foreign consumers (Word/Docs/Pages), absolutizes URLs, and embeds a `<style>` block. Because the input is the user's own canonical document (single-user, **D12**) containing only dialect constructs (**D7**), there is no untrusted-content vector to sanitize against on the export path (§6).

6. **`.html` is the rich export; `.rtf` is rejected, `.docx` is deferred.** `.html` opens cleanly in Word/Pages/Docs/LibreOffice and is generated with zero custom code from the canonical tree. RTF has no maintained browser-targeted generator and is fundamentally 8-bit (escaping + `\uNNNN` for non-ASCII) — a custom serializer we refuse to write (project rule: prefer battle-tested libraries; [`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §9, [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md)). `.docx` (via `html-to-docx`, never `html-docx-js` — `altChunk` is not honored by Docs/LibreOffice/Word-for-Mac) is a deferred enhancement (§10).

7. **Object-URL revoke discipline.** Both file exports go through `triggerDownload`, which revokes the object URL **after** the click is dispatched. Object URLs live until the document is discarded or explicitly revoked; repeated export without revoking leaks blobs (§4). This is non-negotiable, not an optimization.

8. **The design pass tunes tokens, it does not rename them.** [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §10 is the canonical token list; values are tuned in this phase. The `frontend-design` skill drives aesthetic finishing within those token names. Elevation is luminance layers + hairlines (no stock shadows); accent is spent on the single live affordance (the highlighted palette row, the focus ring, the synced/active saving indicator); the measure is centered ~66ch.

9. **Accessibility is a constraint, verified numerically.** Contrast ratios are *measured*, not assumed from OKLCH `L` (§2.5 note). Focus rings use `:focus-visible`. ARIA roles for palette (combobox/listbox + `aria-activedescendant`), dialogs (`role="dialog"` + `aria-modal` + focus trap/restore), and live regions for status/toasts are all required, not optional (§8).

10. **Motion never touches the hot path.** All motion is confined to chrome and overlays (§7.2–7.3). Typing, caret, and reflow never animate. `prefers-reduced-motion` is honored globally (§7.4) and is part of the a11y sign-off.

---

## Libraries introduced

| Library | Purpose | Notes |
|---------|---------|-------|
| [`cmdk`](https://www.npmjs.com/package/cmdk) | The command palette (fuzzy search, sectioned results, keyboard nav, combobox/listbox ARIA) | Named in stack ([`../blueprint/README.md`](../blueprint/README.md) §6). May already be installed for the Phase 3 document switcher (which can be a `cmdk` mode, [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) §6.5); if so, no new install. |
| `remark-rehype` | MDAST → hast for export HTML | Already in the stack ([`../blueprint/README.md`](../blueprint/README.md) §6) for preview; reused for export with different options (no sanitize). No *new* dep if already present. |
| `rehype-stringify` | hast → HTML string for export | Already in the stack ([`../blueprint/README.md`](../blueprint/README.md) §6); reused. |
| `remark-gfm` | GFM nodes (tables / task-lists / strikethrough / autolinks) in the export pipeline | Already in the stack (Phase 2). Reused in `generateExportHtml`. |

> **No genuinely new runtime dependency is expected** beyond `cmdk` (and even that may already be present from Phase 3). The export pipeline reuses the `unified`/`remark`/`rehype` family already established in Phases 1–2. `absolutizeUrls` is a small local rehype plugin (no library); a battle-tested URL primitive (`new URL(href, APP_ORIGIN)`) does the resolution. **Do not** add an RTF library, a `.docx` library, or a clipboard polyfill in v1.

---

## Data-model changes

**None.** This phase introduces **no schema changes** to the canonical Convex tables (`documents`, `docNodes`, `versions`, `workspaces` — [`../blueprint/README.md`](../blueprint/README.md) §7; [`../blueprint/03-data-model.md`](../blueprint/03-data-model.md)).

- The command palette **reads** existing data: the document list (`documents.by_user_updated`) for the Documents section; the active pane / workspace state (`workspaces`) for which document/pane actions target.
- Clipboard/export **read** the active document's canonical Markdown / MDAST (derived from `documents.markdown`, **D1**) and write *nothing* to Convex.
- The bespoke design pass touches **CSS tokens and components only** — the `@theme` block and component styling — not the data model.

If, during the registry audit (A1), an action needs a UI-only field (section tag, shortcut-hint string, aliases), that field lives in the **client-side action registry**, not in any Convex table.

---

## Acceptance / exit criteria

All boxes must be checked, demonstrated by an automated test or a recorded manual check, in addition to the global Definition of Done in [`./README.md`](./README.md).

> **Status: superseded by [`./README.md`](./README.md).** That phase map marks Phase 5 ✅ Done (Phases 0–5 complete, runtime-verified, with typecheck/biome/test/build green). The unchecked boxes below are the original execution checklist, kept for historical reference; treat the README status as authoritative.

**Command palette**
- [ ] `Cmd/Ctrl+K` opens the palette; `Esc` closes it and restores focus to the previously active pane.
- [ ] The palette fuzzy-searches over **all actions and all documents** from one query box (e.g. `prev`, `prview`, `pv` all surface "Switch to Preview"; a document title surfaces that document).
- [ ] Results are grouped in the canonical order **Documents → Modes → Panes → History → Copy/Export → View**; empty sections collapse as the query narrows.
- [ ] **Every** action in [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §2 is reachable from the palette and runs the same handler its chord fires (verified action-by-action against §2.7).
- [ ] Each action row shows its platform-correct shortcut on the right.
- [ ] The palette is fully keyboard-operable end to end (`↑/↓` across sections, `Enter`, `Esc`, type-to-filter, `Backspace`); the mouse is never required.
- [ ] `Cmd/Ctrl+P` opens the palette pre-scoped to the **Documents** section.

**Clipboard**
- [ ] *Copy as rich text* pasted into **Google Docs / Gmail keeps formatting**, and pasted into a **code editor stays plain** (it receives the Markdown source).
- [ ] *Copy as rich text* writes **one `ClipboardItem`** with both `text/html` (a `Promise<Blob>`) and `text/plain` (a `Blob`); `write()` is called synchronously in the gesture (Safari does not reject with `NotAllowedError`).
- [ ] *Copy as Markdown* yields **raw Markdown source** and carries **`text/plain` only** (a rich target pastes the source, not rendered output).
- [ ] When `ClipboardItem`/`write` is unavailable, *Copy as rich text* falls back to *Copy as Markdown* and notifies the user.
- [ ] Clipboard failures surface an honest, actionable toast (never silently swallowed); success shows a brief non-blocking confirmation.
- [ ] All clipboard output is derived from the active document's canonical MDAST, identical regardless of the active pane's mode (a copy from Preview equals a copy from Rich text, byte-for-byte).

**Export**
- [ ] *Export as `.md`* downloads a `text/markdown;charset=utf-8` file that opens cleanly; the object URL is revoked after the click (no leaked blobs across repeated exports).
- [ ] *Export as rich text (`.html`)* downloads a self-contained HTML file (one `<style>` block, absolute `https://` URLs) that **opens cleanly in Word, Pages, and Google Docs** with formatting intact.
- [ ] Both copy-rich-text HTML and export HTML come from the single `generateExportHtml` generator; frontmatter is not rendered into the body.
- [ ] Filenames are derived safely from `documents.title` (illegal chars stripped, capped, `"untitled"` fallback).
- [ ] `Ctrl+Shift+E` opens the export affordance offering both `.md` and `.html`.

**Design pass (signed off)**
- [ ] Final typefaces selected and loaded for `--font-reading`, `--font-mono`, `--font-ui`; reading body ~19px / line-height 1.6; measure centered ~66ch, never > 80 CPL.
- [ ] OKLCH palette tuned; **measured** contrast ratios meet §2.5 (body ≥ 7:1; secondary/tertiary/semantic ≥ 4.5:1; focus ring + non-text ≥ 3:1) and are recorded.
- [ ] Status bar shows live word count (always available, **D15**), the active-pane mode indicator (incl. `Vim · normal/insert/visual`), and the saving/sync indicator; it is never removed.
- [ ] Pane framing uses thin hairlines with focused-pane emphasis; no heavy borders/cards/shadows.
- [ ] Motion implemented per §7 (mode crossfade with content in place, palette open/close, panel reveals) and **honors `prefers-reduced-motion`**; typing/caret/reflow never animate.
- [ ] All five visible states finished: empty (no docs), empty document, focused writing, loading/hydrating, saving, offline/unsynced.
- [ ] The interface does not read as the generic AI aesthetic (§9 do/don't satisfied); the design pass is reviewed and signed off.

**Accessibility pass (signed off)**
- [ ] Visible `:focus-visible` rings on every focusable element using `--color-focus-ring`.
- [ ] Full keyboard operability re-verified across palette, slash menu, switcher, mode switching, history navigation, copy/export, view toggles.
- [ ] ARIA verified: palette/switcher (combobox/listbox + `aria-activedescendant`), slash menu (menu/listbox, `Esc` restores `/`), dialogs (`role="dialog"` + `aria-modal` + focus trap/restore + `Esc`), toasts/status (live region).
- [ ] `prefers-reduced-motion` honored; forced-colors/reduced-transparency respected; no light-theme handling.

**Final QA (all blueprint promises)**
- [ ] Lossless round-trip (rich → raw → rich byte-stable; footnotes + tables); round-trip corpus green.
- [ ] Never-lose-work across refresh + navigate-away + device switch; persistence/merge tests green.
- [ ] Instant, lossless mode switches; content stays in place.
- [ ] Snappy typing — no perceptible input latency; editor is never a controlled component of a reactive query.
- [ ] Undo tree (branching navigation) + versions (auto/manual tags, additive restore) work and sync across devices.
- [ ] Split panes + same-doc-two-live-modes + workspace resume work and persist across devices.

**Global gates**
- [ ] `bun run typecheck` passes with no errors.
- [ ] `bun run biome check` passes with no errors.

---

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Safari rejects clipboard `write()` with `NotAllowedError`** because async HTML generation consumed transient activation | Medium | High (rich copy broken on the user's likely-Mac/Safari path) | Use the **Promise-in-`ClipboardItem`** pattern exactly ([`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) §2.2): `write()` is the first async call; the HTML is a `Promise<Blob>` passed into the item. Verify the palette/button dispatch calls the handler synchronously (no awaited tick). Test in real Safari, not just Chromium. |
| **Chrome throws on raw-string `ClipboardItem` values** for non-text MIME types | Medium | High | Always wrap each representation in a `Blob` (pitfall 1) — write it the strict way for all browsers. |
| **Exported HTML breaks in Word/Docs** (relative/`blob:` URLs, external stylesheet, non-self-contained) | Medium | High (the recommended rich export is unusable) | `absolutizeUrls` resolves every root-relative URL to absolute `https://` against `APP_ORIGIN` (pitfall 2.1.4); `wrapSelfContainedHtml` inlines a single `<style>` block; **manually open exports in Word, Pages, and Google Docs** as an exit gate (F7). |
| **Object-URL leak** from skipping `revokeObjectURL` | Low | Medium (slow memory growth over a session) | `triggerDownload` revokes after the click; covered by an exit criterion and a repeated-export check. |
| **Palette drifts into a second action definition** (divergent handlers, wrong shortcut hints) | Medium | Medium (the palette teaches the wrong chord; behaviors diverge) | Enforce **one registry, two surfaces** ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.4): the palette imports the same registry the chord handler uses; shortcut hints are read from the registry, not hand-typed. |
| **Contrast assumed from OKLCH `L`, not measured** | Medium | Medium (fails WCAG on dark despite "looking fine") | Measure ratios numerically against the actual background layers; re-measure whenever a token `L` changes (§2.5 note); record the numbers (D3/E1). |
| **Design pass introduces stock-shadcn defaults / a light theme / new chrome** (scope/aesthetic creep) | Medium | Medium | The `frontend-design` skill tunes **named tokens only** (§10); the §9 do/don't and **D13** (dark only) / P2 (no persistent chrome) are review gates. Blast-radius rule: surface unrelated observations as suggestions, do not act on them. |
| **Reduced-motion not honored on a new transition** | Low | Medium (a11y regression) | Global `prefers-reduced-motion` rule (§7.4) plus a per-surface a11y check (E8); part of sign-off. |
| **Polish breaks a Phase 1–4 promise** (e.g. a controlled-value regression clobbers the cursor; a sync regression) | Low | High | Final QA (section F) re-runs the round-trip corpus, persistence/merge tests, and manual snappiness/mode-switch/split/resume checks **after** the design changes land, not before. |
| **`Cmd/Ctrl+S` / `Cmd/Ctrl+P` palette entries fight the browser** (save-page / print) | Low | Low | These are already handled by the capture-phase handler ([`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) §7.3.5) which `preventDefault()`s while a studio pane is focused; the palette dispatches the same registry action and does not re-introduce the browser default. |

---

## References

**Plan**
- [`./README.md`](./README.md) — the phase map, conventions, the global Definition of Done, the carried risk register.
- [`./phase-1-foundation.md`](./phase-1-foundation.md), [`./phase-2-modes-and-losslessness.md`](./phase-2-modes-and-losslessness.md), [`./phase-3-multi-doc-split-workspace.md`](./phase-3-multi-doc-split-workspace.md), [`./phase-4-history.md`](./phase-4-history.md) — the prerequisites this phase sits on.

**Blueprint (canon)**
- [`../blueprint/README.md`](../blueprint/README.md) — locked decisions **D1–D15**, product principles, the canonical Convex schema (§7), the dialect (§8), the glossary, v1 non-goals (§5).
- [`../blueprint/11-clipboard-export.md`](../blueprint/11-clipboard-export.md) — the full clipboard/export spec this phase implements: `ExportSource` (§1.1), the four actions (§1.2), Copy as rich text (§2), Copy as Markdown (§3), Export `.md` (§4), Export `.html` (§5), `generateExportHtml` (§6), error handling (§7), UI/palette placement (§8), why-skip-`.rtf` (§9), deferred `.docx` (§10).
- [`../blueprint/12-design-system.md`](../blueprint/12-design-system.md) — the bespoke design + a11y system this phase finishes: principles (§1), OKLCH palette + contrast (§2), typography + measure (§3), layout/chrome + status bar (§4), visible states (§5), component inventory (§6), motion (§7), accessibility (§8), avoiding the generic AI aesthetic (§9), the canonical token list (§10).
- [`../blueprint/13-keyboard-commands.md`](../blueprint/13-keyboard-commands.md) — the full keymap (§2), the `cmdk` command palette (§4: behavior, sections, keyboard nav), the slash list (§5), Vim interplay (§6), conflict resolution + the single action registry (§7).
- [`../blueprint/06-markdown-dialect.md`](../blueprint/06-markdown-dialect.md) — the dialect (CommonMark + GFM + footnotes + YAML frontmatter) the exporters must render, serialization/normalization + frontmatter handling, the round-trip corpus QA leans on.
- [`../blueprint/04-editor-modes.md`](../blueprint/04-editor-modes.md) — the per-pane mode indicator (§7) the status bar shows; the instant/lossless mode-switch behavior (§6) QA verifies.
- [`../blueprint/07-undo-tree.md`](../blueprint/07-undo-tree.md), [`../blueprint/08-version-control.md`](../blueprint/08-version-control.md) — what the **History** palette section and the QA undo-tree/versions checks exercise.
- [`../blueprint/09-documents-workspace-split.md`](../blueprint/09-documents-workspace-split.md) — the document list, active pane (`workspaces.activePaneId`), and split/workspace state the palette reads and QA verifies.
- [`../blueprint/14-tech-decisions.md`](../blueprint/14-tech-decisions.md) — the ADR for skipping `.rtf` and the lossless single-canonical-model rationale.

**External**
- MDN — [`Clipboard.write()`](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write), [`ClipboardItem`](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem).
- web.dev — [Unblocking clipboard access](https://web.dev/articles/async-clipboard).
- npm — [`cmdk`](https://www.npmjs.com/package/cmdk), [`html-to-docx`](https://www.npmjs.com/package/html-to-docx) (deferred `.docx`, out of scope).
- WCAG — 1.4.3/1.4.6 contrast, 1.4.8 line length (≤ 80 CPL), 1.4.11 non-text contrast, 1.4.11/2.4.7 focus visibility.
