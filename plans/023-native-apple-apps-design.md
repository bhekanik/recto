# Plan 023 design companion: Recto for macOS, iPadOS and iPhone

> Design plan for the native apps in `plans/023-native-apple-apps.md`.
> Source of visual truth today: `app/globals.css` (tokens), `docs/blueprint/12-design-system.md`
> (principles), `components/studio-shell.tsx`, `components/status-bar.tsx`,
> `components/workspace/pane-shell.tsx` (layout). Mockups: the design canvas
> linked in §12 (artboards for Mac dark/light, iPad, iPhone, palette,
> onboarding, AI settings).

## 1. Brief

- Product: a private writing studio for newsletters and long-form essays.
  One Markdown document, four lenses (rich, raw, vim, preview), branching
  undo, versions, review comments, AI assist.
- Audience: one writer at a time. Keyboard-first people on Mac; the same
  people on an iPad with a Magic Keyboard; occasional reading, light edits
  and comment replies on iPhone.
- Job of every screen: get out of the way of the sentence being written.
  Chrome exists to be forgotten; safety nets (saved state, undo, word count)
  are never removed (blueprint P6).

## 2. Direction

Carry the web's "dusk editorial" identity into native rather than adopting
a stock SwiftUI look:

- Typography is the UI. Hierarchy by size, weight and ink level, not boxes.
- Luminance is elevation. Four background layers ≈0.035 L apart, hairlines
  at `line`, no drop shadows except panels and the floating format bar.
- One accent (periwinkle) marks the single live thing: the selected palette
  row, the focus ring, the active mode, the synced dot.
- Atmosphere: two soft radial gradients + 2.5% film grain behind the canvas,
  in both appearances. Native: a `Canvas`/`LinearGradient` layer under the
  editor plus a tiled noise image at 2.5% soft-light.
- Liquid Glass (OS 26) only where the system gives it: toolbars, sidebar
  chrome, sheets, the floating mode control. Never behind prose.

Signature element: **the sheet.** The writing surface is a defined sheet
(`bg-surface`, a 1 px top-light hairline, a soft lift) floating on the
atmosphere; in focus mode the chrome fades and the sheet is the only thing
lit. Every screenshot, every platform, the same sheet.

Anti-goals: stock `List` chrome around documents, card grids, coloured
folder icons, badges everywhere, gradients on buttons, emoji.

## 3. Information architecture

```
Library ──── Document ──── Inspectors
  All            Rich          Outline
  Recent         Raw           History (undo tree)
  Shared with me Vim           Versions
  (search)       Preview       Comments
                               Review (branches, diff)
                               AI (transform, review, related, usage)
Settings: Appearance · Writing · Editor · Vim & shortcuts · Sync & storage · AI · Account · About
Command palette (⌘K): every action + documents + headings
```

- Mac: three-column window (sidebar / editor / inspector). Sidebar and
  inspector collapse; focus mode hides both.
- iPad regular width: `NavigationSplitView` with the same three columns;
  inspector as a trailing column, collapsible.
- iPad compact + iPhone: stack. Library → document; inspectors as sheets
  (medium detent) or a pushed screen for History.
- Documents are database-backed (Convex + local mirror). No folders in v1
  (matches the web); search + recents + pins carry navigation.

## 4. Screen specs

