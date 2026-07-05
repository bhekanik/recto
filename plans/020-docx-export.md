# Plan 020: Ship `.docx` export via remark-docx (supersedes the html-to-docx ADR pin)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e8058fe..HEAD -- lib/export lib/keyboard/actions.ts lib/studio/action-map.ts package.json docs/blueprint/11-clipboard-export.md docs/blueprint/14-tech-decisions.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (new dependency; fidelity across Word/Docs/LibreOffice needs manual verification)
- **Depends on**: none (nice-to-have after 012 so CI guards it)
- **Category**: direction
- **Planned at**: commit `e8058fe`, 2026-07-05

## Why this matters

`.docx` is the one deliberately deferred v1 export ("Rejected for v1 — not
skipped, just deferred", blueprint ADR-13). Writers who hand drafts to Word-based
editors currently round-trip through `.html`, which Word opens but treats as a
web page. The blueprint pinned the future approach as "`html-to-docx` over the
export HTML" — **that pin is stale**: 2026 research (web audit, 2026-07-05)
found the original `html-to-docx` unmaintained since 2023-03, and the maintained
fork (`@turbodocx/html-to-docx`) cannot produce real Word footnotes (HTML input
has no footnote semantics — they degrade to superscript links). Recto's dialect
includes footnotes, GFM tables, and task lists.

The state-of-the-art fit is **`remark-docx`** (npm, v0.3.29, actively released
Jun 2026, built on `docx` 9.7.x with 15.6M weekly downloads): an mdast→docx
unified plugin — the only audited candidate emitting real OOXML footnotes,
alignment-aware GFM tables, AND checkbox task lists, straight from the canonical
MDAST with no HTML round-trip. It slots into the exact pipeline family the
export path already uses.

## Current state

- Export pipeline exemplar, `lib/export/file.ts` (43 lines — read it whole):
  ```ts
  export function exportHtmlFile(source: ExportSource): void {
      const html = generateExportHtml(source.markdown, source.title);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      triggerDownload(blob, `${safeFilename(source.title)}.html`);
      toast("Exported HTML", "success");
  }
  ```
  `triggerDownload` (same file, lines 16-25) handles the `<a download>` +
  `revokeObjectURL` discipline — reuse it, do not duplicate.
- `ExportSource` comes from `lib/export/clipboard.ts` — `{ title, markdown, … }`;
  the export actions funnel through a single accessor (blueprint 11 §1.1).
  Check whether it carries the mdast or just the markdown string; remark-docx
  takes markdown through a unified processor, so the string suffices.
- Export actions & registry: `lib/keyboard/actions.ts:309-320` — `export-md` /
  `export-html` rows (section, labels, `Ctrl+Shift+E` affordance). Dispatch in
  `lib/studio/action-map.ts` (`"export-md"` / `"export-html"` entries near the
  `copy-rich` entry at `:158-160`).
- Frontmatter rule: the HTML export strips the frontmatter node from the body
  (metadata, not content — blueprint 11 §6 / phase-5 C1). The `.docx` export
  must do the same — check how `generateExportHtml` (`lib/export/html.ts`) does
  it and mirror.
- Markdown dialect: CommonMark + GFM + footnotes + YAML frontmatter
  (`docs/blueprint/06-markdown-dialect.md`); the parse config the app uses
  lives in `lib/markdown/` — reuse the same remark plugins for the export
  processor so the docx sees the identical tree.
- Dependency policy: battle-tested libs preferred; bun for installs. remark-docx
  has optional heavy peer plugins (shiki/mermaid/mathjax paths) — Recto needs
  none of them; verify the import is tree-shaken (client bundle) or
  dynamic-import the export module so the docx code loads on demand.
- ADR to update: `docs/blueprint/14-tech-decisions.md` ADR-13 (the .docx
  deferral + html-to-docx pin) and `docs/blueprint/11-clipboard-export.md` §10.

## Commands you will need

| Purpose   | Command                     | Expected on success |
|-----------|-----------------------------|---------------------|
| Install   | `bun install`               | exit 0              |
| Add dep   | `bun add remark-docx`       | exit 0, lockfile updated |
| Typecheck | `bun run typecheck`         | exit 0              |
| Lint      | `bun run biome`             | exit 0              |
| Tests     | `bun run test`              | all pass            |
| Build     | `bun run build`             | exit 0              |
| Dev run   | `bun run dev`               | app on :3000        |

## Scope

**In scope**:
- `package.json` / `bun.lock` (one new dependency: `remark-docx`; `docx` comes
  as its dependency — do not add it separately unless imports require it)
- `lib/export/docx.ts` (create), `lib/export/index.ts` (re-export)
- `lib/export/docx.test.ts` (create)
- `lib/keyboard/actions.ts`, `lib/studio/action-map.ts` (the `export-docx` action)
- `docs/blueprint/11-clipboard-export.md` §10 and
  `docs/blueprint/14-tech-decisions.md` ADR-13 (supersede the html-to-docx pin,
  dated, with the research rationale in two sentences)

**Out of scope**:
- Custom Word styling/theme mapping (headings→Word styles beyond remark-docx
  defaults) — first ship default fidelity; styling is a follow-up if wanted.
- `.rtf` (rejected by ADR — permanent), PDF, or any other format.
- Server-side generation — this is client-side like the other exports.
- Images: IF remark-docx can't fetch the Convex-storage image URLs client-side
  (CORS), ship v1 with images as absolute-URL alt text and record the
  limitation — do not build an image-proxying layer in this plan.

## Git workflow

- Work on `main`. Conventional commits, e.g. `feat: export as .docx via remark-docx`
  and `docs: supersede html-to-docx ADR pin`. No AI attribution. Don't push
  unless asked.

## Steps

### Step 1: Add the dependency and the module

`bun add remark-docx`. Create `lib/export/docx.ts`:

- Build a unified processor: same remark parse plugins the canonical pipeline
  uses (find them in `lib/markdown/` — likely `remark-parse` + `remark-gfm` +
  frontmatter + footnote config) + `remark-docx` with `{ output: "blob" }`.
- Strip the frontmatter node before compiling (mirror `generateExportHtml`).
- `export async function exportDocxFile(source: ExportSource): Promise<void>`
  — process `source.markdown`, get the Blob, call
  `triggerDownload(blob, `${safeFilename(source.title)}.docx`)`, then
  `toast("Exported Word document", "success")`; on failure
  `toast("Couldn't export .docx", "error")` and rethrow nothing (match the
  error posture of the clipboard module — read `lib/export/clipboard.ts` first).
- Use a **dynamic `import()`** of `remark-docx` inside the function so the
  dependency stays out of the main bundle.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Wire the action

Add `export-docx` to `lib/keyboard/actions.ts` (same section/affordance as
`export-md`/`export-html`, no new chord — it appears under the `Ctrl+Shift+E`
export affordance and the palette Copy/Export section) and dispatch it in
`lib/studio/action-map.ts` beside the other two exports.

**Verify**: `bun run typecheck && bun run biome` → exit 0.

### Step 3: Unit tests

`lib/export/docx.test.ts`, modeled on the existing export tests (find them:
`ls lib/export/*.test.ts`): a fixture markdown exercising heading, bold/italic,
GFM table with alignment, task list, footnote, and frontmatter → assert the
processor produces a Blob of the docx MIME type
(`application/vnd.openxmlformats-officedocument.wordprocessingml.document`) and
(cheap structural check) that unzipping the blob (docx = zip) finds
`word/document.xml` containing the heading text and `word/footnotes.xml`
containing the footnote text. Bun can unzip via `Bun.file` + a zip lib only if
one is already present — otherwise assert on Blob size > 0 + MIME and do the
structural check manually in Step 4 (do NOT add a zip dependency for tests).

**Verify**: `bun run test -- docx` → new tests pass.

### Step 4: Fidelity check (manual, recorded)

`bun run dev` → a test document containing the full dialect (use the round-trip
corpus content from `lib/markdown/corpus/cases.ts` as a source of constructs) →
Export as `.docx` → open in **Word (or Word Online), Google Docs (import), and
LibreOffice**. Record per target: headings, tables (alignment), task lists,
footnotes (must be real Word footnotes, at the bottom, numbered), links.

**Verify**: all three targets open the file; footnotes are genuine footnotes in
at least Word; discrepancies recorded in the report.

### Step 5: Update the ADR + blueprint

Per Scope: mark the html-to-docx pin superseded (dated 2026-07-05, one-line
rationale: original unmaintained since 2023; fork lacks footnote semantics;
remark-docx compiles the canonical MDAST directly). Update blueprint 11 §10
from "optional future" to shipped, noting the image limitation if Step 1's
CORS caveat materialized.

**Verify**: `grep -n "html-to-docx" docs/blueprint/*.md` → every remaining
mention sits inside superseded/historical wording.

## Test plan

- `lib/export/docx.test.ts` per Step 3.
- Manual fidelity matrix per Step 4, recorded in the final report.
- `bun run test && bun run build` green.

## Done criteria

- [ ] `export-docx` reachable from palette + export affordance; downloads a `.docx`
- [ ] Fixture test passes; full suite green; build green (bundle: docx code is dynamically imported)
- [ ] Manual fidelity matrix recorded (Word + Google Docs + LibreOffice)
- [ ] Frontmatter never renders into the document body
- [ ] ADR-13 + blueprint §10 updated with the superseding decision
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- remark-docx cannot be configured to parse the repo's exact dialect (footnote
  or frontmatter plugin incompatibility with the pinned unified versions in
  `package.json`) — do not fork or patch it; report the incompatibility.
- Word/LibreOffice fail to OPEN the file at all (corrupt zip) for the fixture
  document.
- The dependency pulls >2 MB into the main client bundle despite dynamic import
  (check the build output) — report; we may gate it differently.

## Maintenance notes

- remark-docx is 0.3.x — pin it (bun's default caret is fine only if CI (plan
  012) runs the docx tests; otherwise pin exact) and re-run the Step 4 matrix
  on upgrades.
- If custom Word styles are requested later, remark-docx accepts docx.js style
  options — extend `lib/export/docx.ts`, not the action layer.
- If images-in-docx becomes a need, revisit the CORS note in Scope; the fix is
  likely fetching blobs via the existing authed session and passing an image
  resolver to the processor.
