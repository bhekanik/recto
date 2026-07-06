import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Explicit module map for convex-test (mirrors convex/retention.test.ts).
// Keys must include a "_generated" path so convex-test can locate the
// function-bundle root (it splits a key on "_generated"). Relative imports —
// this file lives inside convex/, and the convex tsconfig (used by
// `convex codegen`) has no "@/*" path alias.
const modules: Record<string, () => Promise<unknown>> = {
	"./schema.ts": () => import("./schema"),
	"./documents.ts": () => import("./documents"),
	"./writingStats.ts": () => import("./writingStats"),
	"./_generated/api.js": () => import("./_generated/api"),
	"./_generated/server.js": () => import("./_generated/server"),
};

const WRITER = { subject: "writer-user", email: "writer@example.com" };
const OTHER = { subject: "other-user", email: "other@example.com" };

describe("plan 002 deferred — writingStats record/list integration", () => {
	it("record keeps the per-day max: a lower later count never shrinks the day", async () => {
		const t = convexTest(schema, modules);
		const writer = t.withIdentity(WRITER);

		await writer.mutation(api.writingStats.record, {
			date: "2026-07-06",
			words: 120,
		});
		// The user deleted text; the flush reports fewer words — monotonic per
		// the schema comment (convex/schema.ts writingStats.words).
		await writer.mutation(api.writingStats.record, {
			date: "2026-07-06",
			words: 40,
		});

		expect(await writer.query(api.writingStats.list, {})).toEqual([
			{ date: "2026-07-06", words: 120 },
		]);

		// A higher count raises the high-water mark.
		await writer.mutation(api.writingStats.record, {
			date: "2026-07-06",
			words: 200,
		});
		expect(await writer.query(api.writingStats.list, {})).toEqual([
			{ date: "2026-07-06", words: 200 },
		]);
	});

	it("record upserts one row per day and always advances updatedAt", async () => {
		const t = convexTest(schema, modules);
		const writer = t.withIdentity(WRITER);

		const first = await writer.mutation(api.writingStats.record, {
			date: "2026-07-06",
			words: 10,
		});
		const second = await writer.mutation(api.writingStats.record, {
			date: "2026-07-06",
			words: 5, // lower — words stay, but the touch still registers
		});
		expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("writingStats")
				.withIndex("by_user_date", (q) =>
					q.eq("userId", WRITER.subject).eq("date", "2026-07-06"),
				)
				.collect();
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.words).toBe(10);
		expect(rows[0]?.updatedAt).toBe(second.updatedAt);
	});

	it("list returns per-day rows for the caller only", async () => {
		const t = convexTest(schema, modules);
		const writer = t.withIdentity(WRITER);
		const other = t.withIdentity(OTHER);

		await writer.mutation(api.writingStats.record, {
			date: "2026-07-05",
			words: 300,
		});
		await writer.mutation(api.writingStats.record, {
			date: "2026-07-06",
			words: 150,
		});
		await other.mutation(api.writingStats.record, {
			date: "2026-07-06",
			words: 999,
		});

		const mine = await writer.query(api.writingStats.list, {});
		expect(mine).toHaveLength(2);
		expect(new Map(mine.map((r) => [r.date, r.words]))).toEqual(
			new Map([
				["2026-07-05", 300],
				["2026-07-06", 150],
			]),
		);

		expect(await other.query(api.writingStats.list, {})).toEqual([
			{ date: "2026-07-06", words: 999 },
		]);
	});

	it("record and list reject unauthenticated callers", async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.writingStats.record, { date: "2026-07-06", words: 1 }),
		).rejects.toThrow();
		await expect(t.query(api.writingStats.list, {})).rejects.toThrow();
	});
});
