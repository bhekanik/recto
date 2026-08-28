import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BlockedWrite } from "@/lib/history/use-document-history";

import { SyncStatusBar } from "./sync-status-bar";

/**
 * The status bar's own props are noise here — the point is the SYNC wiring, so
 * everything else is inert.
 */
const CHROME = {
	wordCount: 120,
	readingMinutes: 1,
	mode: "rich" as const,
	onModeChange: () => {},
	theme: "twilight" as const,
	onCycleTheme: () => {},
	appearance: "system" as const,
	onCycleAppearance: () => {},
	resolvedAppearance: "dark" as const,
	readingFont: "serif" as const,
	onToggleFont: () => {},
	readingScale: 1,
	onZoomIn: () => {},
	onZoomOut: () => {},
	onZoomReset: () => {},
	canZoomIn: true,
	canZoomOut: true,
	spellcheck: false,
	onToggleSpellcheck: () => {},
	lint: false,
	onToggleLint: () => {},
	lintCount: 0,
	typewriter: false,
	onToggleTypewriter: () => {},
	focusDim: false,
	onToggleFocusDim: () => {},
	focusDimScope: "sentence" as const,
	onCycleDimScope: () => {},
	zen: false,
	onToggleZen: () => {},
	goalStyle: "ring" as const,
	goalProgress: { ratio: 0, met: false, remaining: 0 },
	goalTarget: 0,
	goalLabel: "",
	sessionWords: 0,
	streakDays: 0,
	goalConfigOpen: false,
	onGoalConfigOpenChange: () => {},
	wordGoalTarget: 0,
	onWordGoalTargetChange: () => {},
	dailyGoalTarget: 0,
	onDailyGoalTargetChange: () => {},
	wordGoalKind: "at-least" as const,
	onWordGoalKindChange: () => {},
	goalScope: "document" as const,
	onGoalScopeChange: () => {},
	onGoalStyleChange: () => {},
};

const REFUSED: BlockedWrite = {
	kind: "commit",
	message: "Document exceeds the ~1 MiB size limit",
	terminal: true,
	code: "too_large",
	discards: { commits: 2, aiCommits: 1, pointers: 1, versions: 1 },
};

const STUMBLED: BlockedWrite = {
	kind: "commit",
	message: "Write conflict, please retry",
	terminal: false,
	discards: { commits: 1, aiCommits: 0, pointers: 0, versions: 0 },
};

function mount(sync: {
	syncStatus: "idle" | "saving" | "saved" | "unsynced" | "unresolved";
	hasPendingWrites: boolean;
	blockedWrite: BlockedWrite | null;
	retryBlockedWrite: () => void;
	resolveBlockedWrite: () => void;
}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	let root!: Root;
	act(() => {
		root = createRoot(container);
	});
	act(() => {
		root.render(<SyncStatusBar sync={sync} {...CHROME} />);
	});
	return {
		container,
		/** Anything the writer could click, anywhere (the dialog portals out). */
		buttons: () => [...document.body.querySelectorAll("button")],
		findButton: (label: string) =>
			[...document.body.querySelectorAll("button")].find((b) =>
				(b.textContent ?? "").includes(label),
			),
		click(el: Element | undefined) {
			if (!el) throw new Error("nothing to click");
			act(() => {
				el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
		},
		text: () => document.body.textContent ?? "",
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("SyncStatusBar", () => {
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		document.body.innerHTML = "";
	});

	it("leaves the indicator inert when nothing is stuck", () => {
		const s = mount({
			syncStatus: "saved",
			hasPendingWrites: false,
			blockedWrite: null,
			retryBlockedWrite: () => {},
			resolveBlockedWrite: () => {},
		});
		expect(s.text()).toContain("Saved");
		expect(s.findButton("Saved")).toBeUndefined();
		s.unmount();
	});

	it("makes 'Not synced' actionable and opens the confirmation on it", () => {
		const s = mount({
			syncStatus: "unsynced",
			hasPendingWrites: true,
			blockedWrite: REFUSED,
			retryBlockedWrite: () => {},
			resolveBlockedWrite: () => {},
		});

		// The blocked write, not the autosave's own status, decides the label.
		const control = s.findButton("Not synced");
		expect(control).toBeDefined();
		expect(s.text()).not.toContain(REFUSED.message);

		s.click(control);
		// The server's own words, and the exact work at risk — the two things a
		// one-click discard could not say.
		expect(s.text()).toContain(REFUSED.message);
		expect(s.text()).toContain("2 unsaved edits (1 from AI)");
		expect(s.text()).toContain("1 saved version");
		expect(s.text()).toContain("1 history move");
		s.unmount();
	});

	it("sends Discard to the active document, and offers no Retry for a refusal", () => {
		const onRetry = vi.fn();
		const onDiscard = vi.fn();
		const s = mount({
			syncStatus: "unsynced",
			hasPendingWrites: true,
			blockedWrite: REFUSED,
			retryBlockedWrite: onRetry,
			resolveBlockedWrite: onDiscard,
		});
		s.click(s.findButton("Not synced"));

		// Terminal: re-sending gets the same answer, so it is not offered.
		expect(s.findButton("Try again")).toBeUndefined();
		s.click(s.findButton("Discard and keep my text"));
		expect(onDiscard).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
		s.unmount();
	});

	it("offers Retry first for a failure the server never classified", () => {
		const onRetry = vi.fn();
		const onDiscard = vi.fn();
		const s = mount({
			syncStatus: "unsynced",
			hasPendingWrites: true,
			blockedWrite: STUMBLED,
			retryBlockedWrite: onRetry,
			resolveBlockedWrite: onDiscard,
		});
		s.click(s.findButton("Not synced"));

		expect(s.text()).toContain(STUMBLED.message);
		s.click(s.findButton("Try again"));
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onDiscard).not.toHaveBeenCalled();
		s.unmount();
	});
});
