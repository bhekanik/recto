import { expect, test } from "@playwright/test";
import {
	cmContent,
	createDocument,
	deleteDocumentByTitle,
	E2E_PREFIX,
	focusRawEditorEnd,
	gotoStudio,
	switchMode,
} from "./support/helpers";

const TITLE = `${E2E_PREFIX}image-roundtrip`;

/** 1×1 transparent PNG. */
const PIXEL_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Plan 008 smoke: pasting an image uploads the blob to Convex storage and
 * inserts a canonical `![alt](url)` reference; the preview lens then renders
 * the stored image (naturalWidth > 0 proves the bytes actually round-tripped).
 */
test("image paste uploads to Convex storage and renders in preview", async ({
	page,
}) => {
	await gotoStudio(page);
	await createDocument(page, TITLE);
	await switchMode(page, "raw");
	await focusRawEditorEnd(page);
	await page.keyboard.press("Enter");

	// Playwright cannot put an image on the real OS clipboard, so dispatch a
	// synthetic paste carrying a File — the same event shape the CodeMirror
	// paste handler reads (`clipboardData.items` → image branch).
	await cmContent(page).evaluate((target, b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const file = new File([bytes], "e2e-pixel.png", { type: "image/png" });
		const data = new DataTransfer();
		data.items.add(file);
		target.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData: data,
				bubbles: true,
				cancelable: true,
			}),
		);
	}, PIXEL_PNG_BASE64);

	// Upload is async: the markdown reference appears once the blob is stored
	// and the servable convex.cloud URL resolves.
	await expect(cmContent(page)).toContainText(
		/!\[e2e-pixel\]\(https:\/\/[^)]*convex\.cloud[^)]*\)/,
		{
			timeout: 30_000,
		},
	);

	await switchMode(page, "preview");
	const image = page.locator(".recto-preview img[src*='convex.cloud']").first();
	await expect(image).toBeVisible({ timeout: 15_000 });
	// naturalWidth > 0 ⇔ the browser fetched and decoded real image bytes.
	await expect
		.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
			timeout: 15_000,
		})
		.toBeGreaterThan(0);

	await deleteDocumentByTitle(page, TITLE);
});
