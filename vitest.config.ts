import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
		},
	},
	test: {
		environment: "happy-dom",
		include: ["spikes/**/*.test.ts", "lib/**/*.test.ts"],
		exclude: ["**/*.bun.test.ts"],
		testTimeout: 30_000,
		server: {
			deps: {
				inline: ["convex", "convex-test", "convex/server", "convex/values"],
			},
		},
	},
});
