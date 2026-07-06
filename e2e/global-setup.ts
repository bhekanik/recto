import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { chromium, type FullConfig } from "@playwright/test";

/**
 * Dedicated e2e identity. The `+clerk_test` suffix marks it as a Clerk test
 * account (no real email delivery on dev instances); sign-in happens through a
 * server-created ticket via `clerk.signIn` — no password, no verification
 * codes. Keeping a separate user also keeps e2e rows in the shared Convex dev
 * deployment away from the real user's documents.
 */
export const E2E_EMAIL = "recto-e2e+clerk_test@example.com";

const here = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_FILE = path.join(here, ".auth", "user.json");

/** Create the e2e user on first run; reuse it afterwards. */
async function ensureE2eUser(): Promise<void> {
	const secretKey = process.env.CLERK_SECRET_KEY;
	if (!secretKey) {
		throw new Error(
			"CLERK_SECRET_KEY is not set — add the dev-instance key to .env.local (local) or the CI env.",
		);
	}
	const client = createClerkClient({ secretKey });
	const existing = await client.users.getUserList({
		emailAddress: [E2E_EMAIL],
	});
	if (existing.data.length > 0) return;
	await client.users.createUser({
		emailAddress: [E2E_EMAIL],
		skipPasswordRequirement: true,
	});
}

/**
 * Runs once in the runner process: fetch a Clerk Testing Token (exported via
 * process.env for the workers), ensure the e2e user exists, sign it in through
 * a real browser, and persist the session as Playwright storage state.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
	// Loads .env.local (dotenv) and sets CLERK_FAPI + CLERK_TESTING_TOKEN.
	await clerkSetup();
	await ensureE2eUser();

	const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";
	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		// /login loads Clerk without requiring a session; clerk.signIn applies
		// the testing token internally and signs in via the ticket strategy.
		await page.goto(`${baseURL}/login`);
		await clerk.signIn({ page, emailAddress: E2E_EMAIL });
		await page.goto(baseURL);
		// Signed-in studio landmark: the shell banner's "Sign out" button renders
		// in every authenticated state (empty workspace, unbound pane, open doc);
		// signed-out visits get client-redirected to /login instead.
		await page
			.getByRole("button", { name: "Sign out" })
			.waitFor({ state: "visible", timeout: 60_000 });
		await page.context().storageState({ path: AUTH_FILE });
	} finally {
		await browser.close();
	}
}
