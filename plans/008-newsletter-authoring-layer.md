# Plan 008: Add a newsletter authoring layer — subject + preheader metadata, an inbox/email preview, reading-time, and image paste to Convex storage

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (create that file from the template at the end of this
> plan if it does not exist) — unless a reviewer dispatched you and told you
> they maintain the index.
>
> This plan is **phased**: Phase A (metadata + reading-time) is low-risk and
> ships value alone; Phase B (email preview) builds on it; Phase C (image →
> Convex storage) touches the backend and is the riskiest. **You may stop
> after any completed phase** and report — each phase leaves the app working.
>
> **Drift check (run first)**:
> `git diff --stat a25c506..HEAD -- lib/markdown/frontmatter.ts lib/markdown/frontmatter.test.ts lib/markdown/index.ts components/workspace/document-header.tsx components/workspace/pane-editor.tsx lib/preview/render.ts lib/editor/preview/index.tsx lib/export/html.ts lib/export/index.ts lib/export/clipboard.ts lib/export/file.ts components/status-bar.tsx components/studio-shell.tsx lib/keyboard/actions.ts lib/modes/types.ts convex/schema.ts convex/documents.ts lib/editor/milkdown/index.tsx lib/editor/codemirror/index.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (Phase A LOW, Phase B LOW, Phase C MED — backend + greenfield Convex storage)
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `a25c506`, 2026-06-17

## Why this matters

Recto's stated persona (`docs/blueprint/01-product-overview.md` §1) is "a
private, single-user, web-based writing studio **for newsletters and long-form
articles**" — yet it has zero newsletter-specific features. Substack, Ghost, and
Beehiiv all give the author a subject line and a preview/preheader field
(distinct from the document's H1 title), an inbox/email preview, and image
handling. This plan adds those *authoring* aids: subject + preview-text metadata
that round-trips losslessly in YAML frontmatter, an inbox-style email preview
(email-safe inline-CSS render of the document), a reading-time estimate beside
the word count, and image paste/drop that uploads to Convex file storage and
inserts a real Markdown image reference.

**Hard product boundary — stay on the preview/export side of it.**
`docs/blueprint/01-product-overview.md` §8 non-goals (line 190):

> **Publishing / sending newsletters.** Recto does not send email or publish to
> any platform. Writing leaves the product by **export + copy only** (§5e,
> `11-clipboard-export.md`).

And §5e (line 141):

> This is the boundary of the product: writing leaves Recto by copy or export
> only; Recto does not send or publish.

Everything in this plan is preview-side or export-side. **There is NO "send",
"publish", "schedule", SMTP, ESP API, or recipient list anywhere in this plan.**
If any step seems to require one, that is a STOP condition (see below).

## Current state

The facts the executor needs, inlined. Read each cited file first-hand before
editing — line numbers are from commit `a25c506`.

### Vocabulary & design constraints this plan must honor

From `docs/blueprint/01-product-overview.md`:

- §3 / §7 (line 52, 172): the **canonical model** is a remark MDAST, "persisted
  to Convex **as a Markdown string**. The Markdown string is the source of truth
  at rest." Dialect = **CommonMark + GFM + footnotes + YAML frontmatter** (D7).
  → Subject and preview text are **frontmatter metadata**, stored in the
  Markdown string, NOT a new database column (see Decisions).
- §6 quality bar (line 155): "Premium and bespoke … The tool disappears: minimal
  chrome, the writing surface dominates. **Not a templated default.**" → the
  metadata fields and reading-time are quiet, dark-only, OKLCH-token styled; no
  loud panels.
- §8 (line 188): "The product is **dark only** (D13)." → all new UI uses the
  existing OKLCH tokens in `app/globals.css`; **no light theme, no raw hex**.
  (Exception: the *email preview render* deliberately uses light, inline,
  email-safe colors because that is how an email client shows it — that HTML is
  export-side output, not app chrome. See Phase B.)
- §8 (line 192): documents over Convex's **~1 MiB ceiling** are out of scope.
  This applies to the Markdown *string*. **Image blobs do NOT count against it**
  — they live in Convex file storage (separate blob store), which is exactly why
  Phase C uploads images instead of inlining base64 (see Decisions).

The user's standing preference (project memory `recto-prefer-user-toggles.md`):
for any genuine A/B design fork, **build a switchable setting — do not
hard-pick.** Phase B exposes the email preview as a *fifth mode* AND there is a
real fork (5th lens vs separate panel) — resolved as a setting (see Phase B,
Step B1).

From `docs/blueprint/11-clipboard-export.md`:

- §1.1 (line 22): export HTML "is intentionally **not** the same as the on-screen
  preview pipeline … export HTML is generated for *foreign* consumers (Word,
  Docs, Pages)". The email render is a *third* sibling of these two pipelines:
  foreign-consumer HTML, but with **inline** styles (email clients strip
  `<style>` blocks and external CSS). Reuse `generateExportHtml`'s structure; do
  not reuse its `<style>`-block approach verbatim (see Phase B).
- §5 (line 239): export HTML must be **self-contained** with **absolute
  `https://` URLs** for images. The email render inherits both requirements (the
  `absolutizeUrls` transform in `lib/export/html.ts` already does the URL part).

### Frontmatter: where subject/preview attach — `lib/markdown/frontmatter.ts`

Whole file is 96 lines. The key types and the `extra` preservation
(lines 8–22, 47–66, 73–96):

```ts
/** The two header fields Recto surfaces from YAML frontmatter. */
export type DocumentMeta = {
	title: string;
	subtitle: string;
};

export type SplitDocument = {
	meta: DocumentMeta;
	/** Frontmatter keys other than title/subtitle — preserved on recompose. */
	extra: Record<string, unknown>;
	/** Canonical Markdown body with the frontmatter block removed. */
	body: string;
};

export const EMPTY_META: DocumentMeta = { title: "", subtitle: "" };
```

`splitFrontmatter` destructures known keys out and returns the rest as `extra`
(lines 55–60):

```ts
const parsed = parseYaml(first.value);
const { title, subtitle, ...extra } = parsed;
const meta: DocumentMeta = {
	title: toStringField(title),
	subtitle: toStringField(subtitle),
};
```

`composeFrontmatter` re-emits known keys, then folds `extra` back in, skipping
title/subtitle so nothing is duplicated (lines 73–96):

```ts
export function composeFrontmatter(
	meta: DocumentMeta,
	body: string,
	extra: Record<string, unknown> = {},
): string {
	const ordered: Record<string, unknown> = {};
	if (meta.title.trim()) ordered.title = meta.title;
	if (meta.subtitle.trim()) ordered.subtitle = meta.subtitle;
	for (const [key, value] of Object.entries(extra)) {
		if (key !== "title" && key !== "subtitle") ordered[key] = value;
	}
	// ... emits `---\n${yaml}\n---\n` then normalizeMarkdown(composed)
}
```

**Decision point (read carefully — this drives the whole shape of Phase A).**
There are two ways to wire subject/preview:

