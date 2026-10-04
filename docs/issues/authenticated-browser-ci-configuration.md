# Browser CI needs a dedicated authenticated test deployment

Status: open; requires the existing deployment and credentials to be identified.

The browser job failed in [CI run 37240160703](https://github.com/bhekanik/recto/actions/runs/37240160703) at source `14e8d02afeb5819510c9e026cd9fa1e3488b041b`. Repository secret names were empty on 2026-10-04; earlier run 36322794155 reports missing `CLERK_JWT_ISSUER_DOMAIN` during startup. Public compile placeholders do not provide an authenticated test environment.

Identify a dedicated existing Clerk/Convex test deployment and its owner, then configure the CI environment with explicit approval for account or credential changes. Run the real browser journeys and remove any remaining dependence on compile-only placeholders for runtime tests. No credentials or account settings were changed during Overflow implementation.
