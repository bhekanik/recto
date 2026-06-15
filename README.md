# Recto

Writing studio — canonical Markdown, four lenses, branching undo.

## Phase 1 (current)

Production app: Next.js + Convex + Better Auth + one Milkdown editor with debounced cloud sync.

```bash
bun install
bun run dev          # Convex + Next.js — http://localhost:3000

bun run test         # vitest + Phase 0 spike tests
bun run typecheck
bun run biome
```

If `convex dev` asks to link the anonymous deployment, answer **Y** (or run `bun run convex:configure` — see below).

Use `bun run convex:dev` separately only when you need Convex without Next.js.

### Link to your Convex account

Already linked? `.env.local` should have `CONVEX_DEPLOYMENT=dev:…` and `*.convex.cloud` URLs.

To (re)configure:

```bash
bun run convex:configure
```

Dashboard: [dashboard.convex.dev/t/bhekani-khumalo/recto](https://dashboard.convex.dev/t/bhekani-khumalo/recto)

First visit: create an account at `/login`, then create a document from the empty state.

Env (`.env.local` from `convex dev`):

- `NEXT_PUBLIC_CONVEX_URL`
- `NEXT_PUBLIC_CONVEX_SITE_URL`
- `NEXT_PUBLIC_SITE_URL=http://localhost:3000`

## Phase 0 spikes

Throwaway spikes in [`spikes/`](./spikes/) — still runnable:

```bash
bun run dev:bridge   # Spike A harness — http://localhost:5173
```

Blueprint: [`docs/blueprint/README.md`](./docs/blueprint/README.md)  
Plan: [`docs/plan/README.md`](./docs/plan/README.md)
