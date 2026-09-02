import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiReviewState } from "@/lib/ai/use-ai-review";
import { AiReviewPanel } from "./ai-review-panel";

describe("AI review request lifecycle", () => {
	let root: ReturnType<typeof createRoot> | null = null;
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

	afterEach(async () => {
		await act(async () => root?.unmount());
		document.body.replaceChildren();
	});

	it("starts once per open even when review callbacks change", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const run = vi.fn();
		const reset = vi.fn();
		const reconcile = vi.fn();

		function Harness({
			open,
			state,
			documentId,
		}: {
			open: boolean;
			state: AiReviewState;
			documentId: string;
		}) {
			return (
				<AiReviewPanel
					open={open}
					review={{
						state,
						summary: null,
						error:
							state === "outcome-unknown"
								? "Check its status before starting another."
								: null,
						run: async () => run(documentId),
						reset: () => reset(documentId),
						reconcile: async () => reconcile(documentId),
					}}
					onClose={vi.fn()}
					onOpenReview={vi.fn()}
				/>
			);
		}

		root = createRoot(container);
		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness documentId="document-a" open state="loading" />
				</StrictMode>,
			);
		});
		expect(run).toHaveBeenCalledOnce();
		expect(run).toHaveBeenLastCalledWith("document-a");

		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness documentId="document-a" open state="done" />
				</StrictMode>,
			);
		});
		expect(run).toHaveBeenCalledOnce();

		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness documentId="document-b" open state="outcome-unknown" />
				</StrictMode>,
			);
		});
		const checkStatus = Array.from(
			document.querySelectorAll<HTMLButtonElement>("button"),
		).find((button) => button.textContent === "Check status");
		expect(checkStatus).toBeDefined();
		await act(async () => checkStatus?.click());
		expect(reconcile).toHaveBeenCalledOnce();
		expect(reconcile).toHaveBeenLastCalledWith("document-b");
		expect(run).toHaveBeenCalledOnce();

		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness documentId="document-b" open={false} state="idle" />
				</StrictMode>,
			);
		});
		expect(reset).toHaveBeenCalledOnce();
		expect(reset).toHaveBeenLastCalledWith("document-b");

		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness documentId="document-b" open state="loading" />
				</StrictMode>,
			);
		});
		expect(run).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenLastCalledWith("document-b");
	});
});
