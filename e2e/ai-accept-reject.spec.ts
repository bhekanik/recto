import { expect, test } from "@playwright/test";
import {
	cmContent,
	createDocument,
	deleteDocumentByTitle,
	E2E_PREFIX,
	focusRawEditorEnd,
	gotoStudio,
	runPaletteAction,
	switchMode,
} from "./support/helpers";

const TITLE = `${E2E_PREFIX}ai-transform`;
// Deliberate typos so "Fix grammar" must produce a different string.
const SENTENCE = "Teh quick brown fox jump over the lazi dog.";

/**
 * Plan 009 smoke — the reversibility promise: select a sentence, run a live
 * "Fix grammar" transform (real OpenRouter call through the app's own route),
 * keep the result, then a single Undo restores the original text.
 *
 * Env requirement: OPENROUTER_API_KEY must be valid in the NEXT process env
 * (.env.local locally, CI secret in CI) — `app/api/ai/transform` proxies
 * OpenRouter server-side and surfaces an error state in the popover without
 * it. When that happens this spec SKIPS rather than mocking the LLM — a smoke
 * test against a mock proves nothing.
 *
 * Harness notes (learned the hard way):
 *  - The app's CodeMirror ships no default keymap, so Home/End are native
 *    no-ops — the selection is made with native Shift+ArrowLeft presses.
 *  - A palette round-trip can collapse the editor selection on focus restore,
 *    so the transform is summoned via its direct chord (Ctrl+Shift+I) with
 *    nothing between selection and summon.
 *  - Keystrokes typed before the undo-tree controller hydrates used to be
 *    dropped rather than recorded as history nodes; plan 022 buffers them, and
 *    the settle wait below now only confirms the precondition.
 */
test("AI transform accept then undo restores the original", async ({
	page,
}) => {
	// Live LLM round-trip — allow well beyond the default spec timeout.
	test.setTimeout(180_000);

	await gotoStudio(page);
	await createDocument(page, TITLE);
	await switchMode(page, "raw");
	await focusRawEditorEnd(page);
	await page.keyboard.press("Enter");
	await page.keyboard.type(SENTENCE);

	// Deterministic precondition for the undo assertion: the typed sentence
	// must exist as an undo-tree node BEFORE the transform commits, or the AI
	// node parents to the empty root and undo restores "" (see product finding
	// in plan 021's report). Verify via the undo-tree panel; if the keystrokes
	// were dropped (controller not yet hydrated), nudge the editor to trigger
	// a fresh record and re-check.
	const historyPanel = page.getByRole("dialog", { name: "Document history" });
	await expect(async () => {
		await page.keyboard.press("Control+Shift+u");
		await expect(historyPanel).toBeVisible();
		const labels = await historyPanel.locator("li").allInnerTexts();
		const committed = labels.some((l) => /Added \d+ chars|Edited/.test(l));
		await historyPanel.getByRole("button", { name: "Close history" }).click();
		await expect(historyPanel).toBeHidden();
		if (!committed) {
			await focusRawEditorEnd(page);
			await page.keyboard.type(" ");
			await page.keyboard.press("Backspace");
			await page.waitForTimeout(900);
			throw new Error("typed sentence not yet committed as an undo node");
		}
	}).toPass({ timeout: 30_000 });

	// AI is opt-in and default-OFF; each test starts from a fresh context, so
	// this toggle deterministically turns it ON.
	await runPaletteAction(page, "Toggle AI features");

	// Select exactly the sentence (caret sits at the document end), then
	// summon the transform with its keyboard chord.
	await focusRawEditorEnd(page);
	for (let i = 0; i < SENTENCE.length; i++) {
		await page.keyboard.press("Shift+ArrowLeft");
	}
	await page.keyboard.press("Control+Shift+i");

	const popover = page.getByRole("dialog", { name: "AI transform" });
	await expect(popover).toBeVisible();
	await popover.getByRole("option", { name: "Fix grammar" }).click();

	// Streaming completes into either a decision (Keep / Reject) or an error.
	const keep = popover.getByRole("button", { name: "Keep" });
	const errorHeading = popover.getByText("AI error");
	await expect(keep.or(errorHeading).first()).toBeVisible({
		timeout: 120_000,
	});
	if (await errorHeading.isVisible()) {
		const message = await popover
			.locator("p")
			.first()
			.textContent()
			.catch(() => null);
		// Cleanup before skipping so no test doc lingers.
		await page.keyboard.press("Escape");
		await deleteDocumentByTitle(page, TITLE);
		test.skip(
			true,
			`AI transform errored — is OPENROUTER_API_KEY set for the app server? (${message ?? "no message"})`,
		);
	}

	await keep.click();
	await expect(popover).toBeHidden();

	// The transform landed in the document and changed the text (accept works).
	await expect(cmContent(page)).not.toContainText(SENTENCE);
	await expect(cmContent(page)).toContainText(/quick brown fox/);

	// One undo restores the original — the transform is a single undo node.
	// This is plan 022's regression assertion: it used to self-skip because the
	// client pointer could lag the AI commit and undo would land an ancestor too
	// far up, usually the empty root.
	await runPaletteAction(page, "Undo");
	await expect(cmContent(page)).toContainText(SENTENCE);

	await deleteDocumentByTitle(page, TITLE);
});