1. **Promote them to `DocumentMeta`** (add `subject` and `preview` fields
   alongside `title`/`subtitle`, with their own `splitFrontmatter` destructure
   and `composeFrontmatter` emit). **This is the recommended approach** because
   it is symmetric with how `title`/`subtitle` already work, gives the rest of
   the code a typed `meta.subject` / `meta.preview`, and keeps the YAML key order
   deterministic (title, subtitle, subject, preview, …extra). The existing
   round-trip + idempotence tests (`frontmatter.test.ts`) already cover this
   shape; you extend them.
2. **Leave them in `extra`** and read/write `extra.subject` / `extra.preview`
   from the UI. This works (the `extra` block already round-trips) but pushes
   untyped `unknown` reads through the whole UI and makes key ordering
   nondeterministic. **Do NOT do this.**

→ **Use approach 1.** The feature brief's phrase "store them in the `extra`
block" describes *where they live in the YAML conceptually* (they are not
title/subtitle); promoting them to typed `DocumentMeta` fields is the same YAML
location with a typed surface. Both produce identical on-disk YAML.

> ⚠️ **`extra` round-trip caveat — verify, then proceed.** The existing test
> (`frontmatter.test.ts:47-58`) shows that a YAML `date: 2026-06-16` value
> round-trips as a **`Date` object**, not a string (`String(reSplit.extra.date)`
> is asserted, not `===`). This is js-yaml's default type resolution. **Plain
> string values (subject/preview) round-trip as strings** — verified:
> `dump(load("subject: Hello"))` → `subject: Hello`. So promoting them to typed
> `string` fields is safe. But this is exactly why approach 1 (typed
> `toStringField` coercion, same as title/subtitle) is safer than reading raw
> `extra` values, which can be non-string. **STOP condition**: if you find a
> subject/preview value coming back as a non-string after round-trip, the YAML
> handling changed — stop and report.

### Document header UI — `components/workspace/document-header.tsx`

Whole file is 92 lines. `DocumentMeta` drives it. The reusable `AutoField`
(growing single-line textarea, lines 17–53) and the header (lines 66–92):

```tsx
type DocumentHeaderProps = {
	meta: DocumentMeta;
	onChange: (meta: DocumentMeta) => void;
	onEnterBody?: () => void;
};

export function DocumentHeader({ meta, onChange, onEnterBody }: DocumentHeaderProps) {
	return (
		<div className="recto-doc-header" data-doc-header>
			<AutoField value={meta.title} onChange={(title) => onChange({ ...meta, title })} ... className="recto-doc-title" />
			<AutoField value={meta.subtitle} onChange={(subtitle) => onChange({ ...meta, subtitle })} ... className="recto-doc-subtitle" />
			<hr className="recto-doc-divider" />
		</div>
	);
}
```

This header renders ONLY in rich mode (`pane-editor.tsx:459-463`). The
`data-doc-header` attribute is load-bearing: `pane-editor.tsx:182` and
`milkdown/index.tsx` use `document.activeElement?.closest("[data-doc-header]")`
to avoid clobbering the header while the writer types in it. **Any new metadata
field MUST live inside the `[data-doc-header]` subtree** so that guard keeps
working.

### How meta flows: header ↔ Milkdown frontmatter

`components/workspace/pane-editor.tsx` owns `headerMeta` state (lines 69–85) and
wires it to the rich editor:

- `handleMetaChange` (lines 74–77): sets local state AND calls
  `richRef.current?.setMeta(meta)`.
- `handleEditorMeta` (lines 82–85): Milkdown reports frontmatter on seed; ignored
  while the header has focus.
- Rendered at lines 459–470 — `<DocumentHeader meta={headerMeta} onChange={handleMetaChange} … />`
  above `<MilkdownEditor … onMeta={handleEditorMeta} />`.

`lib/editor/milkdown/index.tsx` holds the frontmatter out-of-band because
ProseMirror renders body only (lines 76–79, 133–171). It splits on `seed`
(`metaRef`/`extraRef`, lines 137–140) and recomposes on `getCanonicalMarkdown`
(line 155) and `setMeta` (lines 157–171) via `composeFrontmatter(metaRef.current,
body, extraRef.current)`. **Because `setMeta` already takes a full `DocumentMeta`
and recomposes through `composeFrontmatter`, adding `subject`/`preview` to
`DocumentMeta` makes them flow end-to-end with NO change to the Milkdown
plumbing** — `setMeta(meta)` will carry the new fields automatically.

### Preview pipeline — `lib/preview/render.ts` + `lib/editor/preview/index.tsx`

`renderPreviewHtml` (render.ts, whole file 23 lines) is `remark-rehype` →
`rehype-sanitize` → `rehype-stringify` over parsed MDAST. `PreviewPane`
(preview/index.tsx, whole file 38 lines) splits frontmatter, renders the
`meta.title`/`meta.subtitle` header above the sanitized body:

```tsx
export function PreviewPane({ markdown, className }: PreviewPaneProps) {
	const { meta, body } = useMemo(() => splitFrontmatter(markdown), [markdown]);
	const html = useMemo(() => renderPreviewHtml(body), [body]);
	const hasHeader = Boolean(meta.title.trim() || meta.subtitle.trim());
	// renders recto-doc-header (title/subtitle) then recto-prose body
}
```

This is the structural model for the email preview component in Phase B (split
frontmatter → render header chrome → render body), but the email preview uses the
**export** HTML render with inline styles, not `renderPreviewHtml`.

### Export pipeline — `lib/export/html.ts` (basis for the email render)

Whole file is 135 lines. `generateExportHtml(markdown, title)` (lines 126–135):

```ts
export function generateExportHtml(markdown: string, title: string): string {
	const { meta } = splitFrontmatter(markdown);
	const header = renderExportHeader(meta);
	const body = buildProcessor().processSync(markdown).toString();
	const docTitle = meta.title.trim() || title;
	return wrapSelfContainedHtml(`${header}${header ? "\n" : ""}${body}`, docTitle);
}
```

`buildProcessor()` (lines 53–62): `remarkParse` → `remarkGfm` →
`remarkFrontmatter(["yaml"])` → `stripFrontmatter` → `remarkRehype` →
`absolutizeUrls(appOrigin())` → `rehypeStringify`. The `absolutizeUrls` transform
(lines 28–45) resolves root-relative `href`/`src` to absolute URLs — **reuse this
for the email render**. `EXPORT_STYLE` (lines 64–88) is a `<style>` block of
**light** colors (`color-scheme: light; color: #1a1a1a; …`) — note: export HTML
is already light, so the email render's light palette is consistent with the
existing export contract, not a violation of dark-only (which governs *app
chrome*). `renderExportHeader` (lines 113–123) emits title + subtitle + `<hr>`.

`lib/export/index.ts` (whole file, 7 lines) is the barrel; it re-exports
`generateExportHtml`, the clipboard fns, and the file fns. `lib/export/clipboard.ts`
`copyAsRichText`/`copyAsMarkdown` and `lib/export/file.ts`
`exportHtmlFile`/`exportMarkdownFile` all funnel through `generateExportHtml` and
`ExportSource = { title: string; markdown: string }`.

### Status bar — `components/status-bar.tsx` (where reading-time goes)

