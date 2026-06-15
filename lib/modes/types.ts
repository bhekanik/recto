export type Mode = "rich" | "raw" | "vim" | "preview";

export const MODE_RING: Mode[] = ["rich", "raw", "vim", "preview"];

export type VimSubMode = "normal" | "insert" | "visual";

export type CaretPosition = {
	offset: number;
	anchor: number;
	head: number;
};

export function nextMode(current: Mode): Mode {
	const idx = MODE_RING.indexOf(current);
	return MODE_RING[(idx + 1) % MODE_RING.length] ?? "rich";
}

export function prevMode(current: Mode): Mode {
	const idx = MODE_RING.indexOf(current);
	return MODE_RING[(idx - 1 + MODE_RING.length) % MODE_RING.length] ?? "rich";
}

export function modeToLabel(mode: Mode, vimSubMode?: VimSubMode): string {
	switch (mode) {
		case "rich":
			return "Rich text";
		case "raw":
			return "Raw Markdown";
		case "vim":
			return vimSubMode ? `Vim · ${vimSubMode}` : "Vim";
		case "preview":
			return "Preview";
	}
}
