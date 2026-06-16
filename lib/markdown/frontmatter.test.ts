import { describe, expect, it } from "vitest";

import {
	composeFrontmatter,
	type DocumentMeta,
	splitFrontmatter,
} from "@/lib/markdown/frontmatter";

const BODY = `## Section\n\nA paragraph with **bold** and a list:\n\n- one\n- two\n`;

describe("splitFrontmatter / composeFrontmatter", () => {
	it("splits title + subtitle from frontmatter and strips the block", () => {
		const md = `---\ntitle: A Day in My Life\nsubtitle: What my days look like\n---\n\n${BODY}`;
		const { meta, body } = splitFrontmatter(md);
		expect(meta.title).toBe("A Day in My Life");
		expect(meta.subtitle).toBe("What my days look like");
		expect(body.startsWith("---")).toBe(false);
		expect(body).toContain("## Section");
	});

	it("returns empty meta and untouched body when there is no frontmatter", () => {
		const { meta, body, extra } = splitFrontmatter(BODY);
		expect(meta).toEqual({ title: "", subtitle: "" });
		expect(extra).toEqual({});
		expect(body).toContain("## Section");
	});

	it("emits no frontmatter block when title, subtitle and extra are empty", () => {
		const composed = composeFrontmatter({ title: "", subtitle: "" }, BODY);
		expect(composed.startsWith("---")).toBe(false);
		expect(composed).toContain("## Section");
	});

	it("round-trips values through compose → split (identity on meta + body)", () => {
		const meta: DocumentMeta = {
			title: "Recto: a studio",
			subtitle: 'He said "hello" — then left',
		};
		const composed = composeFrontmatter(meta, BODY);
		const round = splitFrontmatter(composed);
		expect(round.meta).toEqual(meta);
		expect(round.body.trim()).toBe(
			splitFrontmatter(`---\n---\n${BODY}`).body.trim(),
		);
	});

	it("preserves unknown frontmatter keys across a round-trip", () => {
		const md = `---\ntitle: T\nsubtitle: S\ndate: 2026-06-16\ntags:\n  - a\n  - b\n---\n\n${BODY}`;
		const split = splitFrontmatter(md);
		expect(split.extra.date).toBeDefined();
		expect(split.extra.tags).toEqual(["a", "b"]);

		const recomposed = composeFrontmatter(split.meta, split.body, split.extra);
		const reSplit = splitFrontmatter(recomposed);
		expect(reSplit.meta).toEqual({ title: "T", subtitle: "S" });
		expect(reSplit.extra.tags).toEqual(["a", "b"]);
		expect(String(reSplit.extra.date)).toContain("2026");
	});

	it("compose is idempotent (compose∘split∘compose == compose)", () => {
		const meta: DocumentMeta = { title: "Stable", subtitle: "Idempotent" };
		const once = composeFrontmatter(meta, BODY);
		const split = splitFrontmatter(once);
		const twice = composeFrontmatter(split.meta, split.body, split.extra);
		expect(twice).toBe(once);
	});

	it("handles title-only and subtitle-only documents", () => {
		const titleOnly = composeFrontmatter(
			{ title: "Just a title", subtitle: "" },
			BODY,
		);
		expect(splitFrontmatter(titleOnly).meta).toEqual({
			title: "Just a title",
			subtitle: "",
		});

		const subtitleOnly = composeFrontmatter(
			{ title: "", subtitle: "Just a subtitle" },
			BODY,
		);
		expect(splitFrontmatter(subtitleOnly).meta).toEqual({
			title: "",
			subtitle: "Just a subtitle",
		});
	});
});
