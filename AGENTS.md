# Recto — Agent conventions

## UI components (ADR-18)

- **Use shadcn/ui** for all UI. Primitives live in `components/ui/`.
- Add new primitives: `bunx shadcn add <name>`
- Custom UI = compose shadcn primitives (`Card`, `Button`, `Input`, `Alert`, …), not raw HTML + one-off styles.
- shadcn semantic tokens in `app/globals.css` map to Recto OKLCH tokens (`--color-bg-app`, etc.).

## Palette (ADR-20)

- Light + dark: **Twilight** (dark) and **Paper** (light); appearance is `system | light | dark`, default `system`.
- Aurora/Dawn/Moonlit are dark-only and only offered while the appearance resolves to dark.
- The palette source is `packages/design-tokens/tokens.json`. Never hand-edit colours in `app/globals.css` — change the JSON and run `bun run tokens:build` (a test fails if the committed outputs are stale).
- Anything appearance-dependent is a token: `--elevation-*`, `--scrim-opaque`, `--grain-*`, `--color-on-accent`. No raw `oklch(0 0 0 / …)` shadows.

## Canonical markdown

- All MDAST ↔ string crossing in `lib/markdown/` only.
- Round-trip gate: `lib/markdown/corpus.test.ts` (25 cases × 5 assertions).

## Editor modes (Phase 2)

- Four modes: rich (Milkdown), raw/vim (CodeMirror 6), preview (sanitized HTML).
- Switch-on-mode: `flushSync()` → export caret → remount from canonical markdown (`components/studio-shell.tsx`).
- Shared handle API: `lib/editor/handle.ts`. App shortcuts: `lib/keyboard/app-shortcuts.ts` (`⌘K` palette, `Alt+1–4` modes).
- Live two-pane bridge is Phase 3 only — do not port `BridgeCoordinator` / `recreateTransform` yet.

## Sync (D11)

- Editor in a `ref`; never bind live value to `useQuery`.
- Hydrate on open/idle only.
