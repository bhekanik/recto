# 11 — Clipboard & Export

> **Scope.** This file specifies how Recto gets writing *out* of the studio: copy-to-clipboard (rich and Markdown) and file export (`.md` and `.html`). These actions are available across the whole app, in every pane and every mode. This file is self-contained; where it depends on canon it cites the source by exact filename.
>
> **Canon anchors.** Recto has a single canonical document model — a **remark MDAST**, held in memory while editing and persisted to Convex as a Markdown string (decisions **D1**, **D2** in [`README.md`](./README.md)). Every clipboard and export action in this file derives its output from that canonical model. Nothing here introduces a second source of truth, and nothing here performs a format-to-format conversion between two competing live representations (which **D2** forbids). The supported Markdown dialect — CommonMark + GFM + footnotes + YAML frontmatter (**D7**) — is the exact set of constructs these exporters must render; see [`06-markdown-dialect.md`](./06-markdown-dialect.md).

---

## 1. Clipboard on the whole app

Copy and export are **global document actions**, not mode-local features. They behave identically whether the active pane is in rich text, raw Markdown, Vim, or preview mode. This is a direct consequence of **D2**: a mode is a *view* of the canonical model, so "what gets exported" is a property of the document, not of the lens you happen to be looking through.

### 1.1 The source of truth for what gets copied

There is exactly one answer, and it is the same for all four actions:

> **Every copy and export action serializes from the active document's canonical MDAST** (or its serialized Markdown string — the two are equivalent by **D1**), **never from the rendered DOM of whatever editor is on screen, and never from the current text selection.**

Concretely:

- **Markdown source** (for *Copy as Markdown*, *Export as `.md`*) comes from `remark-stringify` over the canonical MDAST — i.e. the same serialization the document persists with (**D1**, [`06-markdown-dialect.md`](./06-markdown-dialect.md)). This is byte-identical to what the raw/Vim editors show, because those editors edit that serialized string directly.
- **HTML** (for *Copy as rich text*, *Export as `.html`*) comes from `remark-rehype` → `rehype-stringify` over the same canonical MDAST. This is the *export* HTML pipeline. It is intentionally **not** the same as the on-screen preview pipeline, which adds `rehype-sanitize` for safe in-app display (**D5**); export HTML is generated for *foreign* consumers (Word, Docs, Pages) and carries presentation, so it skips the sanitizer's display-only stripping while still emitting only dialect-expressible constructs. See §6.

We never read `editorView.dom.innerHTML` or the ProseMirror/CodeMirror selection. Two reasons:

1. **Correctness.** The on-screen DOM of Milkdown or a preview pane carries editor chrome, decoration spans, `contenteditable` artifacts, and class names that have no place in exported output. Serializing from the canonical tree gives clean, deterministic output.
2. **Mode-independence.** A "copy" issued from preview mode and a "copy" issued from rich-text mode must produce identical bytes. They do, because both read the same MDAST.

```ts
/**
 * The single accessor every clipboard/export action funnels through.
 * `doc` is the active document; `mdast` is its in-memory canonical tree.
 * If only the persisted markdown string is on hand, parse it back to MDAST
 * with the same unified pipeline used everywhere else (06-markdown-dialect.md).
 */
import type { Root } from "mdast";

export interface ExportSource {
  title: string; // documents.title — used for the download filename
  markdown: string; // remark-stringify(mdast); identical to documents.markdown
  mdast: Root; // the canonical tree (D1)
}

export function exportSourceFor(doc: ActiveDocument): ExportSource {
  return {
    title: doc.title,
    markdown: doc.serializeCanonicalMarkdown(), // remark-stringify, dialect rules per 06
    mdast: doc.canonicalMdast(),
  };
}
```