Whole file is 295 lines. Word count renders near the end (lines 282–284) using
`formatWordCount` (lines 58–60: `${count.toLocaleString()} word(s)`). The
`StatusBarProps` type is lines 36–56; `wordCount: number` is its first field. The
status bar is rendered in `components/studio-shell.tsx` lines 588–630, with
`wordCount={activeSync.wordCount}` (line 591). The toggle/readout styling to
MATCH: tertiary ink text, `tabular-nums`, OKLCH tokens only, secondary readouts
wrapped in the `hidden … sm:flex`/`min-[360px]:inline` clusters so they fold away
on phones (see the existing word-count span at line 282). **No new CSS tokens, no
hex.**

### Convex — `convex/schema.ts`, `convex/documents.ts` (Phase C only)

`convex/documents.ts` lines 11–33 — the auth helpers to import (do NOT redefine):

```ts
export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new Error("Unauthenticated");
	return identity.subject;
}
export async function requireOwnedDocument(ctx, documentId): Promise<Doc<"documents">> { ... }
```

`requireUserId` is already `export`ed from `convex/documents.ts:12` — import it.
`mutation`/`query` are imported from `./_generated/server` (documents.ts:4).
`convex/auth.config.ts` configures the Clerk JWT issuer (`CLERK_JWT_ISSUER_DOMAIN`
env) so `ctx.auth.getUserIdentity()` resolves. **Convex file storage is currently
UNUSED** — `grep -rn "ctx.storage" convex/` returns nothing. This is greenfield;
Convex file storage (`ctx.storage.generateUploadUrl()`, `ctx.storage.getUrl(id)`)
is a **built-in** capability of any Convex deployment — it requires **no extra
config or `convex.json` change** beyond the existing setup. (Verify in Phase C
Step C1 before building on it; if `generateUploadUrl` is missing from the
generated server types, STOP.)

### Editors — paste/drop handlers (Phase C only)

`lib/editor/codemirror/index.tsx` (376 lines) builds the CM6 instance in a
`useEffect` (lines 233–283) with an `extensions` array (lines 254–264). There is
**no paste/drop handler today** — you add one via `EditorView.domEventHandlers({
paste, drop })` as a new extension in that array. Inserting text uses
`view.dispatch({ changes: { from, to, insert } })` (see `wrapInline`, lines
50–60). `lib/editor/milkdown/index.tsx` (322 lines) has no paste handler either;
ProseMirror paste is harder to intercept cleanly. **Phase C targets the
CodeMirror surface only** (raw/vim) for the first cut — it is where a Markdown
image reference (`![](url)`) is the natural insertion, and it avoids
ProseMirror's paste-rule complexity. Inserting an image in rich mode is then
just typing `![alt](url)` which Milkdown renders. (A Milkdown drop handler is
explicitly deferred — see Maintenance notes.)

### Mode ring — `lib/modes/types.ts`

`Mode = "rich" | "raw" | "vim" | "preview"` (line 1); `MODE_RING` (line 3) and
`modeToLabel` (lines 23–34) enumerate exactly those four. The `ActionId` union in
`lib/keyboard/actions.ts:17-50` includes `"mode-rich" | "mode-raw" | "mode-vim" |
"mode-preview"`. Adding a fifth mode would ripple through `MODE_RING`,
`MODE_ICON` (`status-bar.tsx:29`), the pane-editor render branches, and pane
view-state serialization — that is large. **Phase B avoids a fifth mode** and
renders the email preview as a *variant of the existing preview mode* toggled by
a setting (see Phase B Decisions). This keeps the mode ring at four.

## Commands you will need

| Purpose         | Command                                          | Expected on success            |
|-----------------|--------------------------------------------------|--------------------------------|
| Install         | `bun install`                                    | exit 0                         |
| Typecheck       | `bun run typecheck`                              | exit 0, no errors              |
| Lint/format     | `bun run biome`                                  | exit 0 (no diagnostics)        |
| Tests (all)     | `bun run test`                                   | all pass, incl. new tests      |
| Single test     | `bunx vitest run lib/markdown/frontmatter.test.ts`| named tests pass              |
| Build           | `bun run build`                                  | exit 0                         |
| Convex codegen  | `bun run convex:codegen`                         | regenerates `convex/_generated`|
| Dev (manual)    | `bun run dev`                                     | Next + Convex start            |

Run `bun run convex:codegen` after editing `convex/schema.ts` or adding a Convex
function file, so `convex/_generated/api` + `dataModel` types update before
typecheck.

## Suggested executor toolkit

- shadcn primitives are added via `bunx shadcn add <name>`. Existing primitives
  are in `components/ui/` (run `ls components/ui/` — currently: alert, button,
  card, input, label, skeleton). Compose these; do NOT hand-roll styled `<div>`
  overlays.
- If a `convex` skill is available, consult it before writing the Phase C upload
  mutation/action (signed-upload-URL pattern, `ctx.storage` API). Reference docs:
  `node_modules/bun-types/docs/**.mdx` for Bun APIs; Convex file-storage docs for
  `generateUploadUrl` / `getUrl`.
- The existing round-trip tests in `lib/markdown/frontmatter.test.ts` are the
  structural model for the metadata tests — read them first.

## Scope

**In scope** (the only files you should modify or create):

Phase A:
- `lib/markdown/frontmatter.ts` — add `subject`/`preview` to `DocumentMeta` (modify)
- `lib/markdown/frontmatter.test.ts` — extend round-trip tests (modify)
- `lib/markdown/reading-time.ts` — pure reading-time math (create)
- `lib/markdown/reading-time.test.ts` — Vitest unit tests (create)
- `lib/markdown/index.ts` — export `readingTimeMinutes` (modify)
- `components/workspace/document-header.tsx` — add subject/preview fields (modify)
- `components/status-bar.tsx` — render reading-time beside word count (modify)
- `components/studio-shell.tsx` — pass reading-time prop to `<StatusBar>` (modify)

Phase B:
- `lib/export/email.ts` — email-inline-CSS HTML render + inbox preview render (create)
- `lib/export/email.test.ts` — Vitest unit tests for the email render (create)
- `lib/export/index.ts` — export the new email render fns (modify)
- `components/workspace/email-preview.tsx` — inbox/email preview component (create)
- `lib/editor/preview/index.tsx` — branch to email render when the setting is on (modify)
- `lib/studio/use-studio-settings.ts` — add the `previewVariant` setting toggle (modify)
- `lib/keyboard/actions.ts` — add "Toggle email preview" action (modify)
- `components/studio-shell.tsx` — wire the toggle action (modify)

Phase C:
- `convex/files.ts` — `generateUploadUrl` mutation + `getImageUrl` query (create)
- `lib/editor/image-upload.ts` — client upload helper (create)
- `lib/editor/codemirror/index.tsx` — add paste/drop image handler (modify)
- `components/workspace/pane-editor.tsx` — pass the uploader to the CM editor (modify)

**Out of scope** (do NOT touch, even though they look related):
- `lib/editor/milkdown/index.tsx` — `setMeta`/`getCanonicalMarkdown` already carry
  new `DocumentMeta` fields through `composeFrontmatter` automatically; you do NOT
  need to edit it for Phase A. Milkdown paste-image handling is **deferred** (see
  Maintenance notes) — do not add a ProseMirror paste rule here.
- `lib/export/html.ts` — the `.html`/`.docx`-bound export. Phase B's email render
  is a SEPARATE function in `lib/export/email.ts`; do not change the existing
  export HTML (it would alter `.html` export + rich-text copy).
