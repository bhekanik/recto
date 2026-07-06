import { defineConfig } from "@playwright/test";

/**
 * Recto e2e smoke harness (plan 021).
 *
 * Auth: Clerk Testing Tokens via `@clerk/testing` — `e2e/global-setup.ts`
 * fetches a testing token, signs in a dedicated e2e user (created on first
 * run), and saves storage state that every spec reuses. Required env (loaded
 * from `.env.local` by `clerkSetup()`, or set in CI):
 *   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (pk_test_…), CLERK_SECRET_KEY (sk_test_…)
 * plus the Convex dev deployment vars the app itself needs
 * (NEXT_PUBLIC_CONVEX_URL, CONVEX_DEPLOYMENT).
 *
 * Specs write real rows to the shared Convex dev deployment: every spec
 * creates its own document (title prefixed "e2e-") and deletes it via the
 * UI's own delete flow on success, so leftovers are identifiable.
 */
export default defineConfig({
	testDir: "e2e",
	globalSetup: "./e2e/global-setup.ts",
	// The suite drives one signed-in user against one shared dev deployment —
	// serial keeps workspace state (active pane/doc) deterministic.
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: [["list"]],
	timeout: 60_000,
	use: {
		baseURL: "http://localhost:3000",
		storageState: "e2e/.auth/user.json",
		trace: "retain-on-failure",
		viewport: { width: 1440, height: 900 },
	},
	webServer: {
		command: "bun run dev",
		url: "http://localhost:3000",
		reuseExistingServer: true,
		timeout: 180_000,
	},
});
