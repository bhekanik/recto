# Phase 0 Spikes (throwaway)

This directory holds **throwaway spike code** for Phase 0. It de-risks two mechanisms before product UI:

- **`bridge/`** — Spike A: live two-mode Milkdown ↔ CodeMirror sync
- **`undo-tree/`** — Spike B: undo-tree materialization + patch helpers

Convex functions in `/convex` exercise Spike B against the canon schema subset.

**Decisions** (what carries forward) live in [`docs/blueprint/14-tech-decisions.md`](../docs/blueprint/14-tech-decisions.md) as ADR-15 and ADR-16.

## Run

```bash
bun run dev:bridge    # Spike A harness at http://localhost:5173
bun run test          # All spike tests
bun run typecheck
bun run biome
```

Spike code is quarantined here — Phase 1+ builds the real foundation separately.
