export type ToastKind = "info" | "success" | "error";

export type ToastDetail = { id: string; message: string; kind: ToastKind };

/** Emit a transient toast (rendered by <Toaster/>; announced via a live region). */
export function toast(message: string, kind: ToastKind = "info"): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<ToastDetail>("recto:toast", {
			detail: { id: crypto.randomUUID(), message, kind },
		}),
	);
}
