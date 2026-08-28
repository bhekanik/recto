import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deleteEverything: vi.fn(),
}));

vi.mock("convex/react", () => ({
	useAction: () => mocks.deleteEverything,
}));

import { DeleteAccountDialog } from "./delete-account-dialog";

function Harness({ onDeleted }: { onDeleted: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open delete account
			</button>
			<DeleteAccountDialog
				open={open}
				onOpenChange={setOpen}
				onDeleted={onDeleted}
			/>
		</>
	);
}

function mount(onDeleted = vi.fn()) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	let root!: Root;
	act(() => {
		root = createRoot(container);
		root.render(<Harness onDeleted={onDeleted} />);
	});

	const findButton = (label: string) =>
		[...document.body.querySelectorAll("button")].find((button) =>
			(button.textContent ?? "").includes(label),
		);
	const click = (element: Element | undefined) => {
		if (!element) throw new Error("nothing to click");
		act(() => {
			element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	};

	return {
		findButton,
		click,
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
}

async function settleFocus() {
	await act(
		() =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, 0);
			}),
	);
}

describe("DeleteAccountDialog", () => {
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		document.body.innerHTML = "";
		mocks.deleteEverything.mockReset();
	});

	it("uses alert-dialog semantics and focuses the confirmation field", async () => {
		const view = mount();
		const trigger = view.findButton("Open delete account");
		if (!(trigger instanceof HTMLButtonElement)) throw new Error("no trigger");
		trigger.focus();

		view.click(trigger);
		await settleFocus();

		expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
		expect(document.activeElement).toBe(
			document.querySelector("#delete-account-phrase"),
		);

		view.click(view.findButton("Cancel"));
		await settleFocus();
		expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
		view.unmount();
	});

	it("requires the phrase and cannot be dismissed while deletion is pending", async () => {
		const deletion = Promise.withResolvers<void>();
		mocks.deleteEverything.mockReturnValue(deletion.promise);
		const onDeleted = vi.fn();
		const view = mount(onDeleted);
		view.click(view.findButton("Open delete account"));

		const deleteButton = view.findButton("Delete everything");
		expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
		expect((deleteButton as HTMLButtonElement).disabled).toBe(true);

		const input = document.querySelector("#delete-account-phrase");
		if (!(input instanceof HTMLInputElement)) throw new Error("no input");
		act(() => {
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setValue?.call(input, "delete my account");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect((deleteButton as HTMLButtonElement).disabled).toBe(false);

		view.click(deleteButton);
		expect(mocks.deleteEverything).toHaveBeenCalledWith({});
		expect(view.findButton("Deleting…")).toBe(deleteButton);
		expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
		expect((view.findButton("Cancel") as HTMLButtonElement).disabled).toBe(
			true,
		);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();

		await act(async () => deletion.resolve());
		expect(onDeleted).toHaveBeenCalledTimes(1);
		view.unmount();
	});
});