- `convex/documents.ts` — read for the auth pattern; import `requireUserId` from
  it; do not modify (no new doc columns — subject/preview live in the markdown
  string).
- `convex/schema.ts` — **no schema change in any phase.** Convex file storage uses
  the built-in `_storage` system table; you do not declare it. (If you think you
  need a schema change, that is a STOP condition.)
- `lib/markdown/count-words.ts` — the canonical counter; reading-time derives from
  its `wordCount` output, not a new counter. Do not change it.
- `app/globals.css` — existing OKLCH tokens suffice for app chrome. Do not add
  tokens. (The email render's inline light colors are NOT app tokens — they are
  literal hex in the generated email HTML, matching the existing `EXPORT_STYLE`
  convention in `lib/export/html.ts`.)

## Git workflow

- Branch: `advisor/008-newsletter-authoring-layer`
- Commit per phase, or per logical unit within a phase (frontmatter+tests;
  reading-time; header UI; status bar; email render; image upload). Conventional
  commits, NO AI attribution, author = the repo user. Example from `git log`:
  `feat: add switchable calm color themes`.
- Do NOT push or open a PR unless the operator instructs it.

---

## PHASE A — Subject + preview metadata, and reading-time (LOW risk, ships alone)

### Step A1: Add `subject` and `preview` to `DocumentMeta`

In `lib/markdown/frontmatter.ts`:

1. Extend the type (lines 9–12):
   ```ts
   export type DocumentMeta = {
   	title: string;
   	subtitle: string;
   	subject: string; // newsletter subject line (email "Subject:")
   	preview: string; // newsletter preview / preheader text (inbox snippet)
   };
   ```
2. Update `EMPTY_META` (line 22): `{ title: "", subtitle: "", subject: "", preview: "" }`.
3. In `splitFrontmatter` (lines 56–60), destructure the new keys and coerce:
   ```ts
   const { title, subtitle, subject, preview, ...extra } = parsed;
   const meta: DocumentMeta = {
   	title: toStringField(title),
   	subtitle: toStringField(subtitle),
   	subject: toStringField(subject),
   	preview: toStringField(preview),
   };
   ```
4. In `composeFrontmatter` (lines 78–83), emit them after title/subtitle and skip
   them in the `extra` fold so they never duplicate:
   ```ts
   if (meta.title.trim()) ordered.title = meta.title;
   if (meta.subtitle.trim()) ordered.subtitle = meta.subtitle;
   if (meta.subject.trim()) ordered.subject = meta.subject;
   if (meta.preview.trim()) ordered.preview = meta.preview;
   for (const [key, value] of Object.entries(extra)) {
   	if (!["title", "subtitle", "subject", "preview"].includes(key)) ordered[key] = value;
   }
   ```

This is exactly the title/subtitle pattern, doubled. The empty-block behavior
(no `---` when all empty) is preserved because the new fields are only added to
`ordered` when non-empty.

**Verify**: `bun run typecheck` will FAIL until you also fix the literal
`EMPTY_META`/`{ title, subtitle }` object literals elsewhere — that is Step A2.
Run `grep -rn "title: \"\", subtitle: \"\"\|{ title, subtitle }\|title: string;\s*subtitle: string" --include="*.tsx" --include="*.ts" . | grep -v node_modules | grep -v _generated` to find them now.

### Step A2: Fix all `DocumentMeta` construction sites

Adding two required fields breaks every object literal that builds a
`DocumentMeta`. Find them:

```
grep -rn "subtitle:" --include="*.tsx" --include="*.ts" . | grep -v node_modules | grep -v _generated
```

Known sites to update (confirm against grep — there may be more after drift):
- `components/workspace/pane-editor.tsx:69-72` — `useState<DocumentMeta>({ title: "", subtitle: "" })` → add `subject: "", preview: ""`.
- `lib/editor/preview/index.tsx` — uses `meta.title`/`meta.subtitle` from
  `splitFrontmatter` (no literal to fix), but you will extend it in Phase B.
- Any test fixtures building `DocumentMeta` inline (e.g. `frontmatter.test.ts`).

**Prefer using `EMPTY_META` (spread) over re-typing the literal** where the file
already imports it, so future field additions don't break again:
`useState<DocumentMeta>({ ...EMPTY_META })`. (`EMPTY_META` is exported from the
markdown barrel, `lib/markdown/index.ts:6`.)

**Verify**: `bun run typecheck` → exit 0 (no errors about missing `subject`/`preview`).

### Step A3: Extend the frontmatter round-trip tests

In `lib/markdown/frontmatter.test.ts`, model new cases on the existing
"round-trips values" and "preserves unknown keys" tests (lines 34–66). Add:

- **subject/preview round-trip**: compose a meta with non-empty `subject` +
  `preview`, split it back, assert `round.meta.subject` and `round.meta.preview`
  equal the originals (and that the YAML block contains `subject:` and `preview:`).
- **subject/preview survive alongside `extra`**: a raw markdown string with
  `title`, `subject`, `preview`, AND an unknown key (e.g. `tags`) →
  `splitFrontmatter` → `composeFrontmatter(meta, body, extra)` → re-split; assert
  subject/preview are typed strings on `meta` and the unknown key survives in
  `extra` (do NOT assert the unknown key migrated into meta).
- **idempotence with the new fields**: `compose∘split∘compose == compose` (mirror
  the test at lines 60–66) with subject/preview populated.
- **empty subject/preview emit no keys**: composing a meta with empty
  subject/preview + empty title/subtitle + no extra emits NO `---` block (mirror
  the test at lines 28–32).
- **update the existing `EMPTY_META` equality test** (lines 21–26): it asserts
  `meta` equals `{ title: "", subtitle: "" }` — update to include
  `subject: "", preview: ""`.

**Verify**: `bunx vitest run lib/markdown/frontmatter.test.ts` → all pass,
including the new subject/preview cases.

### Step A4: Add reading-time math (pure module)

Create `lib/markdown/reading-time.ts`. Reading-time is derived from the *word
count Recto already computes* (`countWords` in `count-words.ts`) — do NOT add a
second counter.

```ts
/** Average adult reading speed for prose (words per minute). Industry default. */
export const WORDS_PER_MINUTE = 200;

/**
 * Reading time in whole minutes for a given word count, rounded up, min 1 when
 * there is any text (so a 30-word note reads "1 min", not "0 min"). 0 words → 0.
 */
export function readingTimeMinutes(wordCount: number, wpm = WORDS_PER_MINUTE): number {
	if (wordCount <= 0 || wpm <= 0) return 0;
	return Math.max(1, Math.ceil(wordCount / wpm));
}

/** Compact label, e.g. "0 min" | "1 min" | "12 min". */
export function formatReadingTime(minutes: number): string {
	return `${minutes} min`;
}
```

Justification for 200 wpm and `Math.ceil`: 200 wpm is the standard prose estimate
Medium/Substack use; ceiling-with-floor-of-1 matches what readers expect (never
"0 min" for real text, never a misleading "0.4 min"). No date/time library
needed — pure arithmetic.

Export from the barrel `lib/markdown/index.ts`:
```ts
export { formatReadingTime, readingTimeMinutes, WORDS_PER_MINUTE } from "./reading-time";
```

