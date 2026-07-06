import { expect, test } from "@playwright/test";
import {
	createDocument,
	deleteDocumentByTitle,
	E2E_PREFIX,
	gotoStudio,
	runPaletteAction,
	switchMode,
} from "./support/helpers";

const TITLE = `${E2E_PREFIX}email-preview`;
const SUBJECT = "e2e subject QQ1234";
const PREHEADER = "e2e preheader ZZ5678";
const BODY = "Hello from the e2e inbox body.";

/**
 * Plan 008 smoke: subject + preview text set in the document header (frontmatter)
 * surface in the email/inbox preview variant, and the body renders in the
 * light "client window".
 */
test("email preview renders subject, preheader, and body", async ({ page }) => {
	await gotoStudio(page);
	await createDocument(page, TITLE);

	await page.getByLabel("Newsletter subject line").fill(SUBJECT);
	const previewField = page.getByLabel("Newsletter preview text");
	await previewField.fill(PREHEADER);
	// Enter in a header field commits into the body — then type some content.
	await previewField.press("Enter");
	await page.keyboard.type(BODY);

	await switchMode(page, "preview");
	await runPaletteAction(page, "Toggle email/inbox preview");

	// Scope to the visible preview pane — the raw lens (hidden via opacity/inert)
	// also carries these strings as frontmatter text.
	const preview = page.locator(".recto-preview").first();
	await expect(preview.getByText(SUBJECT)).toBeVisible();
	await expect(preview.getByText(PREHEADER)).toBeVisible();
	await expect(preview.getByText(BODY)).toBeVisible();
	// Inbox chrome: the static placeholder sender row (Recto never sends).
	await expect(preview.getByText("You", { exact: true })).toBeVisible();

	await deleteDocumentByTitle(page, TITLE);
});
