# Recto

Writing studio — canonical Markdown, four lenses, branching undo.

**Live:** [recto-dusky.vercel.app](https://recto-dusky.vercel.app)

## Stack

Next.js 16 + Convex + Clerk auth, with rich (Milkdown), raw/Vim (CodeMirror), and
preview lenses over one canonical Markdown document, debounced cloud sync.

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

First visit: sign in at `/login` (Clerk), then create a document from the empty state.

Env (`.env.local`):

- `NEXT_PUBLIC_CONVEX_URL` / `NEXT_PUBLIC_CONVEX_SITE_URL` (from `convex dev`)
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` (from `clerk env pull`)
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/login`

Convex needs the Clerk issuer to verify JWTs (the `convex` JWT template):
`npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-instance>.clerk.accounts.dev`.

## Deployment

Hosted on Vercel (team **Planetary Escape**), Convex production, Clerk auth.
**Pushing/merging to `main` auto-deploys to production** — Vercel's Git integration
runs the build in [`vercel.json`](./vercel.json), which on production builds runs
`convex deploy` (via `CONVEX_DEPLOY_KEY`) and then `next build`. Production env vars
(Convex URL, Clerk keys, deploy key) live in the Vercel project settings.

## Phase 0 spikes

Throwaway spikes in [`spikes/`](./spikes/) — still runnable:

```bash
bun run dev:bridge   # Spike A harness — http://localhost:5173
```

Blueprint: [`docs/blueprint/README.md`](./docs/blueprint/README.md)  
Plan: [`docs/plan/README.md`](./docs/plan/README.md)
