import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiTransformPopover } from "./ai-transform-popover";

const selection = {
	sourceNodeId: "node-a",
	sourceMarkdown: "selected",
	range: { from: 0, to: 8 },
	selection: "selected",
};

describe("AI transform dialog accessibility", () => {
	let root: ReturnType<typeof createRoot> | null = null;
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

	afterEach(async () => {
		await act(async () => root?.unmount());
		document.body.replaceChildren();
	});

	it("moves focus inside, closes on Escape, and restores prior focus", async () => {
		const trigger = document.createElement("button");
		trigger.textContent = "Open transform";
		const container = document.createElement("div");
		document.body.append(trigger, container);
		trigger.focus();
		const onClose = vi.fn();

		function Harness() {
			const [open, setOpen] = useState(true);
			return (
				<AiTransformPopover
					open={open}
					onOpenChange={(next) => {
						setOpen(next);
						if (!next) onClose();
					}}
					selection={selection}
					state={{
						status: "outcome-unknown",
						partial: "",
						error: "Check status before retrying.",
						awaitingDecision: false,
					}}
					onRun={vi.fn()}
					onAccept={vi.fn()}
					onReject={vi.fn()}
					onCancel={vi.fn()}
					onReconcile={vi.fn()}
				/>
			);
		}

		root = createRoot(container);
		await act(async () => {
			root?.render(<Harness />);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const dialog = document.querySelector<HTMLElement>("[role=dialog]");
		expect(dialog).not.toBeNull();
		expect(dialog?.contains(document.activeElement)).toBe(true);
		const checkStatus = Array.from(
			dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
		).find((button) => button.textContent === "Check status");
		checkStatus?.focus();
		await act(async () => {
			checkStatus?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
			);
		});
		expect(dialog?.contains(document.activeElement)).toBe(true);

		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(onClose).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(trigger);
	});
	it("lists what the suggestion dropped beside Keep and Reject", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<AiTransformPopover
					open
					onOpenChange={vi.fn()}
					selection={{
						...selection,
						selection: "Read [the docs](https://example.com).",
					}}
					state={{
						status: "committed",
						partial: "Read the docs.",
						error: null,
						awaitingDecision: true,
					}}
					onRun={vi.fn()}
					onAccept={vi.fn()}
					onReject={vi.fn()}
					onCancel={vi.fn()}
					onReconcile={vi.fn()}
				/>,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const checks = document.querySelector(
			"[aria-label='Checks on this suggestion']",
		);
		expect(checks?.textContent).toBe("Dropped Markdown: 1 link.");
	});
});
