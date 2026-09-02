import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiReviewState } from "@/lib/ai/use-ai-review";
import { useAiReviewGate } from "@/lib/studio/use-ai-features";
import { AiReviewPanel } from "./ai-review-panel";

describe("AI review feature gate", () => {
	let root: ReturnType<typeof createRoot> | null = null;
	let openReview: (() => void) | null = null;
	const reset = vi.fn();
	const run = vi.fn();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

	afterEach(async () => {
		await act(async () => root?.unmount());
		document.body.replaceChildren();
		openReview = null;
		vi.clearAllMocks();
	});

	function Harness({
		enabled,
		state,
	}: {
		enabled: boolean;
		state: AiReviewState;
	}) {
		const [open, setOpen] = useState(false);
		openReview = () => setOpen(true);
		useAiReviewGate(enabled, reset, () => setOpen(false));

		return enabled ? (
			<AiReviewPanel
				open={open}
				review={{
					state,
					summary: null,
					error: null,
					run: async () => run(),
					reset: vi.fn(),
					reconcile: vi.fn(),
				}}
				onClose={() => setOpen(false)}
				onOpenReview={vi.fn()}
			/>
		) : null;
	}

	it("closes and owns a sent review before the gate can remount", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness enabled state="loading" />
				</StrictMode>,
			);
		});
		await act(async () => openReview?.());
		expect(run).toHaveBeenCalledOnce();

		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness enabled={false} state="outcome-unknown" />
				</StrictMode>,
			);
		});
		expect(reset).toHaveBeenCalledOnce();

		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness enabled state="outcome-unknown" />
				</StrictMode>,
			);
		});
		expect(run).toHaveBeenCalledOnce();
	});
});
