import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiConsentDialog } from "./ai-consent-dialog";

describe("AiConsentDialog", () => {
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		document.body.innerHTML = "";
	});

	it("renders a consent mutation failure as an alert", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		let root!: Root;
		act(() => {
			root = createRoot(container);
			root.render(
				<AiConsentDialog
					open
					busy={false}
					error="Consent could not be saved."
					onOpenChange={vi.fn()}
					onAccept={vi.fn()}
				/>,
			);
		});

		expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
			"Consent could not be saved.",
		);
		act(() => root.unmount());
	});
});
