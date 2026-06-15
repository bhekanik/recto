import { BridgeCoordinator } from "../bridge/coordinator.ts";

const richPane = document.querySelector<HTMLElement>("#rich-pane");
const rawPane = document.querySelector<HTMLElement>("#raw-pane");
const metricsEl = document.querySelector<HTMLElement>("#metrics");

if (!richPane || !rawPane || !metricsEl) {
	throw new Error("Harness DOM missing");
}

const coordinator = new BridgeCoordinator();

await coordinator.mountRich(richPane);
coordinator.mountRaw(rawPane);

setInterval(() => {
	const { richToRaw, rawToRich } = coordinator.metrics;
	const lastR2R = richToRaw.at(-1);
	const lastR2Rich = rawToRich.at(-1);
	metricsEl.textContent = [
		`bridge version: ${coordinator.bridge.currentVersion}`,
		lastR2R
			? `rich→raw: ${lastR2R.dispatched ? "dispatched" : "no-op"} ${lastR2R.latencyMs.toFixed(1)}ms`
			: "",
		lastR2Rich
			? `raw→rich: ${lastR2Rich.dispatched ? "dispatched" : "no-op"} ${lastR2Rich.latencyMs.toFixed(1)}ms`
			: "",
	]
		.filter(Boolean)
		.join(" · ");
}, 500);
