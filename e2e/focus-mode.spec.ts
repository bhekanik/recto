import { expect, type Page, test } from "@playwright/test";
import {
	createDocument,
	deleteDocumentByTitle,
	E2E_PREFIX,
	focusRawEditorEnd,
	gotoStudio,
	runPaletteAction,
	switchMode,
} from "./support/helpers";

const TITLE = `${E2E_PREFIX}typewriter`;

/**
 * Where the caret sits inside the visible editor viewport, as a 0..1 ratio
 * (0 = top edge, 1 = bottom edge). Uses the drawSelection cursor element.
 */
async function caretViewportRatio(page: Page): Promise<number> {
	const cursor = await page.locator(".cm-cursor-primary").boundingBox();
	const pane = await page.locator(".codemirror").first().boundingBox();
	if (!cursor || !pane) throw new Error("cursor or pane not measurable");
	return (cursor.y + cursor.height / 2 - pane.y) / pane.height;
}

async function typeLines(page: Page, from: number, count: number) {
	for (let i = from; i < from + count; i++) {
		await page.keyboard.type(`typewriter smoke line ${i}`);
		await page.keyboard.press("Enter");
	}
}

/**
 * Plan 003 smoke — the typewriter MECHANISM, not the feel (feel stays a human
 * call): with typewriter off, typing at the end of an overflowing document
 * parks the caret near the bottom edge; toggling typewriter on re-centers it
 * and KEEPS it in the vertical center band while typing.
 */
test("typewriter scrolling keeps the caret line vertically centered", async ({
	page,
}) => {
	await gotoStudio(page);
	await createDocument(page, TITLE);
	await switchMode(page, "raw");
	await focusRawEditorEnd(page);

	// Overflow the pane so scrolling has somewhere to go.
	await page.keyboard.press("Enter");
	await typeLines(page, 1, 35);

	// Baseline (typewriter OFF): minimal scroll-into-view leaves the caret in
	// the lower part of the viewport.
	const offRatio = await caretViewportRatio(page);
	expect(offRatio).toBeGreaterThan(0.6);

	await runPaletteAction(page, "Toggle typewriter scrolling");
	// Re-anchor the caret at the document end: the palette round-trip does not
	// reliably restore focus to CodeMirror, and an unfocused editor draws no
	// cursor element to measure. The caret move also triggers the typewriter's
	// recenter, which is what the next assertion verifies.
	await focusRawEditorEnd(page);
	await expect(async () => {
		const ratio = await caretViewportRatio(page);
		expect(ratio).toBeGreaterThan(0.3);
		expect(ratio).toBeLessThan(0.7);
	}).toPass({ timeout: 5_000 });

	// The mechanism under test: while typing at the document end, the caret
	// line stays inside the center band instead of drifting to the bottom.
	for (let i = 36; i <= 40; i++) {
		await page.keyboard.type(`typewriter smoke line ${i}`);
		await page.keyboard.press("Enter");
		await expect(async () => {
			const ratio = await caretViewportRatio(page);
			expect(ratio).toBeGreaterThan(0.3);
			expect(ratio).toBeLessThan(0.7);
		}).toPass({ timeout: 3_000 });
	}

	await deleteDocumentByTitle(page, TITLE);
});
