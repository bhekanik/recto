import { describe, expect, it } from "vitest";
import { AiRequestOwner, sha256Text } from "./request-owner";

describe("AiRequestOwner", () => {
	it("supersedes before delayed digest work can send", async () => {
		const owner = new AiRequestOwner();
		const first = owner.begin("doc-a");
		const digest = sha256Text("draft");
		const second = owner.begin("doc-a");
		await digest;
		expect(owner.isCurrent(first, "doc-a")).toBe(false);
		expect(first.controller.signal.aborted).toBe(true);
		expect(owner.isCurrent(second, "doc-a")).toBe(true);
	});

	it("fences a delayed token after reset", async () => {
		const owner = new AiRequestOwner();
		const ticket = owner.begin("doc-a");
		const token = Promise.resolve("token");
		owner.supersede();
		await token;
		expect(owner.isCurrent(ticket, "doc-a")).toBe(false);
	});

	it("fences a response after the active document changes", () => {
		const owner = new AiRequestOwner();
		const ticket = owner.begin("doc-a");
		expect(owner.isCurrent(ticket, "doc-b")).toBe(false);
	});

	it("distinguishes local cancellation from provider uncertainty", () => {
		const owner = new AiRequestOwner();
		owner.begin("doc-a");
		expect(owner.supersede()).toBe("local");
		const sent = owner.begin("doc-a");
		expect(owner.markSent(sent)).toBe(true);
		expect(owner.supersede()).toBe("sent");
	});

	it("never lets an older ticket mark itself sent", () => {
		const owner = new AiRequestOwner();
		const older = owner.begin("doc-a");
		owner.begin("doc-a");
		expect(owner.markSent(older)).toBe(false);
	});

	it("does not let an old abort supersede a newer request", () => {
		const owner = new AiRequestOwner();
		const old = owner.begin("doc-a");
		const current = owner.begin("doc-a");
		expect(owner.supersedeIfCurrent(old)).toBeNull();
		expect(owner.isCurrent(current, "doc-a")).toBe(true);
	});

	it("retains the request id until the caller records an unresolved send", () => {
		const owner = new AiRequestOwner();
		const ticket = owner.begin("doc-a");
		expect(owner.currentRequestId()).toBe(ticket.requestId);
		owner.markSent(ticket);
		expect(owner.currentRequestId()).toBe(ticket.requestId);
		owner.finish(ticket);
		expect(owner.currentRequestId()).toBeNull();
	});
});