### 4.1 Mac window

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ●●●  [⊟] Library ▾            Draft title · Saved ✓        [Rich|Raw|Vim|Prev] [⊞] │  toolbar 52pt, unified, transparent titlebar
├───────────────┬──────────────────────────────────────────────┬───────────┤
│ All documents │                                              │ Outline   │
│ Recent        │            ┌────── measure 66ch ──────┐      │  H1 …     │
│ Shared        │            │  Title (1.7em, 700)      │      │  H2 …     │
│ ────────────  │            │  Subtitle                │      │           │
│ ▸ Doc title   │            │  ─────────────           │      │ History   │
│   2h · 1,204w │            │  Prose 19pt/1.6          │      │  ◉ node   │
│ ▸ Doc title   │            │  …                       │      │  │        │
│               │            │                          │      │  ├─◯      │
│               │            └──────────────────────────┘      │           │
├───────────────┴──────────────────────────────────────────────┴───────────┤
│ Rich text · normal   Sans  100%  Aa  ✓lint  ⌶  ☾   +312 · 🔥4   1,204 words · 6 min · Saved │  status 28pt
└──────────────────────────────────────────────────────────────────────────┘
```

- Window: `NSWindow` with `.fullSizeContentView`, `titlebarAppearsTransparent`,
  min 720×480, default 1180×760, restores frame per document window.
- Toolbar (52 pt unified): sidebar toggle · editable title (`NSTextField`,
  13 pt semibold, becomes the document title) · save state glyph · mode
  segmented control (4 icons, labels on hover) · inspector toggle. No other
  buttons; everything else is menu/palette.
- Sidebar (`NSSplitViewItem.sidebar`, 220–320 pt, source-list style):
  sections All / Recent / Shared with me; rows = title (13 pt, ink-primary)
  + "2h · 1,204 words" (11 pt, ink-tertiary); selected row uses accent wash
  (`accent / 0.15`), not the system blue. Search field at top (⌘⇧F).
- Editor column: the sheet, `bg-surface`, inset 0; prose column centered,
  `max-width: 66ch` of the current prose face, 32 pt horizontal padding,
  48 pt top padding, bottom padding 40% of the viewport height so the last
  line can sit mid-screen.
- Inspector (`NSSplitViewItem.inspector`, 280–420 pt): segmented header
  (Outline / History / Versions / Comments / Review / AI); content on
  `bg-raised`; hairline separator.
- Status bar (28 pt, `bg-raised`, 1 px top hairline, 11 pt SF): left = mode
  + vim sub-mode; right = font toggle (rendered in its own face), zoom,
  spellcheck, lint + count, typewriter, focus dim, session words + streak,
  goal ring, focus mode, word count · reading time · sync state. Values rest
  at ink-tertiary, hover to ink-secondary.
- Focus mode (⇧⌃F): toolbar, sidebar, inspector and status bar fade out
  over 280 ms; pointer movement or ⎋ brings them back; window goes to
  native full screen; typewriter and dim are independent toggles.

### 4.2 Rich lens (native hybrid)

The document is the Markdown string. TextKit 2 renders it with markers
hidden except on the active block, Bear/iA-style:

- Headings: marker `#` hidden, size/weight from the prose scale; when the
  caret enters the heading, the markers reappear at ink-tertiary.
- Emphasis/strong/strike/code: markers hidden; styled text; markers show on
  the active inline run.
- Links: text at accent-2, URL hidden; ⌘-click opens; hover shows URL in a
  tooltip; editing the link uses a popover (title, URL).
