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
		expect(meta).toEqual({
			title: "",
			subtitle: "",
			subject: "",
			preview: "",
		});
		expect(extra).toEqual({});
		expect(body).toContain("## Section");
	});

	it("emits no frontmatter block when meta fields and extra are empty", () => {
		const composed = composeFrontmatter(
			{ title: "", subtitle: "", subject: "", preview: "" },
			BODY,
		);
		expect(composed.startsWith("---")).toBe(false);
		expect(composed).toContain("## Section");
	});

	it("round-trips values through compose → split (identity on meta + body)", () => {
		const meta: DocumentMeta = {
			title: "Recto: a studio",
			subtitle: 'He said "hello" — then left',
			subject: "",
			preview: "",
		};
		const composed = composeFrontmatter(meta, BODY);
		const round = splitFrontmatter(composed);
		expect(round.meta).toEqual(meta);
		expect(round.body.trim()).toBe(
			splitFrontmatter(`---\n---\n${BODY}`).body.trim(),
		);
	});

	it("round-trips newsletter subject + preview as typed strings", () => {
		const meta: DocumentMeta = {
			title: "Issue 12",
			subtitle: "",
			subject: "What I learned shipping every week",
			preview: "A short note on consistency over intensity.",
		};
		const composed = composeFrontmatter(meta, BODY);
		expect(composed).toContain("subject:");
		expect(composed).toContain("preview:");

		const round = splitFrontmatter(composed);
		expect(typeof round.meta.subject).toBe("string");
		expect(typeof round.meta.preview).toBe("string");
		expect(round.meta.subject).toBe(meta.subject);
		expect(round.meta.preview).toBe(meta.preview);
	});

	it("keeps subject/preview typed on meta while unknown keys stay in extra", () => {
		const md = `---\ntitle: T\nsubject: A subject\npreview: A preheader\ntags:\n  - a\n  - b\n---\n\n${BODY}`;
		const split = splitFrontmatter(md);
		expect(split.meta.subject).toBe("A subject");
		expect(split.meta.preview).toBe("A preheader");
		// The unknown key lives in extra, not migrated onto meta.
		expect(split.extra.tags).toEqual(["a", "b"]);
		expect("subject" in split.extra).toBe(false);
		expect("preview" in split.extra).toBe(false);

		const recomposed = composeFrontmatter(split.meta, split.body, split.extra);
		const reSplit = splitFrontmatter(recomposed);
		expect(reSplit.meta.subject).toBe("A subject");
		expect(reSplit.meta.preview).toBe("A preheader");
		expect(reSplit.extra.tags).toEqual(["a", "b"]);
	});

	it("preserves unknown frontmatter keys across a round-trip", () => {
		const md = `---\ntitle: T\nsubtitle: S\ndate: 2026-06-16\ntags:\n  - a\n  - b\n---\n\n${BODY}`;
		const split = splitFrontmatter(md);
		expect(split.extra.date).toBeDefined();
		expect(split.extra.tags).toEqual(["a", "b"]);

		const recomposed = composeFrontmatter(split.meta, split.body, split.extra);
		const reSplit = splitFrontmatter(recomposed);
		expect(reSplit.meta).toEqual({
			title: "T",
			subtitle: "S",
			subject: "",
			preview: "",
		});
		expect(reSplit.extra.tags).toEqual(["a", "b"]);
		expect(String(reSplit.extra.date)).toContain("2026");
	});

	it("compose is idempotent (compose∘split∘compose == compose)", () => {
		const meta: DocumentMeta = {
			title: "Stable",
			subtitle: "Idempotent",
			subject: "A subject line",
			preview: "A preview snippet",
		};
		const once = composeFrontmatter(meta, BODY);
		const split = splitFrontmatter(once);
		const twice = composeFrontmatter(split.meta, split.body, split.extra);
		expect(twice).toBe(once);
	});

	it("handles title-only and subtitle-only documents", () => {
		const titleOnly = composeFrontmatter(
			{ title: "Just a title", subtitle: "", subject: "", preview: "" },
			BODY,
		);
		expect(splitFrontmatter(titleOnly).meta).toEqual({
			title: "Just a title",
			subtitle: "",
			subject: "",
			preview: "",
		});

		const subtitleOnly = composeFrontmatter(
			{ title: "", subtitle: "Just a subtitle", subject: "", preview: "" },
			BODY,
		);
		expect(splitFrontmatter(subtitleOnly).meta).toEqual({
			title: "",
			subtitle: "Just a subtitle",
			subject: "",
			preview: "",
		});
	});
});
