import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Shared helpers for the e2e smoke specs (plan 021). All flows drive the real
 * UI — palette, switcher, editor — never Convex directly, so the specs cover
 * what a user actually touches.
 */

/** Test docs carry this prefix so leftovers in the dev deployment are identifiable. */
export const E2E_PREFIX = "e2e-";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Land signed-in on the studio (storage state carries the Clerk session). */
export async function gotoStudio(page: Page): Promise<void> {
	// Bot-detection bypass for the FAPI calls clerk-js makes from the browser.
	await setupClerkTestingToken({ page });
	await page.goto("/");
	// Signed-in landmark: the shell banner's "Sign out" button renders in every
	// authenticated state (empty workspace, unbound pane, open document);
	// signed-out visits get client-redirected to /login instead.
	await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
		timeout: 60_000,
	});
}

/** Open the command palette (⌘K / Ctrl+K). */
export async function openPalette(page: Page): Promise<void> {
	await page.keyboard.press("ControlOrMeta+k");
	await expect(
		page.getByRole("dialog", { name: "Command palette" }),
	).toBeVisible();
}

/** Run a palette action by its visible label (e.g. "Toggle typewriter scrolling"). */
export async function runPaletteAction(
	page: Page,
	label: string,
): Promise<void> {
	await openPalette(page);
	const palette = page.getByRole("dialog", { name: "Command palette" });
	await palette.getByPlaceholder("Search commands and documents…").fill(label);
	await palette
		.getByRole("option", { name: new RegExp(`^${escapeRegExp(label)}`) })
		.first()
		.click();
	await expect(palette).toBeHidden();
}

/**
 * Create a fresh document via the palette and give it a title through the
 * document-header field (rich lens). The title reaches the Convex row after
 * the 500 ms sync debounce — cleanup polls the switcher for it.
 */
export async function createDocument(page: Page, title: string): Promise<void> {
	await runPaletteAction(page, "New document");
	const titleField = page.getByLabel("Document title");
	await expect(titleField).toBeVisible({ timeout: 30_000 });
	// The pane's lens mode persists server-side across documents — a previous
	// spec (or run) may have left it on raw/preview, where the rich header is
	// inert and fill() silently no-ops. Always force the rich lens first.
	await switchMode(page, "rich");
	// The pane also seeds asynchronously from the server row shortly after the
	// fields first render — input typed before the seed lands gets clobbered.
	// Fill and require the value to SURVIVE a settle window; retry until the
	// document is actually stable before the caller types anything else.
	await expect(async () => {
		await titleField.fill(title);
		await page.waitForTimeout(800);
		expect(await titleField.inputValue()).toBe(title);
	}).toPass({ timeout: 30_000 });
}

/**
 * Delete this spec's documents through the UI's own delete flow (switcher row
 * action + confirm dialog). Sweeps BOTH the given title and any "Untitled"
 * rows: the title reaches the server on a debounced sync that occasionally
 * races test teardown, so a spec's doc can still be listed as "Untitled".
 * That sweep is safe here — this is the dedicated e2e user's workspace and
 * the suite runs serially, so any Untitled row is residue of this spec or an
 * earlier failed run. Also makes cleanup idempotent across retries.
 */
export async function deleteDocumentByTitle(
	page: Page,
	title: string,
): Promise<void> {
	await page.keyboard.press("Escape");
	await page.keyboard.press("ControlOrMeta+p");
	const switcher = page.getByRole("dialog", { name: "Document switcher" });
	await expect(switcher).toBeVisible();
	const pattern = new RegExp(`^Delete (${escapeRegExp(title)}|Untitled)$`);
	const target = switcher.getByRole("button", { name: pattern }).first();
	// The switcher lists a created doc immediately (optimistic insert), so at
	// least one row must be here; give the first match a moment to render.
	await expect(target).toBeAttached({ timeout: 10_000 });
	for (let i = 0; i < 20 && (await target.count()) > 0; i++) {
		page.once("dialog", (dialog) => void dialog.accept());
		await target.click();
		await page.waitForTimeout(400);
	}
	await page.keyboard.press("Escape");
}

/** Switch the active pane's lens via the palette. */
export async function switchMode(
	page: Page,
	mode: "rich" | "raw" | "preview",
): Promise<void> {
	const label =
		mode === "rich"
			? "Switch to Rich text"
			: mode === "raw"
				? "Switch to Raw Markdown"
				: "Switch to Preview";
	await runPaletteAction(page, label);
}

/** The active CodeMirror content element (raw lens). */
export function cmContent(page: Page) {
	return page.locator(".cm-content").first();
}

/** Focus the raw-lens editor and move the caret to the end of the document. */
export async function focusRawEditorEnd(page: Page): Promise<void> {
	await cmContent(page).click();
	// Select-all + ArrowRight collapses the caret to the document end — works
	// on both mac (Cmd) and linux CI (Ctrl), unlike the Home/End chords.
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.press("ArrowRight");
}