- Lists: bullets rendered as glyphs, numbers auto-renumbered visually only
  (the string keeps the user's numbers); task boxes are drawn in the layout
  fragment (no attachment character in the string) and hit-tested to toggle
  `[ ]`/`[x]`.
- Code blocks: full-width block with `bg-raised` background, mono face,
  language tag top-right, markers hidden.
- Tables: overlay views positioned from the fragment frames (TextKit 2
  falls back to TextKit 1 if `NSTextTable` is used); editing a cell edits
  the pipes underneath. Re-evaluate native tables on the iOS 27 SDK.
- Images: `NSTextAttachment` view provider showing the image at column
  width, caption from alt text; drop/paste uploads via the host.
- Footnotes: superscript number; click shows a popover with the definition.
- Frontmatter: shown as the document header (title, subtitle, newsletter
  subject/preview) above the sheet's first hairline, not as YAML.
- Slash menu: typing `/` at line start opens a native popover anchored at
  the caret (same 17 entries as `lib/editor/milkdown/slash-entries.ts`).
- Selection toolbar: Mac = a floating `NSPanel` bar above the selection
  (bold, italic, strike, code, link, AI); iOS = the system edit menu with
  the same items added via `UIMenu`.

### 4.3 Raw and Vim lenses

Same text storage, markers visible, syntax highlighting: markers and
punctuation at ink-tertiary, headings bold, code spans on `bg-raised`,
links underlined at accent-2. Mono face 17.5 pt / 1.6, column 84 ch.
Vim lens adds a modal layer: block caret in normal, bar caret in insert,
selection highlight in visual, `-- INSERT --` in the status bar left slot,
and `:` ex-line rendered inside the status bar.

### 4.4 Preview lens

Read-only rendering from the same string via the prose scale (headings,
lists, tables, footnotes, images), plus the Email variant (subject line,
preheader, inbox preview card) for newsletters. Copy is allowed; caret is
hidden.

### 4.5 iPad

- Regular width: sidebar (260 pt) / editor / inspector (320 pt) columns;
  toolbar mirrors the Mac; iPadOS 26 menu bar from `.commands`.
- Keyboard mode: identical to Mac; ⌘-hold overlay lists shortcuts.
- Touch mode: sidebar collapses to a leading button; mode control moves to
  the toolbar trailing edge as a menu; a native accessory bar above the
  keyboard: Undo, Redo, Bold, Italic, Heading, List, Link, Image, Esc (vim
  only), Dismiss. Typewriter off while the keyboard is up.
- Two panes max side by side (same or different documents), split by a
  draggable hairline with a 44 pt hit target.
- Stage Manager: every size class is valid; below 600 pt width the window
  behaves as compact.

### 4.6 iPhone

- Library: large title "Recto", search, recents; rows with title + meta.
- Document: full-bleed sheet, top bar with back / title / mode menu (Rich,
  Raw, Preview; Vim only with a keyboard); bottom accessory bar as above;
  status collapsed to word count + sync dot in the top bar's subtitle.
- Inspectors as sheets (medium/large detents): Outline, Comments, AI.
  History opens pushed, full height, tree drawn vertically.
- Share sheet for export; Save to Recto share extension for capture.

### 4.7 Command palette

Floating panel (Mac: non-activating `NSPanel`, 560 pt wide, top-third of
the window; iPad: sheet; iPhone: sheet), `bg-overlay`, 16 pt inset, search
field 15 pt, rows 32 pt: icon (SF Symbol, ink-secondary) · label
(ink-primary) · section (ink-tertiary) · shortcut chips (mono 11 pt). The
selected row gets the accent wash; nothing else in the app is periwinkle
while the palette is open.

### 4.8 History inspector

Undo tree drawn with `Canvas`: nodes as 8 pt circles on hairline edges,
current node filled with accent, tagged versions with a small label,
branch points as 10 pt diamonds. Hover/tap shows the node's time and word
count; clicking navigates (additive). Below the tree: the version list
(manual at ink-primary, auto at ink-secondary, timestamps ink-tertiary) and
the diff view (word or line, inline or side-by-side) using `success` /
`danger` washes at 0.16 alpha.

### 4.9 Comments and review

Comments: anchored highlights in the text at `comment-wash`; the inspector
lists threads; reply field at the bottom; resolve is a checkmark; report is
in the row's overflow menu. Review: open branches list with reviewer name
and edit count; branch diff as hunks with Accept / Reject per hunk (server
authoritative); "Accept all" in the header.

### 4.10 AI surfaces

- Transform: select text → AI in the format bar or ⇧⌃I → prompt field in a
  small popover ("Tighten", "Simplify", custom) → streamed result shown as
  an inline pending replacement (accent wash) with Keep / Discard; Keep
  commits one undo node.
- Review: inspector tab; runs on the document; results become anchored
  comments and a suggestion branch.
- Related passages: inspector list of your own earlier drafts with
  excerpts.
- Usage: Settings › AI shows today's and this month's spend, key source,
  and a bar per kind. When no key and no entitlement: an empty state
  explaining BYOK with "Add OpenRouter key" (paste or Connect via
  OpenRouter), no purchase language.
- Consent: a sheet on first enable, 3 short paragraphs (what is sent, to
  whom, tracing), Decline / Allow.

### 4.11 Onboarding and sign-in

First launch: the sheet with a bundled sample document already open,
cursor blinking, a slim card at the bottom: "Write locally" / "Sign in to
sync". Sign-in: native `AuthView` from ClerkKitUI restyled to tokens; Sign
in with Apple, Google, passkey, email. No permission prompts.

## 5. Tokens mapped to native

| Token | Swift name | Dark | Light |
|---|---|---|---|
| bg-app | `Color.rectoCanvas` | oklch(0.18 0.028 280) | oklch(0.975 0.008 85) |
| bg-surface | `.rectoSheet` | oklch(0.215 0.03 281) | oklch(0.99 0.006 85) |
| bg-raised | `.rectoRaised` | oklch(0.255 0.032 282) | oklch(0.955 0.01 85) |
| bg-overlay | `.rectoOverlay` | oklch(0.285 0.034 282) | oklch(0.93 0.012 85) |
| ink-primary/secondary/tertiary | `.rectoInk`, `.rectoInk2`, `.rectoInk3` | 0.94 / 0.79 / 0.665 | 0.22 / 0.42 / 0.55 |
| line / line-strong | `.rectoLine`, `.rectoLineStrong` | 0.33 / 0.45 | 0.88 / 0.78 |
| accent / muted / wash | `.rectoAccent`… | oklch(0.74 0.13 288) | oklch(0.52 0.15 288) |
| accent-2 | `.rectoAccent2` | oklch(0.78 0.1 250) | oklch(0.5 0.12 250) |
| success / warning / danger | `.rectoOk`… | as web | darkened |
| comment / wash | `.rectoComment`… | oklch(0.82 0.09 195) | oklch(0.55 0.1 195) |
| selection | `.rectoSelection` | accent / 0.26 | accent / 0.18 |
| caret | `.rectoCaret` | oklch(0.92 0.04 285) | accent |

Generated from `packages/design-tokens/tokens.json` into `Colors.xcassets`
(light/dark variants) and `RectoTokens.swift`. Palettes (Twilight, Aurora,
Dawn, Moonlit) become named asset groups; appearance is the system
light/dark axis.

Type: chrome = SF Pro (Mac 13/11 pt; iOS text styles). Prose default =
Source Serif 4 19 pt / 1.6 (Figtree option), raw/vim = JetBrains Mono
17.5 pt / 1.6; scale 0.8–2.0. Headings in prose 1.7/1.42/1.22/1.08/1/1 em
at 700, tracking -0.015 em. Spacing 4 pt grid (4 8 12 16 24 32 48 64).
Radii 4/6/8 pt. Motion 80/140/200/280 ms with the web's easings; typing
never animates; Reduce Motion drops transforms.

## 6. Iconography (SF Symbols)

Rich `textformat` · Raw `chevron.left.forwardslash.chevron.right` · Vim
`keyboard` · Preview `eye` · Library `sidebar.leading` · Inspector
`sidebar.trailing` · Outline `list.bullet.indent` · History
`arrow.triangle.branch` · Versions `tag` · Comments `text.bubble` · Review
`checkmark.rectangle.stack` · AI `sparkles` · Focus `moon.stars` ·
Typewriter `text.insert` · Dim `circle.lefthalf.filled` · Goal `target` ·
Streak `flame` · Share `square.and.arrow.up` · Export `arrow.down.doc` ·
Sync ok `checkmark.circle` · unsynced `exclamationmark.triangle`. One
weight (regular), one size per context; never coloured except the sync dot.

## 7. States

| State | Treatment |
|---|---|
| Empty library | Sheet with "Start writing." (display serif, ink-secondary), one button |
| Empty document | Placeholder "Untitled" title, blinking caret, no hint text |
| Loading | Skeleton lines on the sheet, no spinner |
| Saving / Saved / Unsynced / Offline | Status bar text + dot: tertiary pulse / success check / warning label / warning label; never modal |
| Conflict | Sheet: "This document changed on another device" with side-by-side compare, Keep this / Keep other / Merge |
| Vim modes | Status left slot: `Vim · normal` / `-- INSERT --` / `-- VISUAL --`; caret shape changes |
| Keyboard connected/disconnected (iPad) | Toast "Vim paused" / "Vim resumed"; accessory bar appears/disappears |
| AI: no key | Inspector empty state with BYOK actions; no purchase CTA |
| AI: running | Inline shimmer at the selection; Cancel |
| Reviewer mode | Banner "Reviewing Ada's draft · suggester" at the top of the sheet; editing creates a branch |

## 8. Interaction

- Keyboard: the full map from plan 023 §6; Mac menus carry every chord;
  iPad `UIKeyCommand` with discoverability titles; ⌘-hold overlay.
- Touch: swipe back, long-press context menus on documents and comments,
  pull-down search in the library, drag documents to Finder/Files to
  export, drop images/text into the sheet.
- Pointer (iPad): I-beam over prose, hover on rows, resize cursors on the
  pane divider.
- Haptics: selection change in the mode control, task toggle, and when a
  version is saved. Nothing else.

## 9. Accessibility

Dynamic Type for all chrome; prose scale independent. VoiceOver: status
bar is a live region reading "Saved" / "Unsynced"; mode control announces
lens and vim sub-mode; history nodes have labels with time and words.
Contrast: body ≥ 7:1, secondary ≥ 4.5:1, focus ≥ 3:1 in both appearances,
verified numerically in the token pipeline. Reduce Transparency removes
glass and scrims' blur; Increase Contrast raises `line` one step. Full
Keyboard Access reaches every control.

## 10. App icon and store page

Icon: the folded-leg "R" (plan 023 D-N11), Icon Composer layers
background / R / flap; Default (Twilight), Dark (deeper indigo), Mono
(paper on charcoal). App Store screenshots, one story in five frames: the
sheet on Mac in dark (hero), the same document in light on iPad with the
keyboard, the four lenses as a strip, the undo tree, focus mode on iPhone.
Copy on frames in Source Serif 4, one line each: "One document, four
lenses." · "Undo is a tree." · "Write in the dark or on paper." · "Vim,
when you have a keyboard." · "Never lose a word."

## 11. Design tasks in the roadmap

- N1: token pipeline (Style Dictionary), Paper light palette, contrast
  check script.
- N4/N5: Mac window, sidebar, toolbar, status bar, palette, inspectors;
  focus mode; empty/loading states.
- N4: rich-lens rendering rules (markers, blocks, attachments), raw/vim
  highlighting, preview scale.
- N7/N8: iPad accessory bar, touch mode control, iPhone library and
  document screens, sheets.
- N9: icon in Icon Composer, screenshots, product page copy.

## 12. Mockups

Design canvas "Recto Native Mockups" (static artboards: Mac dark, Mac light
(Paper), focus mode, ⌘K palette, Vim lens, first launch, iPad with keyboard
and two panes, iPhone document, Settings › AI with the BYOK empty state):
https://claude.ai/code/artifact/03b4f86e-ab01-43d2-b3f1-7b74ffe74a07
(private; share from the page). Source artboards to be committed under
`design/canvas/`.

## 13. Open design questions

1. Sidebar always visible on Mac by default, or hidden until ⌘1 (iA style)?
2. Mode control in the toolbar (proposed) vs in the status bar (web today)?
3. Keep the four palettes on native at launch, or Twilight + Paper only?
4. iPhone: allow raw lens at all, or rich + preview only?