**Verify**: `bun run typecheck` → exit 0; `grep -q readingTimeMinutes lib/markdown/index.ts`.

### Step A5: Unit-test reading-time

Create `lib/markdown/reading-time.test.ts`, modeled on the Vitest style in
`frontmatter.test.ts` (`import { describe, expect, it } from "vitest"`). Cover:
- 0 words → 0; negative → 0.
- 1 word → 1 (floor of 1).
- 199 words → 1; 200 → 1; 201 → 2 (ceiling boundary).
- 1000 words → 5.
- custom wpm (e.g. 250) respected; wpm ≤ 0 → 0.
- `formatReadingTime(12)` → `"12 min"`.

**Verify**: `bunx vitest run lib/markdown/reading-time.test.ts` → all pass.

### Step A6: Render subject + preview fields in the document header

In `components/workspace/document-header.tsx`, add two more `AutoField`s inside
the `[data-doc-header]` `<div>` (it MUST stay inside that subtree — see Current
state). Place them logically (recommendation: subject and preview at the TOP, as
a compact metadata cluster above the title, OR below the subtitle and above the
`<hr>` — choose below-subtitle so the H1 stays the visual anchor). Each follows
the existing `AutoField` wiring:

```tsx
<AutoField
	value={meta.subject}
	onChange={(subject) => onChange({ ...meta, subject })}
	onEnter={onEnterBody}
	placeholder="Subject line (for email)"
	ariaLabel="Newsletter subject line"
	className="recto-doc-meta-field"
/>
<AutoField
	value={meta.preview}
	onChange={(preview) => onChange({ ...meta, preview })}
	onEnter={onEnterBody}
	placeholder="Preview text (inbox preheader)"
	ariaLabel="Newsletter preview text"
	className="recto-doc-meta-field"
/>
```

For `recto-doc-meta-field` styling: keep it QUIET (smaller, tertiary ink) so it
reads as metadata, not body. Use Tailwind utility classes with existing OKLCH
tokens inline (e.g. `text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]`)
rather than inventing a new CSS class in `globals.css` — OR add a single
`.recto-doc-meta-field` rule next to `.recto-doc-subtitle` IF `globals.css`
already defines `.recto-doc-subtitle` there (check first: `grep -n "recto-doc-subtitle" app/globals.css`).
If you add a class, that makes `app/globals.css` in-scope for this step ONLY for a
single sibling rule mirroring `.recto-doc-subtitle` — note it in your report.
**Do not add new OKLCH tokens.**

Because `handleMetaChange` in `pane-editor.tsx:74-77` already calls
`richRef.current?.setMeta(meta)` with the full `DocumentMeta`, and Milkdown's
`setMeta` recomposes through `composeFrontmatter`, **the new fields persist with
no further wiring** — typing in them updates the canonical markdown and triggers
the existing autosave.

**Verify**: `bun run typecheck && bun run biome` → exit 0. Manual: `bun run dev`,
open a doc in rich mode, type a subject + preview, switch to **raw** mode → the
YAML frontmatter shows `subject:` and `preview:` keys with your text.

### Step A7: Show reading-time beside the word count in the status bar

In `components/status-bar.tsx`:
1. Add `readingMinutes: number` to `StatusBarProps` (after `wordCount`, line 37).
2. Import `formatReadingTime` from `@/lib/markdown`.
3. Render it next to the word count (after the word-count span at lines 282–284),
   inside the same fold-away pattern. Match the existing density: a `·` separator
   (mirror the `aria-hidden` dot at lines 285–290) then a `tabular-nums`,
   `text-[var(--color-ink-tertiary)]` span: `{formatReadingTime(readingMinutes)}`.
   Wrap in the same `min-[360px]:inline-block` / `sm:` visibility class as the
   word count so it folds away on phones. `title`/`aria-label`: "Estimated reading
   time".

In `components/studio-shell.tsx`, at the `<StatusBar>` call (lines 590–630),
compute and pass `readingMinutes`:
```ts
readingMinutes={readingTimeMinutes(activeSync.wordCount)}
```
(Import `readingTimeMinutes` from `@/lib/markdown`. `activeSync.wordCount` is the
same number feeding `wordCount`, so the reading-time always agrees with the
displayed word count.)

**Verify**: `bun run typecheck && bun run biome && bun run build` → exit 0.
Manual: `bun run dev` → status bar shows e.g. "1,000 words · 5 min".

### Phase A done criteria (machine-checkable)

- [ ] `bun run typecheck` exits 0
- [ ] `bun run biome` exits 0
- [ ] `bunx vitest run lib/markdown/frontmatter.test.ts lib/markdown/reading-time.test.ts` → all pass
- [ ] `bun run test` exits 0
- [ ] `bun run build` exits 0
- [ ] `grep -q "subject: string" lib/markdown/frontmatter.ts` and `grep -q "preview: string" lib/markdown/frontmatter.ts`
- [ ] `grep -q readingTimeMinutes lib/markdown/index.ts`
- [ ] `git diff --quiet a25c506 -- lib/markdown/count-words.ts` (counter untouched)

---

## PHASE B — Inbox / email preview (LOW risk, depends on Phase A)

### Phase B Decisions (resolve the A/B fork first)

**Fork: a 5th preview mode vs a separate panel.** The feature brief flags this.
Adding a fifth `Mode` ripples through `MODE_RING`, `MODE_ICON`, pane render
branches, and view-state serialization (see Current state — large, MED-risk).
Per the user's standing "build a toggle, don't hard-pick" preference, resolve it
as a **per-device setting** that switches what the existing **preview mode**
renders:

- `previewVariant: "rendered" | "email"` setting (default `"rendered"`).
- When `"rendered"`: preview mode shows today's `PreviewPane` (unchanged).
- When `"email"`: preview mode shows the new `EmailPreview` (inbox chrome +
  email-inline-CSS body).

This keeps the mode ring at four, makes the email preview reachable with one
toggle, and is a genuine switchable setting (not a hard pick). Document this
choice in your report.

### Step B1: Add the `previewVariant` setting

In `lib/studio/use-studio-settings.ts`, follow the EXACT pattern the existing
settings use (read the file first — `theme`, `readingFont`, `spellcheck` are the
models): add a typed field `previewVariant: "rendered" | "email"`, a default of
`"rendered"`, a defensive load branch (fall back to `"rendered"` on bad value),
and a setter `setPreviewVariant` / toggle `togglePreviewVariant` returned from
the hook. Storage key is unchanged (`"recto:studio-settings"`).

**Verify**: `bun run typecheck` → exit 0; `grep -q previewVariant lib/studio/use-studio-settings.ts`.

### Step B2: Build the email-inline-CSS render

Create `lib/export/email.ts`. The body render reuses the EXPORT pipeline shape
from `lib/export/html.ts` (parse → gfm → strip frontmatter → remark-rehype →
absolutize URLs → stringify) — copy the `buildProcessor`/`absolutizeUrls`
approach, but **inline the CSS onto elements** because email clients strip
`<style>` blocks and external CSS. Two reasonable implementations — pick one and
justify:

1. **Hand-write inline styles** via a small rehype transform that sets
   `style` properties on each element (matching the `EXPORT_STYLE` rules in
   `html.ts:64-88`, expressed as per-element inline strings). Lightweight, no new
   dependency, full control. **Recommended for the first cut** — the rule set is
   small and the existing `EXPORT_STYLE` is the spec to inline.