> **Selection is out of scope for v1.** Copy/export always operate on the *whole document*. "Copy current selection as rich text" would require resolving a selection across whichever engine owns the pane and projecting it back onto the MDAST — a real feature, but deferred. v1 copies the document. (If you have text selected in an editor, the OS-native `Cmd/Ctrl+C` still does the ordinary selection copy through the editor; Recto's actions described here are the explicit document-level commands.)

### 1.2 The four actions

| Action | Output | Clipboard / file format | API surface | Use it for |
|---|---|---|---|---|
| **Copy as rich text** | HTML + plain text, one item | `text/html` + `text/plain` in one `ClipboardItem` | `navigator.clipboard.write()` | Pasting formatted into Gmail, Google Docs, Word, Notion |
| **Copy as Markdown** | Markdown source only | `text/plain` only | `navigator.clipboard.writeText()` | Pasting raw Markdown into a code editor, a CMS, GitHub, another Markdown app |
| **Export as `.md`** | Markdown source file | `text/markdown;charset=utf-8` | `Blob` + object URL + synthetic `<a download>` | Saving the canonical source to disk |
| **Export as rich text (`.html`)** | Self-contained HTML file | `text/html;charset=utf-8` | `Blob` + object URL + synthetic `<a download>` | Opening in Word / Pages / Docs / LibreOffice with formatting intact |

All four are reachable from the command palette and from explicit buttons regardless of the current pane's mode (§8, [`13-keyboard-commands.md`](./13-keyboard-commands.md)).

---

## 2. Copy as rich text (HTML + plain text in one `ClipboardItem`)

**Goal:** one copy action that pastes *formatted* into rich targets (Gmail, Docs, Word) **and** pastes *plain* into code/text targets — without the user choosing in advance. The async Clipboard API supports exactly this: a single `ClipboardItem` can carry **multiple representations of the same content**, and the paste target picks the representation it understands. A rich editor reads `text/html`; a plain text field reads `text/plain`.

So *Copy as rich text* writes **one `ClipboardItem` carrying both `text/html` and `text/plain`**, each wrapped in a `Blob`.

References: [MDN `Clipboard.write()`](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write), [MDN `ClipboardItem`](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem), [web.dev — Unblocking clipboard access](https://web.dev/articles/async-clipboard).

### 2.1 Critical pitfalls (read before writing the code)

These are not stylistic preferences; each one is a concrete failure that ships broken if ignored.

1. **Chrome rejects raw strings for non-text MIME types — always wrap in `Blob`.** `new ClipboardItem({ "text/html": htmlString })` throws in Chromium. The value for each type must be a `Blob` (or a `Promise<Blob>`, see pitfall 2), e.g. `new Blob([htmlString], { type: "text/html" })`. (Safari is more permissive about raw strings, but wrapping in `Blob` is the only form that works everywhere — write it the strict way always.)

2. **Safari loses transient activation if you `await` async work *before* `write()`.** Safari/WebKit requires that `navigator.clipboard.write()` is invoked **synchronously inside the user gesture** (the click/keypress handler). If you do `const html = await buildHtml(); await navigator.clipboard.write(...)`, the `await buildHtml()` consumes the transient activation and Safari rejects the subsequent `write()` with `NotAllowedError`. The fix is the **Promise-in-`ClipboardItem`** pattern: call `navigator.clipboard.write()` synchronously and pass a *`Promise<Blob>`* as the value, so the async generation happens *after* the gesture has been registered. Chromium also supports `Promise<Blob>` values, so this single pattern is safe everywhere.

3. **Secure context + user gesture are mandatory.** `navigator.clipboard.write()` only works in a secure context (HTTPS, or `localhost` in dev) and only when called from a user-initiated event handler (a button click, a palette action triggered by a keypress). Recto serves over HTTPS in production and `localhost` in dev (**D14**), so the secure-context requirement is satisfied; the gesture requirement is satisfied because copy is always user-triggered. Programmatic copies (e.g. on a timer) will be blocked — and we never attempt them.

4. **Use absolute `https://` URLs in the exported HTML.** When the HTML lands in Gmail or Word, relative URLs (`/images/x.png`, `./diagram.svg`) and `blob:`/`data:`-less relative references resolve against *nothing* in the foreign app and break. The export pipeline must resolve every link/image URL to an absolute `https://` URL. Recto documents are Markdown authored with absolute image/link URLs by convention; the exporter additionally absolutizes any root-relative URL against the app origin during `remark-rehype`. (This is a presentation concern for *foreign paste*; it does not alter the canonical Markdown.)

5. **Feature-detect `ClipboardItem`.** `window.ClipboardItem` and `navigator.clipboard.write` are absent on older/locked-down browsers. Detect them and fall back to *Copy as Markdown* (`writeText`, §3) with a notice, rather than throwing. See §7.

### 2.2 Canonical code (Safari-safe, Promise-in-`ClipboardItem`)

```ts
/**
 * Copy as rich text: ONE ClipboardItem carrying BOTH text/html and text/plain.
 * - Each representation is wrapped in a Blob (pitfall 1).
 * - write() is called SYNCHRONOUSLY in the gesture; the Blobs are produced by
 *   Promises passed INTO the ClipboardItem (pitfall 2 — Safari-safe).
 * - Caller must invoke this directly from a click / palette keypress handler.
 */
export function copyAsRichText(source: ExportSource): Promise<void> {
  // Feature-detect before anything else (pitfall 5).
  if (
    typeof ClipboardItem === "undefined" ||
    !navigator.clipboard?.write
  ) {
    // Degrade to Markdown copy with a notice (see §7).
    return copyAsMarkdown(source).then(() => {
      notifyRichCopyUnsupported();
    });
  }

  // Build Blobs LAZILY inside Promises. Do NOT `await` these before write().
  // remark-rehype + rehype-stringify run inside generateExportHtml (see §6).
  const htmlBlob: Promise<Blob> = generateExportHtml(source.mdast).then(
    (html) => new Blob([html], { type: "text/html" }),
  );

  // text/plain is the raw Markdown source — the sensible plain fallback for
  // code editors and bare text fields. (We do NOT put rendered text here.)
  const textBlob = new Blob([source.markdown], { type: "text/plain" });

  // write() is the FIRST async call in the gesture — transient activation intact.
  return navigator.clipboard
    .write([
      new ClipboardItem({
        "text/html": htmlBlob, // Promise<Blob> — resolved by the browser post-gesture
        "text/plain": textBlob, // Blob — fine to pass eagerly
      }),
    ])
    .catch(handleClipboardError); // NotAllowedError handling — see §7
}
```

> **Why `text/plain` carries Markdown, not stripped prose.** When this item is pasted into a *plain* target (a code editor, a terminal, a YAML field), the most useful plain representation of a Markdown document is its Markdown source, not its tags-removed prose. A user copying "rich text" and pasting into VS Code gets usable Markdown. Rich targets still receive `text/html` and render formatting. This is the single behavior that serves both audiences from one action.

> **One `ClipboardItem`, not two.** Multiple representations of *the same content* belong in **one** `ClipboardItem` with multiple keys. Passing `[new ClipboardItem({"text/html": ...}), new ClipboardItem({"text/plain": ...})]` would describe *two separate clipboard entries*, which is wrong. One item, multiple types.

---

## 3. Copy as Markdown (`text/plain` only)

**Goal:** put the **raw Markdown source** on the clipboard so it pastes verbatim into code editors, CMS source fields, GitHub comments, and other Markdown-aware tools.

Use `navigator.clipboard.writeText(markdown)`. This writes **`text/plain` only**.

```ts
/**
 * Copy as Markdown: the canonical serialized Markdown, plain text ONLY.
 * Safe to call from a gesture; writeText takes a string directly.
 */
export function copyAsMarkdown(source: ExportSource): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error("Clipboard API unavailable"));
  }
  return navigator.clipboard.writeText(source.markdown).catch(handleClipboardError);
}
```

> **Critical: do NOT add a `text/html` representation to this action.** If *Copy as Markdown* also carried `text/html`, a rich target (Gmail, Docs) would prefer the HTML and paste **rendered output** — defeating the entire purpose of "copy the source." *Copy as Markdown* must be `text/plain` and nothing else. The distinction between the two copy actions *is* the presence/absence of `text/html`:
>
> - **Copy as rich text** → `text/html` + `text/plain` (rich targets render; plain targets get Markdown source).
> - **Copy as Markdown** → `text/plain` only (every target gets the literal Markdown source).

Same environment rules apply: **secure context + user gesture** (§2.1, pitfalls 3). `writeText` has no `ClipboardItem`, so the `Blob` and Promise-in-item concerns do not arise — but it is still gated on activation and secure context, and still rejects with `NotAllowedError` if blocked (§7).

---

## 4. Export as `.md`

**Goal:** save the canonical Markdown source to a file on disk.

Build a `Blob` of the Markdown string, create an object URL, click a synthetic `<a download>`, then **revoke the object URL** to avoid a memory leak.

```ts
/**
 * Export as .md — canonical Markdown source to a downloaded file.
 * UTF-8 is declared in the Blob type. No BOM by default.
 */
export function exportMarkdownFile(source: ExportSource): void {
  const blob = new Blob([source.markdown], {
    type: "text/markdown;charset=utf-8",
  });
  triggerDownload(blob, `${safeFilename(source.title)}.md`);
}

/** Shared download mechanism for both .md and .html exports. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename; // <a download="title.md"> — hints the save filename
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke AFTER the click has been dispatched. revokeObjectURL frees the blob;
  // skipping this leaks the blob for the lifetime of the document (a real leak).
  URL.revokeObjectURL(url);
}

/** Derive a filesystem-safe filename from documents.title. */
function safeFilename(title: string): string {
  const trimmed = title.trim();
  const cleaned = trimmed
    .replace(/[\\/:*?"<>|]/g, "-") // strip path/illegal chars
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "untitled";
}
```

Notes:

- **Charset.** The `Blob` type declares `charset=utf-8`. JavaScript strings are UTF-16 internally; the `Blob` constructor encodes the string to **UTF-8 bytes**. Declaring the charset in the MIME type makes the encoding explicit for tools that read it.
- **Optional BOM for legacy Windows tools.** Modern editors read UTF-8 without a byte-order mark. Some *legacy Windows* tools (older Notepad, certain Excel CSV-adjacent importers) misread UTF-8 unless a BOM is present. If such interop is ever needed, prepend the BOM as its own array element: `new Blob(["﻿", source.markdown], { type: "text/markdown;charset=utf-8" })`. **Default is no BOM** — a BOM can confuse Unix tooling and some Markdown parsers. Treat it as an opt-in.
- **Revoke discipline.** `URL.revokeObjectURL(url)` is mandatory. Object URLs are held alive until the document is discarded or they are explicitly revoked; exporting repeatedly without revoking accumulates leaked blobs.
- **No gesture/secure-context constraints** of the clipboard kind apply here — this is an anchor download — but in practice export is also user-triggered.

---

## 5. Export as rich text = `.html` (the recommended rich export)

**Goal — and the recommendation:** the canonical rich export format is **`.html`**. A single self-contained HTML file with inline styles (or one `<style>` block) opens cleanly in Word, Pages, Google Docs, and LibreOffice, and it is generated **directly from the canonical MDAST with zero translation step** (`remark-rehype` → `rehype-stringify`, the same family we use everywhere — **D5**, [`06-markdown-dialect.md`](./06-markdown-dialect.md)). There is no intermediate format and no second parser to drift.

```ts
/**
 * Export as .html — self-contained HTML generated from the canonical MDAST.
 * Reuses generateExportHtml (§6), which is also the source for the
 * text/html representation in Copy as rich text (§2).
 */
export async function exportHtmlFile(source: ExportSource): Promise<void> {
  const html = await generateExportHtml(source.mdast); // full document, with <style>
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  triggerDownload(blob, `${safeFilename(source.title)}.html`);
}
```

Requirements for the exported HTML:

- **Self-contained.** Inline styles or a single `<style>` block in `<head>`. No external stylesheet references — the file must render correctly when opened standalone or imported into a word processor.
- **Absolute `https://` URLs** for every image and link (pitfall 2.1.4) so the file works when opened outside the app.
- **Dialect-faithful.** It renders exactly the supported constructs — CommonMark + GFM tables/task-lists/strikethrough/autolinks + footnotes + frontmatter handling (**D7**, [`06-markdown-dialect.md`](./06-markdown-dialect.md)) — and nothing else. Frontmatter is metadata, not body content; the exporter does not render the raw YAML block into the document body (see [`06-markdown-dialect.md`](./06-markdown-dialect.md) for frontmatter handling).

---

## 6. The export HTML pipeline (`generateExportHtml`)

Both *Copy as rich text* (§2) and *Export as `.html`* (§5) get their HTML from one function, so there is exactly one HTML generator to test and maintain. It is `remark-rehype` → `rehype-stringify` over the canonical MDAST — the same `unified` family as the in-app preview (**D5**), differing only in that it targets *foreign consumers*: it absolutizes URLs and embeds presentation styling instead of relying on the app's stylesheet.

```ts
import { unified } from "unified";
import remarkRehype from "remark-rehype";
import remarkGfm from "remark-gfm"; // tables, task lists, strikethrough, autolinks (D7)
import rehypeStringify from "rehype-stringify";
import type { Root } from "mdast";

/**
 * Canonical MDAST -> self-contained HTML for export & rich-text clipboard.
 * No new parser: remark-rehype consumes the SAME tree the document edits with (D2).
 */
export async function generateExportHtml(mdast: Root): Promise<string> {
  const file = await unified()
    .use(remarkGfm) // GFM nodes -> hast (tables/task-lists/strikethrough/autolinks)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(absolutizeUrls, { origin: APP_ORIGIN }) // pitfall 2.1.4
    .use(rehypeStringify)
    .run(mdastForExport(mdast)); // strips frontmatter node from body; see 06
  return wrapSelfContainedHtml(String(file)); // <!doctype>, <meta charset utf-8>, <style>
}
```

- `wrapSelfContainedHtml` wraps the body fragment in a full document: `<!doctype html>`, `<meta charset="utf-8">`, a single `<style>` block carrying the export typography, and the body.
- This is **not** the preview pipeline. Preview adds `rehype-sanitize` for safe *in-app* display (**D5**); export HTML is for trusted local download / paste into the user's own documents and intentionally carries presentation. Because the input is the user's own canonical document (single-user app, **D12**) and only dialect constructs exist in the tree (**D7**), there is no untrusted-content vector to sanitize against here.

---

## 7. Error handling & user feedback

The dominant failure is **`NotAllowedError`** from the clipboard write. It is raised when:

- the call did not originate from a user gesture (transient activation expired — classically the Safari `await`-before-`write()` mistake, §2.1 pitfall 2);
- the page is not a secure context (not HTTPS / not `localhost`);
- the browser/OS denied clipboard permission.

```ts
/** Single clipboard error handler for write() / writeText(). */
function handleClipboardError(err: unknown): void {
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    // Blocked: no gesture, insecure context, or permission denied.
    toast.error(
      "Couldn't access the clipboard. Make sure Recto is open over https " +
        "and try the copy again from the button or palette.",
    );
    return;
  }
  // Unknown failure — surface generically, never silently swallow.
  toast.error("Copy failed. Try Export instead.");
  console.error("clipboard write failed", err);
}

/** Shown when ClipboardItem / write() is unsupported and we fell back to Markdown. */
function notifyRichCopyUnsupported(): void {
  toast.info("Rich copy isn't supported here — copied as Markdown instead.");
}
```

Feedback rules:

- **Success is quiet but visible.** A brief, non-blocking confirmation (toast / inline pulse) — "Copied as rich text", "Copied as Markdown", "Exported `title.md`". Consistent with the *tool disappears* principle (§4 of [`README.md`](./README.md)): acknowledge, don't interrupt.
- **Failure is honest and actionable.** Never swallow a clipboard rejection. On `NotAllowedError`, tell the user the likely cause (secure context / gesture) and point to *Export* as the reliable alternative.
- **Graceful degradation.** If `ClipboardItem`/`write` is unavailable, *Copy as rich text* falls back to *Copy as Markdown* and says so (§2.2). Export (anchor download) has no such dependency and remains available as the universal escape hatch.

---

## 8. Where these live in the UI / command palette

All four actions are global document commands, exposed in two places, available regardless of the active pane's mode (consistent with §1):

- **Command palette** (`cmdk`, see [`13-keyboard-commands.md`](./13-keyboard-commands.md)) — entries: **Copy as rich text**, **Copy as Markdown**, **Export as `.md`**, **Export as rich text (`.html`)**. Triggered from a keypress, which satisfies the user-gesture requirement (§2.1 pitfall 3).
- **Explicit buttons** — surfaced in the document's action menu / overflow, not as a persistent toolbar (the design avoids persistent chrome — §4 principle 5 of [`README.md`](./README.md)).

The full keymap and palette wiring, including any direct shortcuts, are owned by [`13-keyboard-commands.md`](./13-keyboard-commands.md). Each command handler must be invoked **synchronously from the user gesture** so the clipboard activation is preserved (§2.1); the palette's action dispatch therefore calls these functions directly from the key/click handler rather than after an `await`.

---

## 9. Why we skip `.rtf`

`.rtf` (Rich Text Format) is deliberately **not** offered. Rationale (recorded as an ADR in [`14-tech-decisions.md`](./14-tech-decisions.md)):

| Concern | RTF reality | Consequence for Recto |
|---|---|---|
| **Browser-first generator** | No maintained, browser-targeted RTF generator that consumes MDAST/HTML cleanly | We'd hand-roll an RTF serializer — a custom implementation where a standard path (`.html`) already exists |
| **Encoding** | RTF is fundamentally **8-bit**; non-ASCII characters require `\uNNNN` escape sequences | Our strings are UTF-16; every emoji, smart quote, accented or non-Latin character needs escaping logic — bug-prone for the multilingual prose this tool is built to write |
| **Escaping** | Literal `{`, `}`, and `\` must be backslash-escaped throughout | Another layer of error-prone serialization with no library to lean on |
| **Coverage** | What RTF gives (a portable rich document for word processors) | **`.html` already covers it**, opens cleanly in Word/Pages/Docs/LibreOffice, and is generated with zero custom code from the canonical tree (§5/§6). `.docx` (§10) covers the remainder |

This aligns with the project rule to **prefer battle-tested libraries and language features over custom implementations**: there is no battle-tested browser RTF path, while `.html` is a one-pipeline, zero-translation export we already maintain. `.html` and `.docx` (§10) cover every realistic destination RTF would. See [`14-tech-decisions.md`](./14-tech-decisions.md) for the decision record.

---

## 10. `.docx` export — shipped (2026-07-05, plan 020)

Native `.docx` export **shipped** via [`remark-docx`](https://www.npmjs.com/package/remark-docx) in `lib/export/docx.ts` (`export-docx` action). It compiles the **canonical MDAST directly to WordprocessingML** — real Word footnotes, alignment-aware GFM tables, checkbox task lists — with no HTML round-trip. Frontmatter is stripped from the body (metadata, not content — same rule as §6); `---` renders as a horizontal rule; root-relative link URLs are absolutized (same pitfall as §6); the module is **dynamically imported** so `remark-docx`/`docx` stay out of the main bundle.

> **Superseded pin (2026-07-05):** this section previously pinned the future `.docx` path to `html-to-docx` over the §6 HTML. That pin is superseded: the original `html-to-docx` has been unmaintained since 2023-03, and no HTML-input converter (including the maintained `@turbodocx/html-to-docx` fork) can produce real Word footnotes — HTML carries no footnote semantics, so they degrade to superscript links. `remark-docx` compiles the canonical MDAST directly instead. The old warning against `html-docx-js` (its `altChunk` wrapping opens empty in Google Docs/LibreOffice/Word-for-Mac) remains historically correct and equally moot.

**Known v1 limitation — images.** `remark-docx` only embeds images via a fetch-based plugin that silently drops any image that fails to load (e.g. CORS on storage URLs). Instead of embedding, v1 rewrites each image to a **hyperlink carrying the alt text and the absolute image URL**, so the pointer survives into Word. If embedding becomes a need, fetch blobs via the existing authed session and pass an image resolver to the processor. Code blocks render as plain-text paragraphs (remark-docx default without its syntax-highlight plugin).

---

## 11. Cross-references

- [`README.md`](./README.md) — locked decisions **D1**, **D2**, **D5**, **D7**, **D12**, **D14**; product principles; glossary (*canonical model*, *mode/lens*, *pane*).
- [`06-markdown-dialect.md`](./06-markdown-dialect.md) — the exact supported dialect (CommonMark + GFM + footnotes + YAML frontmatter), serialization/normalization rules, and frontmatter handling that the exporters must honor.
- [`13-keyboard-commands.md`](./13-keyboard-commands.md) — command palette entries and the keymap that invoke these actions (and the gesture-synchronous dispatch requirement).
- [`14-tech-decisions.md`](./14-tech-decisions.md) — the ADR for skipping `.rtf` and the lossless-round-trip rationale behind the single-canonical-model design.
- [`../plan/phase-5-polish-and-export.md`](../plan/phase-5-polish-and-export.md) — the phase that implements everything in this file (clipboard html+plain, copy-as-markdown, export `.md`/`.html`) alongside the command palette and bespoke design pass.

### External references

- MDN — `Clipboard.write()`: <https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write>
- MDN — `ClipboardItem`: <https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem>
- web.dev — Unblocking clipboard access (async Clipboard API): <https://web.dev/articles/async-clipboard>
- npm — `remark-docx` (`.docx` export, §10): <https://www.npmjs.com/package/remark-docx>
- npm — `html-to-docx` (superseded `.docx` pin — historical, see §10): <https://www.npmjs.com/package/html-to-docx>
