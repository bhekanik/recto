import { afterEach, describe, expect, it, vi } from "vitest";

import { SWITCH_MODE_EVENT } from "@/lib/events";
import { ACTIONS, type ActionId } from "@/lib/keyboard/actions";
import { type ActionMapDeps, createActionMap } from "./action-map";

/**
 * Build a deps object where every callback / setter is a spy, so each test can
 * assert exactly which dependency an action invoked. Overrides let a test flip a
 * gate (isMobile / effectiveAiEnabled / canComment / ownership).
 */
function makeDeps(overrides: Partial<ActionMapDeps> = {}): ActionMapDeps {
	const undo = vi.fn();
	const redo = vi.fn();
	return {
		settings: {
			toggleOutline: vi.fn(),
			toggleAiEnabled: vi.fn(),
			toggleReadingFont: vi.fn(),
			zoomIn: vi.fn(),
			zoomOut: vi.fn(),
			zoomReset: vi.fn(),
			toggleSpellcheck: vi.fn(),
			toggleSmartPaste: vi.fn(),
			toggleTopToolbar: vi.fn(),
			toggleTypewriter: vi.fn(),
			toggleFocusDim: vi.fn(),
			cycleFocusDimScope: vi.fn(),
			togglePreviewVariant: vi.fn(),
			toggleGoalStyle: vi.fn(),
			toggleGoalScope: vi.fn(),
			setTheme: vi.fn(),
			// biome-ignore lint/suspicious/noExplicitAny: a partial settings stub — only the methods the action map calls are exercised
		} as any,
		actions: {
			splitActivePane: vi.fn(),
			closeActivePane: vi.fn(),
			focusNextPane: vi.fn(),
			focusPrevPane: vi.fn(),
			focusDirection: vi.fn(),
			// biome-ignore lint/suspicious/noExplicitAny: a partial actions stub — only the methods the action map calls are exercised
		} as any,
		isMobile: false,
		getActiveMode: () => "rich",
		getController: () =>
			({ undo, redo }) as unknown as ReturnType<ActionMapDeps["getController"]>,
		handleCreate: vi.fn(),
		handleCheckpoint: vi.fn(),
		handleReindex: vi.fn(),
		getExportSource: vi.fn(() => ({ title: "T", markdown: "m" })),
		openFindReplace: vi.fn(),
		summonAiTransform: vi.fn(),
		summonAddComment: vi.fn(),
		effectiveAiEnabled: true,
		activeDocId: "doc1" as ActionMapDeps["activeDocId"],
		activeDocIsOwned: true,
		canComment: true,
		setCommandScope: vi.fn(),
		setCommandOpen: vi.fn(),
		setHistoryPanel: vi.fn(),
		setShareDialogOpen: vi.fn(),
		setReviewOpen: vi.fn(),
		setCommentsOpen: vi.fn(),
		setAiReviewOpen: vi.fn(),
		setRelatedOpen: vi.fn(),
		setStatusVisible: vi.fn(),
		setZen: vi.fn(),
		setGoalConfigOpen: vi.fn(),
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createActionMap", () => {
	it("has a handler for every declared ActionId (single source of truth)", () => {
		const map = createActionMap(makeDeps());
		for (const def of ACTIONS) {
			expect(typeof map[def.id]).toBe("function");
		}
		// And no extra/missing keys beyond the declared action ids.
		const ids = new Set(ACTIONS.map((a) => a.id));
		for (const key of Object.keys(map) as ActionId[]) {
			expect(ids.has(key)).toBe(true);
		}
		expect(Object.keys(map).length).toBe(ACTIONS.length);
	});

	it("routes simple actions to their dependency", () => {
		const deps = makeDeps();
		const map = createActionMap(deps);

		map["new-document"]();
		expect(deps.handleCreate).toHaveBeenCalledTimes(1);

		map.checkpoint();
		expect(deps.handleCheckpoint).toHaveBeenCalledTimes(1);

		map["find-replace"]();
		expect(deps.openFindReplace).toHaveBeenCalledTimes(1);

		map["toggle-outline"]();
		expect(deps.settings.toggleOutline).toHaveBeenCalledTimes(1);

		map["theme-aurora"]();
		expect(deps.settings.setTheme).toHaveBeenCalledWith("aurora");

		map["set-goal"]();
		expect(deps.setGoalConfigOpen).toHaveBeenCalledWith(true);
	});

	it("history actions go through the live controller and panel", () => {
		const undo = vi.fn();
		const redo = vi.fn();
		const deps = makeDeps({
			getController: () =>
				({ undo, redo }) as unknown as ReturnType<
					ActionMapDeps["getController"]
				>,
		});
		const map = createActionMap(deps);

		map.undo();
		expect(undo).toHaveBeenCalledTimes(1);
		map.redo();
		expect(redo).toHaveBeenCalledTimes(1);

		map["undo-tree"]();
		expect(deps.setHistoryPanel).toHaveBeenCalledWith({
			open: true,
			view: "tree",
		});
		map["version-history"]();
		expect(deps.setHistoryPanel).toHaveBeenCalledWith({
			open: true,
			view: "versions",
		});
	});

	it("go-to-heading opens the headings palette scope", () => {
		const deps = makeDeps();
		const map = createActionMap(deps);
		map["go-to-heading"]();
		expect(deps.setCommandScope).toHaveBeenCalledWith("headings");
		expect(deps.setCommandOpen).toHaveBeenCalledWith(true);
	});

	it("mode actions dispatch the SWITCH_MODE_EVENT", () => {
		const map = createActionMap(makeDeps({ getActiveMode: () => "rich" }));
		const seen: string[] = [];
		const onSwitch = (e: Event) => {
			seen.push((e as CustomEvent<{ mode: string }>).detail.mode);
		};
		window.addEventListener(SWITCH_MODE_EVENT, onSwitch);
		try {
			map["mode-raw"]();
			map["cycle-next"](); // rich -> next in the mode ring
			expect(seen[0]).toBe("raw");
			expect(seen.length).toBe(2);
		} finally {
			window.removeEventListener(SWITCH_MODE_EVENT, onSwitch);
		}
	});

	it("splits are no-ops on mobile (guard preserved)", () => {
		const deps = makeDeps({ isMobile: true });
		const map = createActionMap(deps);
		map["split-v"]();
		map["split-h"]();
		expect(deps.actions.splitActivePane).not.toHaveBeenCalled();
	});

	it("splits run when not mobile", () => {
		const deps = makeDeps({ isMobile: false });
		const map = createActionMap(deps);
		map["split-v"]();
		expect(deps.actions.splitActivePane).toHaveBeenCalledWith("vertical");
		map["split-h"]();
		expect(deps.actions.splitActivePane).toHaveBeenCalledWith("horizontal");
	});

	it("AI actions are gated behind effectiveAiEnabled", () => {
		const off = makeDeps({ effectiveAiEnabled: false });
		const offMap = createActionMap(off);
		offMap["ai-transform"]();
		offMap["ai-critique"]();
		offMap["ai-related"]();
		offMap["ai-reindex"]();
		expect(off.summonAiTransform).not.toHaveBeenCalled();
		expect(off.setAiReviewOpen).not.toHaveBeenCalled();
		expect(off.setRelatedOpen).not.toHaveBeenCalled();
		expect(off.handleReindex).not.toHaveBeenCalled();

		const on = makeDeps({ effectiveAiEnabled: true });
		const onMap = createActionMap(on);
		onMap["ai-transform"]();
		onMap["ai-critique"]();
		onMap["ai-related"]();
		onMap["ai-reindex"]();
		expect(on.summonAiTransform).toHaveBeenCalledTimes(1);
		expect(on.setAiReviewOpen).toHaveBeenCalledWith(true);
		expect(on.setRelatedOpen).toHaveBeenCalledWith(true);
		expect(on.handleReindex).toHaveBeenCalledTimes(1);
	});

	it("comment actions are gated behind canComment", () => {
		const off = makeDeps({ canComment: false });
		const offMap = createActionMap(off);
		offMap["toggle-comments"]();
		offMap["add-comment"]();
		expect(off.setCommentsOpen).not.toHaveBeenCalled();
		expect(off.summonAddComment).not.toHaveBeenCalled();

		const on = makeDeps({ canComment: true });
		const onMap = createActionMap(on);
		onMap["toggle-comments"]();
		onMap["add-comment"]();
		expect(on.setCommentsOpen).toHaveBeenCalledTimes(1);
		expect(on.summonAddComment).toHaveBeenCalledTimes(1);
	});

	it("sharing/review actions require an owned active doc", () => {
		const notOwned = makeDeps({ activeDocIsOwned: false });
		const notOwnedMap = createActionMap(notOwned);
		notOwnedMap["manage-sharing"]();
		notOwnedMap["review-surface"]();
		expect(notOwned.setShareDialogOpen).not.toHaveBeenCalled();
		expect(notOwned.setReviewOpen).not.toHaveBeenCalled();

		const noDoc = makeDeps({ activeDocId: null });
		const noDocMap = createActionMap(noDoc);
		noDocMap["manage-sharing"]();
		expect(noDoc.setShareDialogOpen).not.toHaveBeenCalled();

		const owned = makeDeps({
			activeDocIsOwned: true,
			activeDocId: "d" as ActionMapDeps["activeDocId"],
		});
		const ownedMap = createActionMap(owned);
		ownedMap["manage-sharing"]();
		ownedMap["review-surface"]();
		expect(owned.setShareDialogOpen).toHaveBeenCalledWith(true);
		expect(owned.setReviewOpen).toHaveBeenCalledWith(true);
	});

	it("export actions only run when there is an export source", () => {
		const none = makeDeps({ getExportSource: vi.fn(() => null) });
		const noneMap = createActionMap(none);
		// Should not throw and should be harmless no-ops.
		expect(() => {
			noneMap["export-md"]();
			noneMap["export-html"]();
		}).not.toThrow();
	});
});