2. A library like `juice` (CSS-inliner) — battle-tested but adds a dependency and
   is heavier than needed for this small, fixed rule set. Only choose this if
   hand-inlining proves unwieldy; if you add it, `bun add juice` and note it.

Export two functions:
```ts
/** Email-safe HTML body (inline styles, absolute URLs) from canonical markdown. */
export function generateEmailHtml(markdown: string): string;

/**
 * Inbox-preview model: what an inbox row + opened email would show.
 * Falls back sensibly: subject → title → "Untitled"; preview → first prose
 * snippet of the body when empty.
 */
export function emailInboxModel(markdown: string, fallbackTitle: string): {
	subject: string;   // meta.subject || meta.title || fallbackTitle
	preview: string;   // meta.preview || derived first-line snippet
	bodyHtml: string;  // generateEmailHtml(markdown)
};
```

`emailInboxModel` uses `splitFrontmatter` to read `meta.subject`/`meta.preview`
(now typed, from Phase A). The preview fallback (when `meta.preview` is empty):
take the first ~140 chars of the body's plain text — you may reuse
`countWordsFromPlainText`'s text-extraction approach or a simple
`splitFrontmatter(markdown).body` slice with markdown markers stripped; keep it
simple, it is only a snippet.

**Sender is NOT real.** This is a *preview*, not a send. Use a static, obviously
placeholder sender label like "You" or the document title — do NOT add an email
address field, a "from" config, or anything that implies sending. (If you find
yourself adding a recipient or from-address input, STOP — that crosses the §8
boundary.)

**Verify**: `bun run typecheck` → exit 0.

### Step B3: Unit-test the email render

Create `lib/export/email.test.ts` (Vitest). Cover:
- `generateemailHtml` output contains inline `style=` attributes and NO `<style>`
  block; renders a heading/paragraph/list from a small markdown fixture; strips
  the YAML frontmatter (no `subject:` text leaks into the body).
- `emailInboxModel`: subject falls back title→fallback when empty; preview falls
  back to a body snippet when `meta.preview` empty; uses `meta.subject`/`meta.preview`
  verbatim when present.
- absolute-URL handling: a root-relative image src is absolutized (mirror what
  `lib/export/html.ts`'s `absolutizeUrls` does).

**Verify**: `bunx vitest run lib/export/email.test.ts` → all pass.

### Step B4: Build the EmailPreview component + wire it into preview mode

Create `components/workspace/email-preview.tsx`: a React component taking
`markdown` + `fallbackTitle` (+ `className`), calling `emailInboxModel`, and
rendering inbox chrome — a header row showing the placeholder sender, the
**subject** (bold), and the **preview text** (muted snippet), then the email body
via `dangerouslySetInnerHTML` from `bodyHtml`.

> **Sanitization note**: `generateEmailHtml` (like `generateExportHtml`) is built
> from the user's own single-user canonical document with `allowDangerousHtml:
> false` and only dialect constructs — the same trust model the export pipeline
> relies on (`docs/blueprint/11-clipboard-export.md` §6, line 272). Add a
> `biome-ignore lint/security/noDangerouslySetInnerHtml` comment citing this, as
> `lib/editor/preview/index.tsx:33` does.

The inbox chrome (sender/subject/preview row) is APP chrome → it must use dark
OKLCH tokens (`var(--color-bg-raised)`, `var(--color-ink-*)`, `var(--color-line)`).
The email BODY inside is the light, inline-styled render (that is the point — it
shows how the email looks in a client). Visually frame the light body as a
"window" inside the dark inbox shell.

In `lib/editor/preview/index.tsx`, branch on the setting: read
`previewVariant` from `useStudioSettingsContext()` (the context hook used in
`pane-editor.tsx:24,60`). When `"email"`, render `<EmailPreview markdown={markdown}
… />`; otherwise the existing `PreviewPane` body. (Simplest: keep `PreviewPane`'s
signature, add the branch inside it; OR have the caller in `pane-editor.tsx:488`
choose the component. Inside-`PreviewPane` is fewer touch-points.) `PreviewPane`
must take or read `fallbackTitle`/`previewVariant` — if it needs the active title,
the pane already has `title` (pane-editor.tsx:91); pass it through.

**Verify**: `bun run typecheck && bun run biome && bun run build` → exit 0.
Manual: `bun run dev`, toggle the setting to "email", switch a pane to preview →
inbox chrome with subject/preview + a light email render of the body.

### Step B5: Add a command-palette toggle for the email preview

In `lib/keyboard/actions.ts`: add `"toggle-email-preview"` to the `ActionId`
union (lines 17–50) and an `ActionDef` in the `ACTIONS` array, modeled on an
existing `"View"`-section toggle (e.g. `toggle-font`, lines 219–225): `{ id:
"toggle-email-preview", label: "Toggle email/inbox preview", section: "View",
aliases: ["email", "newsletter", "inbox", "preheader"], shortcut: { mac: "",
other: "" } }`.

In `components/studio-shell.tsx` `dispatch` switch (lines 249+): add
`case "toggle-email-preview": settings.togglePreviewVariant(); return;` (match
how existing settings toggles are dispatched in that switch).

**Verify**: `bun run typecheck` → exit 0; `grep -q toggle-email-preview lib/keyboard/actions.ts components/studio-shell.tsx`. Manual: ⌘K → "Toggle email preview" appears and flips the preview render.

### Phase B done criteria (machine-checkable)

- [ ] `bun run typecheck && bun run biome && bun run build` exit 0
- [ ] `bunx vitest run lib/export/email.test.ts` → all pass
- [ ] `bun run test` exits 0
- [ ] `grep -q "generateEmailHtml\|emailInboxModel" lib/export/email.ts` and both re-exported from `lib/export/index.ts`
- [ ] `grep -q previewVariant lib/studio/use-studio-settings.ts`
- [ ] `git diff --quiet a25c506 -- lib/export/html.ts` (existing export HTML untouched)
- [ ] `MODE_RING` in `lib/modes/types.ts` still has exactly 4 modes (`grep -c '"' lib/modes/types.ts` sanity; no `"email"` mode added)

---

## PHASE C — Image paste/drop → Convex file storage (MED risk, backend; depends on nothing in A/B)

> **Pre-flight (do this BEFORE writing any Phase C code).** Convex file storage
> is currently UNUSED. Confirm it is available in this deployment:
> 1. `bun run convex:codegen` then check the generated server types expose
>    storage: `grep -rn "generateUploadUrl\|storage" convex/_generated/server.d.ts`
>    — Convex's `MutationCtx`/`ActionCtx` include `ctx.storage` by default; if the
>    types do not, STOP and report (storage may be disabled for this project).
> 2. There is NO `convex.json` change and NO `schema.ts` change needed — file
>    storage uses the built-in `_storage` system table. If you conclude you need a
>    schema change, STOP.

### Step C1: Add Convex upload + URL functions

Create `convex/files.ts`. Import the auth helper from `./documents`
(`requireUserId` is exported there, `documents.ts:12`) — do NOT redefine it.

```ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./documents";

/** Signed, short-lived URL the client POSTs the image bytes to. Auth-gated. */
export const generateUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		await requireUserId(ctx); // single-user; only the owner may upload
		return await ctx.storage.generateUploadUrl();
	},
});

