# Recto — Agent conventions

## Tooling

- Bun is the package manager and script runner: `bun run <script>`, `bunx <pkg>`, never npm/npx.
- `bun run test` runs Vitest plus one `bun test` file (`spikes/undo-tree/tests/convex.bun.test.ts`). Other gates: `bun run typecheck`, `bun run test:e2e`.

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
- **Tailwind colour keys are shared with shadcn.** `app/globals.css` has two `@theme` blocks (the generated palette, then shadcn's `@theme inline`); a key in both silently resolves to the last one. shadcn's accent is namespaced `--color-ui-accent` / `--color-ui-accent-foreground` for exactly this reason — a primitive added by `bunx shadcn add` that uses `bg-accent` or `text-accent-foreground` must be rewritten to `bg-ui-accent` / `text-ui-accent-foreground`, or it will pick up Recto's live accent. Guarded by `packages/design-tokens/tokens.test.ts` and `bun run tokens:cascade`.

## Canonical markdown

- All MDAST ↔ string crossing in `lib/markdown/` only.
- Round-trip gate: `lib/markdown/corpus.test.ts` (cases in `lib/markdown/corpus/`).

## Editor modes

- Four modes (`lib/modes/types.ts`): rich (Milkdown), raw and vim (CodeMirror 6), preview (sanitized HTML).
- Switch-on-mode: export canonical markdown and caret from the outgoing handle → flush history and markdown → remount the new mode from canonical markdown (`switchMode` in `components/workspace/pane-editor.tsx`).
- Shared handle API: `lib/editor/handle.ts`. App shortcuts: `lib/keyboard/app-shortcuts.ts` (`⌘K` palette, `Alt+1–4` modes).
- Live two-pane bridge: `lib/bridge/` (coordinator, `recreateTransform`-based raw → rich propagation).

## Sync (D11)

- Editor in a `ref`; never bind live value to `useQuery`.
- Hydrate on open/idle only.
