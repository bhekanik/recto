# Recto

Writing studio — canonical Markdown, four lenses, branching undo.

**Live:** [recto-dusky.vercel.app](https://recto-dusky.vercel.app)

**Mac app:** [download the latest release](https://github.com/bhekanik/recto/releases/latest/download/Recto.dmg) (macOS 26 or later, Apple silicon). Releases are built with `apple/scripts/release-mac.sh`.

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
Every push to `main` and every PR also runs the CI gate — `typecheck` + `biome` +
`test` + `build` — via GitHub Actions ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).

### Production env (Convex deployment)

The Convex **production deployment** has its own env, distinct from the Vercel
project env. These must be set there via `bunx convex env set <NAME> <value> --prod`:

- `OPENROUTER_API_KEY` — the daily re-embed sweep (`convex/crons.ts` →
  `embeddings.reindexSweep`) embeds directly from Convex; without it the sweep
  skips silently and "related passages" go stale
- `CLERK_JWT_ISSUER_DOMAIN` — Convex-side JWT verification (`convex/auth.config.ts`)

Check presence with `bunx convex env list --prod` (verified 2026-07-05: both set).
The `embeddings.embeddingHealth` query reports the stale-doc count if the sweep
ever degrades.

## Phase 0 spikes

Throwaway spikes in [`spikes/`](./spikes/) — still runnable:

```bash
bun run dev:bridge   # Spike A harness — http://localhost:5173
```

Blueprint: [`docs/blueprint/README.md`](./docs/blueprint/README.md)  
Plan: [`docs/plan/README.md`](./docs/plan/README.md)

## License

Recto is free software under the [GNU Affero General Public License v3.0](LICENSE): you may use, change and share it, and if you run a modified version for others over a network, you must offer them its source.
