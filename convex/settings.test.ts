import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
	MAX_SETTINGS_BYTES,
	SETTINGS_NOT_OBJECT_MESSAGE,
	SETTINGS_TOO_LARGE_MESSAGE,
} from "./settings";

// Explicit module map for convex-test (mirrors convex/writingStats.test.ts).
// Keys must include a "_generated" path so convex-test can locate the
// function-bundle root (it splits a key on "_generated").
const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./settings.ts": () => import("./settings"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const OWNER = { subject: "owner-user", email: "owner@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

/** Narrow a save result to the success arm so `updatedAt` is a number. */
function savedStamp(result: { saved: boolean; updatedAt: number | null }) {
	expect(result.saved).toBe(true);
	expect(result.updatedAt).not.toBeNull();
	return result.updatedAt as number;
}

describe("settings.get / settings.save", () => {
	it("requires authentication", async () => {
		const t = convexTest(schema, modules);
		await expect(t.query(api.settings.get, {})).rejects.toThrow(
			"Unauthenticated",
		);
		await expect(t.mutation(api.settings.save, { json: "{}" })).rejects.toThrow(
			"Unauthenticated",
		);
	});

	it("returns null before anything is saved", async () => {
		const t = convexTest(schema, modules);
		expect(await t.withIdentity(OWNER).query(api.settings.get, {})).toBeNull();
	});

	it("round-trips the stored object", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		const json = JSON.stringify({ theme: "aurora", lint: true });

		const saved = await owner.mutation(api.settings.save, { json });
		expect(saved.saved).toBe(true);

		const row = await owner.query(api.settings.get, {});
		expect(row?.json).toBe(json);
		expect(row?.updatedAt).toBe(saved.updatedAt);
	});

	it("upserts rather than inserting a second row", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);
		await owner.mutation(api.settings.save, { json: '{"theme":"dawn"}' });
		await owner.mutation(api.settings.save, { json: '{"theme":"moonlit"}' });

		// A second row would make `.unique()` in settings.get throw.
		expect((await owner.query(api.settings.get, {}))?.json).toBe(
			'{"theme":"moonlit"}',
		);
	});

	it("scopes rows per user", async () => {
		const t = convexTest(schema, modules);
		await t
			.withIdentity(OWNER)
			.mutation(api.settings.save, { json: '{"theme":"dawn"}' });

		expect(await t.withIdentity(OTHER).query(api.settings.get, {})).toBeNull();
	});

	it("rejects payloads that are not JSON objects", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		// v.string() accepts every one of these; the handler is what stops them.
		for (const json of ["", "not json", "[]", '"a string"', "42", "null"]) {
			await expect(owner.mutation(api.settings.save, { json })).rejects.toThrow(
				SETTINGS_NOT_OBJECT_MESSAGE,
			);
		}
	});

	it("rejects payloads over the size guard, measured in UTF-8 bytes", async () => {
		const t = convexTest(schema, modules);
		const owner = t.withIdentity(OWNER);

		// Two-byte characters: half as many as MAX_SETTINGS_BYTES, still over it.
		const oversized = JSON.stringify({ note: "é".repeat(MAX_SETTINGS_BYTES) });
		await expect(
			owner.mutation(api.settings.save, { json: oversized }),
		).rejects.toThrow(SETTINGS_TOO_LARGE_MESSAGE);
	});

	describe("compare-and-set", () => {
		it("writes when the expected stamp still matches", async () => {
			const t = convexTest(schema, modules);
			const owner = t.withIdentity(OWNER);
			const first = await owner.mutation(api.settings.save, { json: "{}" });

			const second = await owner.mutation(api.settings.save, {
				json: '{"lint":true}',
				expectedUpdatedAt: savedStamp(first),
			});
			expect(second.saved).toBe(true);
			expect((await owner.query(api.settings.get, {}))?.json).toBe(
				'{"lint":true}',
			);
		});

		it("refuses and hands back the winner when the stamp is stale", async () => {
			const t = convexTest(schema, modules);
			const owner = t.withIdentity(OWNER);
			const first = await owner.mutation(api.settings.save, { json: "{}" });
			await owner.mutation(api.settings.save, { json: '{"from":"device-a"}' });

			const late = await owner.mutation(api.settings.save, {
				json: '{"from":"device-b"}',
				expectedUpdatedAt: savedStamp(first),
			});

			expect(late.saved).toBe(false);
			expect(late).toMatchObject({
				conflict: true,
				json: '{"from":"device-a"}',
			});
			// Nothing was written.
			expect((await owner.query(api.settings.get, {}))?.json).toBe(
				'{"from":"device-a"}',
			);
		});

		it("treats 'expected a row' against no row as a conflict", async () => {
			const t = convexTest(schema, modules);
			const result = await t
				.withIdentity(OWNER)
				.mutation(api.settings.save, { json: "{}", expectedUpdatedAt: 1 });
			expect(result).toMatchObject({
				saved: false,
				conflict: true,
				json: null,
				updatedAt: null,
			});
		});

		it("advances updatedAt on every save so a CAS cannot pass on a stale value", async () => {
			const t = convexTest(schema, modules);
			const owner = t.withIdentity(OWNER);

			// Back-to-back saves can land inside one millisecond; each must still get
			// its own stamp or the second writer's CAS would wrongly succeed.
			const stamps: number[] = [];
			for (let i = 0; i < 5; i += 1) {
				const result = await owner.mutation(api.settings.save, {
					json: JSON.stringify({ i }),
				});
				if (result.saved) stamps.push(result.updatedAt);
			}

			expect(stamps).toHaveLength(5);
			for (let i = 1; i < stamps.length; i += 1) {
				expect(stamps[i]).toBeGreaterThan(stamps[i - 1] as number);
			}
		});
	});
});
