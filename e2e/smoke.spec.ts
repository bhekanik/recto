import { expect, test } from "@playwright/test";
import { gotoStudio } from "./support/helpers";

/**
 * Harness smoke: the stored Clerk session signs us into the studio and the
 * shell renders (empty state or an open document with the status bar). Guards
 * the auth + boot path every other spec depends on.
 */
test("signs in and lands on the studio", async ({ page }) => {
	await gotoStudio(page);
	// Signed-out visits are client-redirected to /login — staying on "/" with
	// studio chrome visible means the session is live.
	await expect(page).toHaveURL(/\/$/);
});
