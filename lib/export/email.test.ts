import { describe, expect, it } from "vitest";

import { emailInboxModel, generateEmailHtml } from "@/lib/export/email";

const MD = `---
title: Issue 12
subject: What I learned shipping weekly
preview: Consistency over intensity.
---

# Heading

A paragraph with **bold** text.

- one
- two
`;

describe("generateEmailHtml", () => {
	it("inlines styles on elements and emits no <style> block", () => {
		const html = generateEmailHtml(MD);
		expect(html).toContain("style=");
		expect(html).not.toContain("<style");
	});

	it("renders heading, paragraph, and list from markdown", () => {
		const html = generateEmailHtml(MD);
		expect(html).toContain("<h1");
		expect(html).toContain("Heading");
		expect(html).toContain("<p");
		expect(html).toContain("<ul");
		expect(html).toContain("<li");
	});

	it("strips the YAML frontmatter (no metadata leaks into the body)", () => {
		const html = generateEmailHtml(MD);
		expect(html).not.toContain("subject:");
		expect(html).not.toContain("preview:");
		expect(html).not.toContain("What I learned shipping weekly");
	});

	it("absolutizes a root-relative image src to an absolute URL", () => {
		const html = generateEmailHtml("![alt](/images/cover.png)");
		// Resolved against the current origin (jsdom: http://localhost; SSR
		// fallback: https://recto.app) — either way it is no longer root-relative.
		const origin =
			typeof window !== "undefined"
				? window.location.origin
				: "https://recto.app";
		expect(html).toContain(`${origin}/images/cover.png`);
		expect(html).not.toContain('src="/images/cover.png"');
	});
});

describe("emailInboxModel", () => {
	it("uses meta.subject and meta.preview verbatim when present", () => {
		const model = emailInboxModel(MD, "Untitled");
		expect(model.subject).toBe("What I learned shipping weekly");
		expect(model.preview).toBe("Consistency over intensity.");
	});

	it("falls back subject: title → fallbackTitle when subject empty", () => {
		const titleOnly = `---\ntitle: A Title\n---\n\nBody text.\n`;
		expect(emailInboxModel(titleOnly, "Untitled").subject).toBe("A Title");

		const noMeta = "Just body text, no frontmatter.";
		expect(emailInboxModel(noMeta, "Untitled").subject).toBe("Untitled");
	});

	it("derives the preview from the body when meta.preview is empty", () => {
		const md = `---\nsubject: S\n---\n\nThe first sentence of the body becomes the snippet.\n`;
		const model = emailInboxModel(md, "Untitled");
		expect(model.preview).toContain("first sentence of the body");
		expect(model.preview).not.toContain("subject:");
	});

	it("includes the email body HTML", () => {
		const model = emailInboxModel(MD, "Untitled");
		expect(model.bodyHtml).toContain("Heading");
		expect(model.bodyHtml).toContain("style=");
	});
});
