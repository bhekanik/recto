# Recto — Agent conventions

## UI components (ADR-18)

- **Use shadcn/ui** for all UI. Primitives live in `components/ui/`.
- Add new primitives: `bunx shadcn add <name>`
- Custom UI = compose shadcn primitives (`Card`, `Button`, `Input`, `Alert`, …), not raw HTML + one-off styles.
- shadcn semantic tokens in `app/globals.css` map to Recto OKLCH tokens (`--color-bg-app`, etc.).
- Dark-only (D13). No light theme.

## Canonical markdown

- All MDAST ↔ string crossing in `lib/markdown/` only.

## Sync (D11)

- Editor in a `ref`; never bind live value to `useQuery`.
- Hydrate on open/idle only.