/** Resolve a stored file id to a servable URL (null if missing). Auth-gated. */
export const getImageUrl = query({
	args: { storageId: v.id("_storage") },
	handler: async (ctx, args) => {
		await requireUserId(ctx);
		return await ctx.storage.getUrl(args.storageId);
	},
});
```

Notes:
- `generateUploadUrl()` returns a one-time upload URL. The client POSTs the blob
  to it and receives `{ storageId }` back. This is the documented signed-upload
  pattern — do NOT stream bytes through a Convex mutation (mutations have the
  ~1 MiB arg ceiling; that is the whole reason images use storage, per §8 line 192).
- `_storage` is the built-in system table id type — `v.id("_storage")` is valid
  without a schema declaration.

Run `bun run convex:codegen`.

**Verify**: `bun run convex:codegen && bun run typecheck` → exit 0;
`grep -q "generateUploadUrl\|getImageUrl" convex/files.ts`; the generated
`convex/_generated/api` references `files`.

### Step C2: Client upload helper

Create `lib/editor/image-upload.ts`: a function that, given a `File`/`Blob` and a
way to call the Convex mutation + query, uploads and returns a public URL.

```ts
// Pseudocode shape — adapt to how the codebase calls Convex from non-component
// code. Components use useMutation/useQuery (convex/react). This helper is
// invoked from an editor event handler, so pass it the bound mutation + a URL
// resolver from the component (see Step C3 / C4).
export async function uploadImage(args: {
	file: File | Blob;
	generateUploadUrl: () => Promise<string>;
	resolveUrl: (storageId: string) => Promise<string | null>;
}): Promise<{ url: string; alt: string }> {
	const postUrl = await args.generateUploadUrl();
	const res = await fetch(postUrl, {
		method: "POST",
		headers: { "Content-Type": args.file.type || "application/octet-stream" },
		body: args.file,
	});
	if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
	const { storageId } = (await res.json()) as { storageId: string };
	const url = await args.resolveUrl(storageId);
	if (!url) throw new Error("Could not resolve uploaded image URL");
	const alt = args.file instanceof File ? args.file.name.replace(/\.[^.]+$/, "") : "image";
	return { url, alt };
}
```

Guard: only handle image MIME types (`file.type.startsWith("image/")`); ignore
non-images so normal text paste is unaffected. On failure, surface a toast (the
codebase has `toast` in `lib/ui/toast` — see `lib/export/clipboard.ts:1`) and
fall through to default paste behavior.

**Verify**: `bun run typecheck` → exit 0.

### Step C3: Wire the upload into the CodeMirror paste/drop handler

In `lib/editor/codemirror/index.tsx`, add a new prop to `CodeMirrorEditorProps`
(lines 26–34): `onUploadImage?: (file: File | Blob) => Promise<{ url: string; alt: string }>`.
Keep a ref to it (mirror `onChangeRef` at line 218). Add an `EditorView.domEventHandlers`
extension to the `extensions` array (lines 254–264):

```ts
EditorView.domEventHandlers({
	paste(event, view) {
		const items = event.clipboardData?.items;
		const file = items && [...items].find((i) => i.type.startsWith("image/"))?.getAsFile();
		if (!file || !onUploadImageRef.current) return false; // let default paste run
		event.preventDefault();
		const pos = view.state.selection.main.head;
		// Insert a placeholder, then replace it with the real ref once uploaded.
		void onUploadImageRef.current(file).then(({ url, alt }) => {
			const v = viewRef.current;
			if (!v) return;
			v.dispatch({ changes: { from: pos, insert: `![${alt}](${url})` } });
		});
		return true;
	},
	drop(event, view) {
		const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
		if (!file || !onUploadImageRef.current) return false;
		event.preventDefault();
		const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
		void onUploadImageRef.current(file).then(({ url, alt }) => {
			const v = viewRef.current;
			if (!v) return;
			v.dispatch({ changes: { from: pos, insert: `![${alt}](${url})` } });
		});
		return true;
	},
})
```

Returning `false` from the handler lets CM6's default paste/drop run (so text
paste is untouched). The inserted `![alt](url)` is a standard CommonMark image —
it round-trips losslessly (D7) and renders in rich/preview/email. Consider a
brief inserted placeholder like `![uploading…]()` replaced on resolve for UX, but
the simple version above is acceptable for a first cut.

**Verify**: `bun run typecheck && bun run biome` → exit 0.

### Step C4: Provide the uploader from the pane

In `components/workspace/pane-editor.tsx`, build the uploader using Convex
component hooks and pass it to `<CodeMirrorEditor … onUploadImage={…} />` (the CM
editor is rendered at lines 474–482):

```ts
const generateUploadUrl = useMutation(api.files.generateUploadUrl);
const convex = useConvex(); // from "convex/react" — to call the getImageUrl query imperatively
const handleUploadImage = useCallback(
	(file: File | Blob) =>
		uploadImage({
			file,
			generateUploadUrl,
			resolveUrl: (storageId) =>
				convex.query(api.files.getImageUrl, { storageId: storageId as Id<"_storage"> }),
		}),
	[generateUploadUrl, convex],
);
```

(`useMutation`/`useConvex` come from `convex/react`; `useQuery` is already
imported in `pane-editor.tsx:3`. Use `useConvex().query(...)` for the one-shot URL
resolve rather than a reactive `useQuery`, since the resolve happens inside an
event handler. Import `Id` from `@/convex/_generated/dataModel`.)

**Verify**: `bun run typecheck && bun run biome && bun run build` → exit 0.
Manual: `bun run dev`, in raw mode paste a copied image (or drag a PNG in) → after
a moment a `![name](https://…convex…)` reference is inserted; switch to preview →
the image renders.

### Phase C done criteria (machine-checkable)

- [ ] `bun run convex:codegen && bun run typecheck` exit 0
- [ ] `bun run biome && bun run build` exit 0
- [ ] `bun run test` exits 0
- [ ] `grep -q "generateUploadUrl" convex/files.ts` and `grep -q "getImageUrl" convex/files.ts`
- [ ] `grep -q "ctx.storage" convex/files.ts` (uses built-in storage, not a custom table)
- [ ] `git diff --quiet a25c506 -- convex/schema.ts` (NO schema change)
- [ ] `git diff --quiet a25c506 -- lib/export/html.ts convex/documents.ts` (untouched)

---

## Test plan (all phases)

- **Phase A** — `lib/markdown/frontmatter.test.ts` (extend; model on existing
  round-trip/idempotence/empty-block tests, lines 11–87): subject/preview
  round-trip, coexist with `extra`, idempotence, empty-emits-no-block, updated
  `EMPTY_META` equality. `lib/markdown/reading-time.test.ts` (create; model on
  the Vitest style in `frontmatter.test.ts`): boundaries (199/200/201), floor-of-1,
  zero/negative, custom wpm, label formatting.
- **Phase B** — `lib/export/email.test.ts` (create): inline-styles present /
  `<style>` absent / frontmatter stripped; `emailInboxModel` fallbacks;
  URL absolutization.
- **Phase C** — the Convex functions are simple wrappers around built-in
  `ctx.storage`; a `convex-test` integration test would require wiring into the
  `package.json` test script (the existing Convex test runs under `bun test` from
  `spikes/`, per `package.json:12`) — that is an out-of-scope `package.json` edit.
  **Cover Phase C by the manual `bun run dev` paste/drop check** (Step C4) plus
  the typecheck/build gates. Do NOT rewire `package.json`.
- Verification for all: `bun run test` → full suite passes including new Vitest
  files; `bun run typecheck && bun run biome && bun run build` → exit 0.

## Done criteria (whole plan — ALL must hold for a full landing)

- [ ] All three phases' done-criteria checklists pass (above)
- [ ] `bun run typecheck` exits 0
- [ ] `bun run biome` exits 0
- [ ] `bun run test` exits 0; new tests for frontmatter subject/preview,
      reading-time, and email render exist and pass
- [ ] `bun run build` exits 0
- [ ] No "send"/"publish"/"schedule"/SMTP/ESP/recipient code anywhere:
      `grep -rniE "smtp|sendgrid|mailgun|nodemailer|publish|\\bsend email\\b|recipient" lib/ components/ convex/ | grep -v node_modules | grep -v _generated` returns nothing new from this plan
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `convex/schema.ts` unchanged (`git diff --quiet a25c506 -- convex/schema.ts`)
- [ ] `plans/README.md` status row updated (create the file if absent — template below)

## STOP conditions

Stop and report back (do not improvise) if:

- **Scope creep toward sending.** Any step seems to require an email address /
  "from" / recipient field, an SMTP/ESP integration, a "send" or "schedule" or
  "publish" button, or a webhook to a mail provider. That crosses the §8 / §5e
  product boundary — STOP and report. (The email preview's sender is a static
  placeholder; there is no real address anywhere.)
- **Frontmatter `extra` does not round-trip strings.** If, after Step A1–A3, a
  `subject`/`preview` value comes back as a non-string (e.g. a `Date`, a number,
  a boolean) after `splitFrontmatter→composeFrontmatter→splitFrontmatter`, js-yaml
  type resolution differs from the assumption — STOP (the typed `toStringField`
  coercion should prevent this; if it doesn't, the YAML handling drifted).
- **`DocumentMeta` shape drifted.** If `lib/markdown/frontmatter.ts` no longer
  matches the excerpt (e.g. `subject`/`preview` already exist, or `DocumentMeta`
  has different fields) — the feature may be partly built; reconcile before adding.
- **Convex file storage unavailable.** If, in the Phase C pre-flight,
  `ctx.storage`/`generateUploadUrl` is missing from the generated server types,
  OR a `convex.json`/`schema.ts` change appears required to use storage — STOP
  (storage may be disabled for this deployment; do not invent a workaround).
- **`requireUserId` no longer exported** from `convex/documents.ts:12` — find the
  current auth shape before writing `convex/files.ts`.
- **Milkdown plumbing drifted.** If `lib/editor/milkdown/index.tsx`'s `setMeta`
  no longer recomposes via `composeFrontmatter(metaRef.current, body,
  extraRef.current)`, the assumption that new `DocumentMeta` fields flow
  automatically is false — STOP and reassess Phase A wiring.
- **Adding a field requires editing `convex/schema.ts` or `convex/documents.ts`**
  for subject/preview — it should NOT (they live in the markdown string). If you
  think it does, STOP — you have likely strayed from the frontmatter approach.
- Any step's verification fails twice after a reasonable fix attempt.
- The `<StatusBar … />` call site (studio-shell.tsx ~590) no longer sources
  `wordCount` from `activeSync` — your `readingMinutes` prop may not land right.

## Maintenance notes

For the human/agent who owns this after it lands:

- **Decisions made & why**:
  - *Subject/preview are typed `DocumentMeta` fields stored in YAML frontmatter*,
    not a new `documents` column — keeps "the Markdown string is the source of
    truth at rest" (overview §3, line 52) intact, round-trips losslessly through
    the existing `extra`-preserving pipeline, and is symmetric with title/subtitle.
    A DB column would split the source of truth and break export/copy parity.
  - *Email preview is a SETTING-driven variant of preview mode*, not a 5th lens —
    avoids rippling a new `Mode` through `MODE_RING`/`MODE_ICON`/pane render/
    view-state serialization, and satisfies the user's "build a toggle, don't
    hard-pick" preference for the 5th-lens-vs-panel fork.
  - *Images upload to Convex file storage (signed upload URL)*, not base64-inlined
    — the ~1 MiB doc ceiling (overview §8, line 192) governs the Markdown string;
    inlining images would blow it. Blobs live in the separate `_storage` system
    table, so no schema change is needed.
  - *Reading-time at 200 wpm, ceiling, floor of 1* — the Medium/Substack standard;
    derived from the same `countWords` number as the status bar so they never
    disagree.
- **What a reviewer should scrutinize**: that no send/publish path crept in (the
  hard product boundary); that subject/preview round-trip byte-stably (the
  losslessness contract, overview §6 line 153 / §7 line 172); that the email
  render emits INLINE styles (email clients strip `<style>`); that the image
  paste handler returns `false` for non-image paste so text paste is untouched;
  that `convex/files.ts` is auth-gated (`requireUserId`) on both functions.
- **Future interactions / deferred**:
  - *Milkdown (rich-mode) image paste is deferred* — Phase C handles only the
    CodeMirror surface (raw/vim). A ProseMirror paste rule for rich mode is a
    follow-up; until then, pasting an image in rich mode falls back to default
    behavior. Inserting `![alt](url)` text in rich mode still works (Milkdown
    renders it).
  - *Image cleanup / orphan GC*: uploaded blobs are never deleted when their
    `![](url)` reference is removed from the doc. A future GC (scan docs for live
    storage URLs, delete unreferenced `_storage` rows) is out of scope here.
  - *Per-ESP "Copy for Substack/Ghost" presets*: the brief asked whether these
    are meaningfully different from existing copy. **They are NOT** — Substack and
    Ghost both accept pasted rich HTML (existing *Copy as rich text*,
    `lib/export/clipboard.ts`) or Markdown (*Copy as Markdown*). The new email
    render is a *preview*, not a paste target. So no new copy presets are added;
    the existing two copy actions suffice. (Recorded here so nobody re-litigates
    it — see "Findings considered and rejected" in `plans/README.md`.)

---

## If `plans/README.md` does not exist, create it from this template

```markdown
# Implementation Plans

Execute in the order below unless dependencies say otherwise. Each executor: read
the plan fully before starting, honor its STOP conditions, and update your row
when done.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | Word-level version diff | — | — | — | TODO |
| 002  | Writing goals & streaks | P2 | L | — | TODO |
| 008  | Newsletter authoring layer | P2 | L | — | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (reason) | REJECTED (rationale)

## Findings considered and rejected

- Per-ESP "Copy for Substack/Ghost" copy presets (plan 008): not worth doing —
  Substack/Ghost accept the existing *Copy as rich text* (HTML) and *Copy as
  Markdown* outputs; a dedicated preset would duplicate them.
```

(Populate the 001/002 rows from those plan files' Status sections if the table
values differ from the placeholders above.)
